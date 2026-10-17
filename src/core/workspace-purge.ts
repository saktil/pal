import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { WorkspaceBusy, type WorkspaceLocks } from "./execution.ts";
import { InvalidRequest, RequestConflict, validate } from "./requests.ts";

const PurgeBody = Type.Object(
  {
    root: Type.String({ minLength: 1, maxLength: 4096 }),
    identity: Type.String({ pattern: "^[0-9]+:[0-9]+:[0-9]+:[0-9]+$", maxLength: 120 }),
  },
  { additionalProperties: false },
);
export type RemovedWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly removedAt: number;
  readonly identity: string | null;
  readonly pending: boolean;
  readonly problem?: string;
};
type Row = { id: string; name: string; root: string; removed_at: number };
type Intent = { directory: string; identity: string; completed_at: number | null };

/** Owner-only cleanup, never a model tool. A stopped purge is inspected again on explicit retry, not on startup. */
export class WorkspacePurge {
  readonly #database: SqliteDatabase;
  readonly #dataRoot: string;
  readonly #locks: WorkspaceLocks;
  #busy = false;

  constructor(database: SqliteDatabase, dataRoot: string, locks: WorkspaceLocks) {
    this.#database = database;
    this.#dataRoot = dataRoot;
    this.#locks = locks;
  }

