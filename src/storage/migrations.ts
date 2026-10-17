import { randomUUID } from "node:crypto";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";

export type Migration = {
  readonly version: number;
  readonly name: string;
  up(transaction: SqliteExecutor): Promise<void>;
};

/** Pal's own `pal_` schema, versioned separately from Pi's. Append only: never edit or reorder an applied entry. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "installation",
    // A stable identity for provider registration; generated once, never per request or restart.
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_installation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT`);
      await transaction.run(
        "INSERT INTO pal_installation (singleton, id, created_at) VALUES (1, ?, ?)",
        randomUUID(),
        Date.now(),
      );
    },
  },
];

/**
 * Apply pending migrations in one transaction, so a crash leaves the previous schema intact. Refuses a history this
 * build does not know, such as one written by a newer Pal, instead of running against it.
 */
export async function migrate(database: SqliteDatabase, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.exec(`CREATE TABLE IF NOT EXISTS pal_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT`);
    const applied = await transaction.all<{ version: number; name: string }>(
      "SELECT version, name FROM pal_migrations ORDER BY version",
    );
    for (const [index, row] of applied.entries()) {
      const known = migrations[index];
      if (known?.version !== row.version || known.name !== row.name) {
        throw new Error(`database has migration ${row.version} '${row.name}', which this Pal build does not know`);
      }
    }
    for (const migration of migrations.slice(applied.length)) {
      await migration.up(transaction);
      await transaction.run(
        "INSERT INTO pal_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        migration.version,
        migration.name,
        Date.now(),
      );
    }
  });
}
