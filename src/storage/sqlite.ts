import { type NodeSqliteDatabase, openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

/**
 * Open a database through Pi's serialized Node SQLite facade, which every reader and writer must share.
 * Pi configures WAL with synchronous=NORMAL; Pal raises it to FULL so a committed transaction is
 * synced to the WAL before the commit returns, instead of possibly rolling back after power loss.
 */
export async function openDatabase(path: string): Promise<NodeSqliteDatabase> {
  const database = await openNodeSqliteDatabase(path);
  try {
    await database.exec("PRAGMA synchronous = FULL");
    const journal = await database.get<{ journal_mode: string }>("PRAGMA journal_mode");
    const sync = await database.get<{ synchronous: number }>("PRAGMA synchronous");
    if (journal?.journal_mode !== "wal" || sync?.synchronous !== 2) {
      throw new Error(
        `SQLite durability settings not applied: journal_mode=${journal?.journal_mode}, synchronous=${sync?.synchronous}`,
      );
    }
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}
