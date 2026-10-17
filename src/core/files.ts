import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { access, link, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { WorkspaceLocks } from "./execution.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { Type } from "typebox";

const MAX_ENTRIES = 500;
const MAX_READ_BYTES = 256 * 1024;
const MAX_LINES = 2000;
const MAX_VISITED = 5000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".direnv", ".devenv", "result"]);

export const FILES_NAMESPACE: CodemodeNamespace = {
  name: "files",
  prefix: "files_",
  description: "Read and revision-checked text writes in the project folder.",
  instructions:
    "Paths are relative to the project. Read before editing; files_read supplies the full-file sha256 for expectedHash. New files require expectedHash: null. Interrupted writes have unknown outcomes: read again, never blindly retry.",
};

/** A path a script may not read: outside the project folder, or inside Pal's own data. */
export class FileAccessError extends Error {}

/**
 * Scoped tools over the calling conversation's project folder, for Code Mode scripts only. Every path is resolved
 * after following symlinks and must stay inside the folder and outside Pal's data.
 */
export function fileTools(options: {
  /** The project folder of a conversation, or undefined when it has none. */
  readonly root: (conversationId: ConversationId) => Promise<string | undefined>;
  /** Directories no project may read, such as Pal's data root. */
  readonly deny: readonly string[];
  readonly locks?: WorkspaceLocks;
}): Extension {
  const locks = options.locks ?? new WorkspaceLocks();
  async function resolve(
    conversationId: ConversationId,
    path: string,
    missing = false,
  ): Promise<{ root: string; target: string }> {
    const configured = await options.root(conversationId);
    if (configured === undefined) throw new FileAccessError("this conversation has no project folder");
    const root = await realpath(configured);
    if (isAbsolute(path)) throw new FileAccessError("use a path relative to the project folder");
    let target;
    try {
      target = await realpath(join(root, path));
    } catch {
      if (!missing) throw new FileAccessError(`${path} does not exist in the project folder`);
      target = join(await realpath(dirname(join(root, path))), basename(path));
    }
    if (!inside(root, target)) throw new FileAccessError(`${path} is outside the project folder`);
    if (blocked(root, target)) throw new FileAccessError(`${path} holds Pal's own files`);
    return { root, target };
  }

  /**
   * Inside a protected directory that is not an ancestor of the project folder. A managed workspace lives under Pal's
   * data, so that directory protects only what is outside the workspace; a home-folder project cannot see Pal's data.
   */
  const blocked = (root: string, path: string) =>
    options.deny.some((denied) => inside(denied, path) && !inside(denied, root));

  const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
  const revision = Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]);
  const mutate = async (
    id: ConversationId,
    path: string,
    expected: string | null,
    change: (before: string) => string,
    signal?: AbortSignal,
  ) => {
    const initial = await resolve(id, path, true);
    return await locks.run(initial.root, async () => {
      const { root, target } = await resolve(id, path, true);
      if (root !== initial.root || relative(root, target).split(sep).includes(".git"))
        throw new FileAccessError("workspace changed or protected Git metadata");
      signal?.throwIfAborted();
      const before = await readFileSnapshot(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (before?.truncated || (before !== undefined && (!isUtf8(before.bytes) || before.bytes.includes(0))))
        throw new FileAccessError("only bounded text files may be changed");
      const digest = before === undefined ? null : hash(before.bytes);
      if (digest !== expected) throw new FileAccessError("file changed; read its latest revision before writing");
      if (before !== undefined) await access(target, constants.W_OK);
      const content = change(before?.bytes.toString("utf8") ?? "");
      if (Buffer.byteLength(content) > MAX_READ_BYTES) throw new FileAccessError("text writes are limited to 256 KiB");
      const temporary = join(dirname(target), `.pal-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", before?.mode ?? 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        signal?.throwIfAborted();
        const latest = await readFileSnapshot(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (latest?.truncated || (latest === undefined ? null : hash(latest.bytes)) !== expected)
          throw new FileAccessError("file changed while preparing the write");
        if (expected === null) await link(temporary, target);
        else await rename(temporary, target);
        const directory = await open(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return {
          ...text(`Wrote ${path}; sha256: ${hash(Buffer.from(content))}`),
          structuredOutput: { sha256: hash(Buffer.from(content)) },
        };
      } finally {
        await handle.close().catch(() => {});
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    });
  };

  return defineExtension({
    name: "pal.files",
    tools: [
      defineTool({
        name: "files_list",
        description: "List a folder in the project: name, kind and size of each entry, folders first.",
        parameters: Type.Object({
          path: Type.Optional(Type.String({ description: "Relative folder; default the project root" })),
        }),
        callers: ["tools"],
        replay: "safe",
        execute: async (args, api) => {
          const { root, target } = await resolve(api.conversationId, args.path ?? ".");
          const entries = await readdir(target, { withFileTypes: true });
          const listed = await Promise.all(
            entries
              .filter((entry) => !blocked(root, join(target, entry.name)))
              .slice(0, MAX_ENTRIES)
              .map(async (entry) => {
                const kind = entry.isDirectory() ? "folder" : entry.isSymbolicLink() ? "link" : "file";
                const size =
                  kind === "file" ? (await stat(join(target, entry.name)).catch(() => undefined))?.size : undefined;
                return {
                  kind,
                  line: `${kind === "folder" ? `${entry.name}/` : entry.name}${size === undefined ? "" : `  ${size} bytes`}`,
                };
              }),
          );
          listed.sort(
            (a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.line.localeCompare(b.line),
          );
          const more = entries.length > MAX_ENTRIES ? `\n[${entries.length - MAX_ENTRIES} more entries not shown]` : "";
          return text(`${listed.map((entry) => entry.line).join("\n") || "(empty folder)"}${more}`);
        },
      }),
      defineTool({
        name: "files_read",
        description: "Read a text file in the project, by lines. Output starts each line with its number.",
        parameters: Type.Object({
          path: Type.String({ description: "Relative file path" }),
          offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line, default 1" })),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_LINES, description: `Lines, default ${MAX_LINES}` }),
          ),
        }),
        callers: ["tools"],
        replay: "safe",
        execute: async (args, api) => {
          const { target } = await resolve(api.conversationId, args.path);
          const { bytes, size, truncated } = await readFileSnapshot(target);
          if (bytes.includes(0) || !isUtf8(bytes)) return text(`${args.path} is a binary file of ${size} bytes.`);
          const lines = bytes.toString("utf8").split("\n");
          const first = args.offset ?? 1;
          const shown = lines.slice(first - 1, first - 1 + (args.limit ?? MAX_LINES));
          const cut = truncated
            ? `\n[file is ${size} bytes; only the first ${MAX_READ_BYTES} were read; not writable]`
            : `\n[sha256: ${hash(bytes)}]`;
          return text(`${shown.map((line, index) => `${first + index}\t${line}`).join("\n")}${cut}`);
        },
      }),
      defineTool({
        name: "files_write",
        description:
          "Create or replace a bounded text file. Read first and pass its expectedHash; null means new file only. Parent folder must exist. Not replayable.",
        parameters: Type.Object({
          path: Type.String({ maxLength: 4096 }),
          content: Type.String({ maxLength: MAX_READ_BYTES }),
          expectedHash: revision,
        }),
        callers: ["tools"],
        replay: "unsafe",
        structuredOutputSchema: Type.Object({ sha256: Type.String() }),
        execute: (args, api, context) =>
          mutate(api.conversationId, args.path, args.expectedHash, () => args.content, context.abortSignal),
      }),
      defineTool({
        name: "files_edit",
        description:
          "Exact non-overlapping replacements against one original file revision. Every oldText must occur once. Read first and pass expectedHash.",
        parameters: Type.Object({
          path: Type.String({ maxLength: 4096 }),
          expectedHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          edits: Type.Array(
            Type.Object({
              oldText: Type.String({ minLength: 1, maxLength: MAX_READ_BYTES }),
              newText: Type.String({ maxLength: MAX_READ_BYTES }),
            }),
            { minItems: 1, maxItems: 50 },
          ),
        }),
        callers: ["tools"],
        replay: "unsafe",
        structuredOutputSchema: Type.Object({ sha256: Type.String() }),
        execute: (args, api, context) =>
          mutate(
            api.conversationId,
            args.path,
            args.expectedHash,
            (before) => {
              const edits = args.edits
                .map((edit) => {
                  const at = before.indexOf(edit.oldText);
                  if (edit.oldText === "" || at < 0 || at !== before.lastIndexOf(edit.oldText))
                    throw new FileAccessError("each oldText must match exactly once");
                  return { ...edit, at };
                })
                .sort((a, b) => a.at - b.at);
              for (let i = 1; i < edits.length; i++) {
                const previous = edits[i - 1],
                  current = edits[i];
                if (
                  previous !== undefined &&
                  current !== undefined &&
                  previous.at + previous.oldText.length > current.at
                )
                  throw new FileAccessError("edits must not overlap");
              }
              let result = before;
              for (const edit of edits.reverse())
                result = result.slice(0, edit.at) + edit.newText + result.slice(edit.at + edit.oldText.length);
              return result;
            },
            context.abortSignal,
          ),
      }),
      defineTool({
        name: "files_find",
        description: "Find files and folders in the project whose path contains the given text (case-insensitive).",
        parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }) }),
        callers: ["tools"],
        replay: "safe",
        execute: async (args, api) => {
          const { root } = await resolve(api.conversationId, ".");
          const needle = args.query.toLowerCase();
          const found: string[] = [];
          const queue = [root];
          let visited = 0;
          while (queue.length > 0 && visited < MAX_VISITED && found.length < MAX_ENTRIES) {
            const folder = queue.shift() as string;
            const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
              visited += 1;
              const path = join(folder, entry.name);
              if (blocked(root, path)) continue;
              const shown = relative(root, path) + (entry.isDirectory() ? sep : "");
              if (shown.toLowerCase().includes(needle)) found.push(shown);
              if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) queue.push(path);
            }
          }
          const partial = visited >= MAX_VISITED ? `\n[stopped after ${MAX_VISITED} entries; narrow the query]` : "";
          return text(`${found.join("\n") || "No matches."}${partial}`);
        },
      }),
    ],
  });
}

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function readFileSnapshot(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FileAccessError("path is not a regular file");
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_READ_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return {
      bytes: buffer.subarray(0, Math.min(length, MAX_READ_BYTES)),
      size: info.size,
      truncated: length > MAX_READ_BYTES || info.size > MAX_READ_BYTES,
      mode: info.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

function inside(root: string, path: string): boolean {
  const between = relative(root, path);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}
