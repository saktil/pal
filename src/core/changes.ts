import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { WorkspaceLocks } from "./execution.ts";
import { FileAccessError, readFileSnapshot, resolveProjectPath } from "./files.ts";
import { HttpError } from "./http.ts";
import type { Projects } from "./projects.ts";

const MAX_FILES = 128;
const MAX_BYTES = 256 * 1024;
const SAFE_GIT = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
];

/** No worktree diff/status: those can execute repository clean filters even with --no-textconv. */
function git(cwd: string, args: string[], signal: AbortSignal, diff = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...SAFE_GIT, ...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: MAX_BYTES,
        timeout: 5000,
        signal,
        env: {
          PATH: process.env.PATH ?? "/run/current-system/sw/bin:/usr/bin:/bin",
          HOME: "/nonexistent",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: "",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_CEILING_DIRECTORIES: dirname(cwd),
        },
      },
      (error, stdout) => {
        if (error !== null && !(diff && error.code === 1))
          reject(new Error("Git read unavailable or exceeds its limits; no hooks, filters or network were allowed"));
        else resolve(stdout);
      },
    );
  });
}

export type Change = {
  path: string;
  status: "A" | "M" | "D";
  patch: string;
  revision: string;
  reviewed: boolean;
  problem?: string;
};
export type ChangeSet = {
  state: "ready" | "unavailable";
  base: string | null;
  files: Change[];
  truncated: boolean;
  note: string;
};
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};

export class Changes {
  readonly #database: SqliteDatabase;
  readonly #projects: Projects;
  readonly #deny: string;
  readonly #locks: WorkspaceLocks;
  #active = 0;
  constructor(database: SqliteDatabase, projects: Projects, dataRoot: string, locks = new WorkspaceLocks()) {
    this.#database = database;
    this.#projects = projects;
    this.#deny = dataRoot;
    this.#locks = locks;
  }

