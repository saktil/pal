import { DatabaseSync } from "node:sqlite";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

/** Another connection, normally another Pal process, holds the database's exclusive lock. */
export class DatabaseOwnedError extends Error {}

/**
 * Open the one connection to a Pal database, through Pi's serialized facade that every reader and writer shares.
 *
 * locking_mode=EXCLUSIVE, set before WAL is first used, makes SQLite hold an OS file lock for the connection's
 * lifetime without a shared-memory index: no other process can read or write the file, and the kernel releases the
 * lock when this process exits or is killed. POSIX locks drop when any descriptor of the file closes, so nothing else
 * in the process may open the file directly (copy it with SQLite's backup or VACUUM INTO, never fs).
 *
 * synchronous=FULL syncs the WAL on every commit, so a committed transaction survives power loss; Pi's own opener
 * uses NORMAL, which can roll back the newest commits. macOS fsync does not reach stable storage, so fullfsync makes
 * SQLite use F_FULLFSYNC there (about 4 ms per commit measured); Linux ignores it.
 */
export async function openDatabase(path: string): Promise<NodeSqliteDatabase> {
  const database = new NodeSqliteDatabase(new DatabaseSync(path, { timeout: 0 }));
  try {
    await database.exec("PRAGMA locking_mode = EXCLUSIVE");
    await database.exec("PRAGMA journal_mode = WAL");
    await database.exec("PRAGMA synchronous = FULL");
    await database.exec("PRAGMA fullfsync = ON");
    // Take the lock at open rather than at the first write.
    await database.transaction(async () => {});
    const journal = await database.get<{ journal_mode: string }>("PRAGMA journal_mode");
    const sync = await database.get<{ synchronous: number }>("PRAGMA synchronous");
    const fullfsync = await database.get<{ fullfsync: number }>("PRAGMA fullfsync");
    const locking = await database.get<{ locking_mode: string }>("PRAGMA locking_mode");
    const applied = `journal_mode=${journal?.journal_mode}, synchronous=${sync?.synchronous}, fullfsync=${fullfsync?.fullfsync}, locking_mode=${locking?.locking_mode}`;
    if (applied !== "journal_mode=wal, synchronous=2, fullfsync=1, locking_mode=exclusive") {
      throw new Error(`SQLite settings not applied: ${applied}`);
    }
    return database;
  } catch (error) {
    await database.close().catch(() => {});
    // SQLITE_BUSY, including its extended codes.
    if (((error as { errcode?: number }).errcode ?? 0) % 256 === 5) {
      throw new DatabaseOwnedError(`${path} is in use by another process`, { cause: error });
    }
    throw error;
  }
}
