import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
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
  description: "The project's folder on the server, read-only.",
  instructions:
    "Paths are relative to the project folder. Read before you describe a file; you cannot write files yet.",
};

/** A path a script may not read: outside the project folder, or inside Pal's own data. */
export class FileAccessError extends Error {}

/**
 * Read-only tools over the calling conversation's project folder, for Code Mode scripts only. Every path is resolved
 * after following symlinks and must stay inside the folder and outside Pal's data.
 */
export function fileTools(options: {
  /** The project folder of a conversation, or undefined when it has none. */
  readonly root: (conversationId: ConversationId) => Promise<string | undefined>;
  /** Directories no project may read, such as Pal's data root. */
  readonly deny: readonly string[];
}): Extension {
  async function resolve(conversationId: ConversationId, path: string): Promise<{ root: string; target: string }> {
    const configured = await options.root(conversationId);
    if (configured === undefined) throw new FileAccessError("this conversation has no project folder");
    const root = await realpath(configured);
    if (isAbsolute(path)) throw new FileAccessError("use a path relative to the project folder");
    let target;
    try {
      target = await realpath(join(root, path));
    } catch {
      throw new FileAccessError(`${path} does not exist in the project folder`);
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
          const info = await stat(target);
          if (!info.isFile()) throw new FileAccessError(`${args.path} is not a file`);
          const handle = await open(target, "r");
          let bytes: Buffer;
          try {
            bytes = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES));
            await handle.read(bytes, 0, bytes.length, 0);
          } finally {
            await handle.close();
          }
          if (bytes.includes(0)) return text(`${args.path} is a binary file of ${info.size} bytes.`);
          const lines = bytes.toString("utf8").split("\n");
          const first = args.offset ?? 1;
          const shown = lines.slice(first - 1, first - 1 + (args.limit ?? MAX_LINES));
          const cut =
            info.size > MAX_READ_BYTES
              ? `\n[file is ${info.size} bytes; only the first ${MAX_READ_BYTES} were read]`
              : "";
          return text(`${shown.map((line, index) => `${first + index}\t${line}`).join("\n")}${cut}`);
        },
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

function inside(root: string, path: string): boolean {
  const between = relative(root, path);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}