  async list(): Promise<{ workspaces: RemovedWorkspace[]; truncated: boolean }> {
    const rows = await this.#database.all<Row>(
      "SELECT p.id, p.name, p.root, p.removed_at FROM pal_projects p LEFT JOIN pal_workspace_purges d ON d.project_id = p.id WHERE p.mode = 'managed' AND p.state = 'ready' AND p.removed_at IS NOT NULL AND d.completed_at IS NULL ORDER BY p.removed_at DESC, p.id LIMIT 101",
    );
    const workspaces: RemovedWorkspace[] = [];
    for (const row of rows.slice(0, 100)) {
      const intent = await this.#intent(row.id);
      try {
        const location = await this.#location(row, intent);
        const identity = location === undefined ? intent?.identity : await this.#identity(location, intent);
        if (identity === undefined) throw new RequestConflict("The workspace folder is missing.");
        if (intent !== undefined && identity !== intent.identity)
          throw new RequestConflict("The workspace folder changed. Inspect it on the server before deleting it.");
        workspaces.push({
          id: row.id,
          name: row.name,
          root: row.root,
          removedAt: row.removed_at,
          identity,
          pending: intent !== undefined,
        });
      } catch (error) {
        workspaces.push({
          id: row.id,
          name: row.name,
          root: row.root,
          removedAt: row.removed_at,
          identity: null,
          pending: intent !== undefined,
          problem: error instanceof RequestConflict ? error.message : "Pal cannot inspect this workspace folder.",
        });
      }
    }
    return { workspaces, truncated: rows.length > 100 };
  }

  async purge(id: string, input: unknown): Promise<void> {
    const body = validate(PurgeBody, input);
    if (this.#busy) throw new WorkspaceBusy("another workspace deletion is in progress");
    this.#busy = true;
    try {
      const row = await this.#database.get<Row>(
        "SELECT id, name, root, removed_at FROM pal_projects WHERE id = ? AND mode = 'managed' AND state = 'ready' AND removed_at IS NOT NULL",
        id,
      );
      if (row === undefined) throw new InvalidRequest("only a removed managed workspace can be deleted");
      if (body.root !== row.root) throw new RequestConflict("The workspace path changed. Refresh before deleting it.");
      await this.#locks.run(row.root, async () => {
        let intent = await this.#intent(id);
        if (intent !== undefined && intent.completed_at !== null) {
          if (intent.identity !== body.identity) throw new RequestConflict("The workspace identity changed.");
          return;
        }
        const location = await this.#location(row, intent);
        if (location !== undefined && (await this.#identity(location, intent)) !== body.identity)
          throw new RequestConflict("The workspace folder changed. Refresh before deleting it.");
        if (intent !== undefined && intent.identity !== body.identity)
          throw new RequestConflict("This deletion belongs to a different workspace folder.");
        const trash = join(this.#dataRoot, "workspace-trash");
        await mkdir(trash, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        await this.#directory(trash);
        if (intent === undefined) {
          if (location === undefined) throw new RequestConflict("The workspace folder is missing.");
          const directory = `${id}-${randomUUID()}`;
          await this.#database.run(
            "INSERT INTO pal_workspace_purges (project_id, directory, identity) VALUES (?, ?, ?)",
            id,
            directory,
            body.identity,
          );
          intent = { directory, identity: body.identity, completed_at: null };
        }
        const destination = join(this.#dataRoot, "workspace-trash", intent.directory);
        if (location === join(this.#dataRoot, "projects", id)) {
          // Move the directory itself: a replaced workspace symlink must never redirect a recursive deletion.
          await rename(location, destination);
        }
        if (await this.#exists(destination)) {
          if ((await this.#identity(destination, intent)) !== intent.identity)
            throw new RequestConflict("The moved workspace changed. Inspect it on the server before retrying.");
          await rm(join(destination, "workspace"), { recursive: true, force: true, maxRetries: 2 });
          await rmdir(destination);
        }
        for (const name of ["projects", "workspace-trash"]) {
          const directory = await open(join(this.#dataRoot, name), constants.O_RDONLY | constants.O_DIRECTORY);
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
        await this.#database.run(
          "UPDATE pal_workspace_purges SET completed_at = ? WHERE project_id = ?",
          Date.now(),
          id,
        );
      });
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw new RequestConflict("The workspace could not be fully deleted. Refresh and inspect it before retrying.");
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  #intent(id: string): Promise<Intent | undefined> {
    return this.#database.get<Intent>(
      "SELECT directory, identity, completed_at FROM pal_workspace_purges WHERE project_id = ?",
      id,
    );
  }

  async #location(row: Row, intent: Intent | undefined): Promise<string | undefined> {
    if (!/^[a-zA-Z0-9-]+$/.test(row.id) || row.root !== join(this.#dataRoot, "projects", row.id, "workspace"))
      throw new RequestConflict("This is not a managed workspace path.");
    if ((await realpath(this.#dataRoot)) !== this.#dataRoot)
      throw new RequestConflict("Pal's data folder moved. Inspect it on the server before deleting workspaces.");
    for (const name of ["projects", "workspace-trash"]) {
      const path = join(this.#dataRoot, name);
      if (name === "projects" || (await this.#exists(path))) await this.#directory(path);
    }
    const source = join(this.#dataRoot, "projects", row.id);
    if (intent === undefined) return source;
    if (!/^[a-zA-Z0-9-]+$/.test(intent.directory)) throw new RequestConflict("Invalid deletion location.");
    const destination = join(this.#dataRoot, "workspace-trash", intent.directory);
    const [original, moved] = await Promise.all([this.#exists(source), this.#exists(destination)]);
    if (original && moved) throw new RequestConflict("Both workspace locations exist. Inspect them before retrying.");
    return original ? source : moved ? destination : undefined;
  }

  async #identity(directory: string, intent?: Intent): Promise<string> {
    const parent = await this.#directory(directory);
    const container = `${parent.dev}:${parent.ino}:`;
    const entries = await readdir(directory);
    // A crash may occur after the workspace is gone but before its empty container or receipt is removed.
    if (
      entries.length === 0 &&
      intent?.identity.startsWith(container) &&
      directory === join(this.#dataRoot, "workspace-trash", intent.directory)
    )
      return intent.identity;
    if (entries.length !== 1 || entries[0] !== "workspace")
      throw new RequestConflict("The workspace container changed. Inspect it before deleting it.");
    const workspace = await this.#directory(join(directory, "workspace"));
    return `${container}${workspace.dev}:${workspace.ino}`;
  }

  async #directory(path: string) {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.uid !== BigInt(process.getuid?.() ?? -1) || (await realpath(path)) !== path)
      throw new RequestConflict("A workspace directory was replaced or linked. Inspect it before deleting it.");
    return info;
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