  /** Called before the first Pal mutation as well as on opening the panel; never moves an existing baseline. */
  async capture(root: string): Promise<void> {
    const projects = await this.#database.all<{ id: string }>(
      "SELECT id FROM pal_projects WHERE root = ? AND removed_at IS NULL AND state = 'ready'",
      root,
    );
    for (const { id } of projects) await this.#baseline(id, root);
  }
  async #baseline(id: string, root: string): Promise<{ head: string | null } | undefined> {
    const stored = await this.#database.get<{ head: string | null }>(
      "SELECT head FROM pal_change_bases WHERE project_id = ?",
      id,
    );
    if (stored !== undefined) return stored;
    const signal = AbortSignal.timeout(10_000);
    try {
      const top = (await git(root, ["rev-parse", "--show-toplevel"], signal)).toString().replace(/\r?\n$/, "");
      if ((await realpath(top)) !== root) return undefined;
    } catch {
      return undefined;
    }
    const value = await git(root, ["rev-parse", "--verify", "HEAD"], signal).then(
      (value) => value.toString().trim(),
      () => "",
    );
    const head = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : null;
    await this.#database.run("INSERT OR IGNORE INTO pal_change_bases (project_id, head) VALUES (?, ?)", id, head);
    return await this.#database.get<{ head: string | null }>(
      "SELECT head FROM pal_change_bases WHERE project_id = ?",
      id,
    );
  }
  async list(projectId: string): Promise<ChangeSet> {
    if (this.#active >= 2)
      throw new HttpError(409, "changes_busy", "another change scan is in progress; retry shortly");
    this.#active++;
    try {
      const project = await this.#projects.get(projectId);
      if (project?.state !== "ready") throw new HttpError(404, "not_found", "no such ready project");
      const root = await realpath(project.root);
      const baseline = await this.#baseline(projectId, root);
      const note =
        "Raw text against the recorded Git commit (or empty tree). Includes pre-existing changes; no hooks or filters run. Refresh to see later edits. Discard restores one file, only while it still matches the revision shown.";
      if (baseline === undefined)
        return {
          state: "unavailable",
          base: null,
          files: [],
          truncated: false,
          note: "Git is unavailable or this folder is not a repository root. No baseline or rollback is invented. Use the host terminal to initialize Git explicitly.",
        };
      const signal = AbortSignal.timeout(10_000);
      const tracked =
        baseline.head === null
          ? []
          : (await git(root, ["ls-tree", "-r", "-z", "--name-only", baseline.head], signal))
              .toString()
              .split("\0")
              .filter(Boolean);
      const current = (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], signal))
        .toString()
        .split("\0")
        .filter(Boolean);
      const names = [...new Set([...tracked, ...current])].filter((path) => this.#allowed(root, path)).sort();
      const reviews = await this.#database.all<{ path: string; revision: string }>(
        "SELECT path, revision FROM pal_change_reviews WHERE project_id = ?",
        projectId,
      );
      const files: Change[] = [];
      let budget = 2 * 1024 * 1024;
      let truncated = names.length > MAX_FILES;
      for (const path of names.slice(0, MAX_FILES)) {
        if (signal.aborted) {
          truncated = true;
          break;
        }
        let change;
        try {
          change = await this.#inspect(root, baseline.head, path, tracked.includes(path), signal);
        } catch {
          files.push({
            path,
            status: "M",
            patch: "",
            revision: "",
            reviewed: false,
            problem: "Unavailable: binary, oversized, missing Git object, symlink, or outside the granted folder.",
          });
          continue;
        }
        if (change === undefined) continue;
        budget -= Buffer.byteLength(change.patch);
        if (budget < 0) {
          truncated = true;
          break;
        }
        const { status, patch, revision } = change;
        files.push({
          path,
          status,
          patch,
          revision,
          reviewed: reviews.some((row) => row.path === path && row.revision === revision),
        });
      }
      return { state: "ready", base: baseline.head, files, truncated, note };
    } finally {
      this.#active--;
    }
  }
  /** One file against the baseline, or undefined when its bytes match. Throws when it cannot be shown as text. */
  async #inspect(root: string, head: string | null, path: string, tracked: boolean, signal: AbortSignal) {
    const before = tracked && head !== null ? await git(root, ["cat-file", "blob", `${head}:${path}`], signal) : null;
    let after: Buffer | null = null;
    try {
      const target = join(root, path);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("non-regular file");
      if (!this.#allowed(root, relative(root, await realpath(target)))) throw new Error("outside grant");
      const snapshot = await readFileSnapshot(target);
      if (snapshot.truncated) throw new Error("too large");
      after = snapshot.bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if ((before === null && after === null) || (before !== null && after !== null && before.equals(after)))
      return undefined;
    if (
      (before !== null && (!isUtf8(before) || before.includes(0))) ||
      (after !== null && (!isUtf8(after) || after.includes(0)))
    )
      throw new Error("binary file");
    const temporary = await mkdtemp(join(tmpdir(), "pal-diff-"));
    let patch;
    try {
      for (const [side, content] of [
        ["a", before],
        ["b", after],
      ] as const) {
        if (content === null) continue;
        const target = join(temporary, side, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600 });
      }
      patch = (
        await git(
          temporary,
          [
            "diff",
            "--no-index",
            "--no-prefix",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            before === null ? "/dev/null" : `a/${path}`,
            after === null ? "/dev/null" : `b/${path}`,
          ],
          signal,
          true,
        )
      ).toString();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    const revision = createHash("sha256")
      .update(JSON.stringify([head, path, before?.toString("base64") ?? null, after?.toString("base64") ?? null]))
      .digest("hex");
    const status: Change["status"] = before === null ? "A" : after === null ? "D" : "M";
    return { before, after, status, patch, revision };
  }
  #allowed(root: string, path: string): boolean {
    if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === ".git")) return false;
    const target = join(root, path);
    return within(root, target) && !(within(this.#deny, target) && !within(this.#deny, root));
  }
  async review(projectId: string, path: string, revision: string, reviewed: boolean): Promise<void> {
    const latest = (await this.list(projectId)).files.find((file) => file.path === path);
    if (latest === undefined || latest.problem !== undefined || latest.revision !== revision)
      throw new HttpError(409, "changes_stale", "the file changed; refresh and review its latest revision");
    if (reviewed)
      await this.#database.run(
        "INSERT INTO pal_change_reviews (project_id, path, revision) VALUES (?, ?, ?) ON CONFLICT (project_id, path) DO UPDATE SET revision = excluded.revision",
        projectId,
        path,
        revision,
      );
    else await this.#database.run("DELETE FROM pal_change_reviews WHERE project_id = ? AND path = ?", projectId, path);
  }

  /**
   * Restore one file to the baseline, only if its bytes still match `revision`: an edit, delete or new file since the
   * owner looked fails without touching anything. Held under the workspace lock so Pal's own writes and commands cannot
   * interleave; external editors are rechecked just before the final rename.
   */
  async discard(projectId: string, path: string, revision: string): Promise<void> {
    const project = await this.#projects.get(projectId);
    if (project?.state !== "ready") throw new HttpError(404, "not_found", "no such ready project");
    const root = await realpath(project.root);
    const stale = () =>
      new HttpError(409, "changes_stale", "the file changed since you viewed it; nothing was discarded. Refresh first");
    await this.#locks.run(root, async () => {
      const baseline = await this.#baseline(projectId, root);
      if (!this.#allowed(root, path)) throw new FileAccessError(`${path} is outside the project folder or protected`);
      if (baseline === undefined) throw stale();
      const signal = AbortSignal.timeout(10_000);
      const entry =
        baseline.head === null
          ? ""
          : (await git(root, ["--literal-pathspecs", "ls-tree", "-z", baseline.head, "--", path], signal)).toString();
      const tracked = /^(\d{6}) (\w+) [a-f0-9]+\t([^\0]*)\0$/.exec(entry);
      if (
        entry !== "" &&
        (tracked?.[3] !== path || tracked[2] !== "blob" || !/^100(?:644|755)$/.test(tracked[1] ?? ""))
      )
        throw new HttpError(409, "changes_unsupported", "only regular baseline files can be restored here");
      const change = await this.#inspect(root, baseline.head, path, tracked !== null, signal).catch(() => {
        throw new HttpError(409, "changes_unsupported", "this file cannot be discarded here; use the terminal");
      });
      if (change?.revision !== revision) throw stale();
      // Rechecked right before the change; a link, oversized or unreadable file counts as changed.
      const unchanged = async (target: string) => {
        const now = await readFileSnapshot(target).then(
          (snapshot) => (snapshot.truncated ? undefined : snapshot.bytes),
          (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : undefined),
        );
        return now === null ? change.after === null : now !== undefined && change.after?.equals(now) === true;
      };
      if (change.before === null) {
        const { target } = await resolveProjectPath(root, path, [this.#deny], true);
        if (!(await unchanged(target))) throw stale();
        await unlink(target);
        await syncDirectory(dirname(target));
      } else {
        // A deleted file's folders may be gone too; recreate them one level at a time, never through a symlink.
        let parent = root;
        if (change.after === null)
          for (const part of dirname(path)
            .split(sep)
            .filter((part) => part !== ".")) {
            parent = join(parent, part);
            await mkdir(parent).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
            });
            if (!(await lstat(parent)).isDirectory()) throw new FileAccessError(`${path} is not inside a plain folder`);
          }
        const { target } = await resolveProjectPath(root, path, [this.#deny], true);
        const mode =
          change.after === null ? (tracked?.[1] === "100755" ? 0o755 : 0o644) : (await stat(target)).mode & 0o777;
        const temporary = join(dirname(target), `.pal-${randomUUID()}.tmp`);
        const handle = await open(temporary, "wx", mode);
        try {
          await handle.writeFile(change.before);
          await handle.sync();
          await handle.close();
          if (!(await unchanged(target))) throw stale();
          if (change.after === null)
            await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
              throw error.code === "EEXIST" ? stale() : error;
            });
          else await rename(temporary, target);
          await syncDirectory(dirname(target));
        } finally {
          await handle.close().catch(() => {});
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
      await this.#database.run("DELETE FROM pal_change_reviews WHERE project_id = ? AND path = ?", projectId, path);
    });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
