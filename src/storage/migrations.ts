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
  {
    version: 2,
    name: "chats",
    // `intent` is the normalized request body, frozen so reconciliation completes exactly what was asked.
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_chats (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        intent TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready')),
        conversation_id INTEGER UNIQUE,
        created_at INTEGER NOT NULL,
        CHECK ((state = 'ready') = (conversation_id IS NOT NULL))
      ) STRICT`);
      await transaction.exec(`CREATE TABLE pal_admissions (
        seq INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        intent TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('admitting', 'admitted')),
        submission_id INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (chat_id, request_id),
        CHECK ((state = 'admitted') = (submission_id IS NOT NULL))
      ) STRICT`);
    },
  },
  {
    version: 3,
    name: "credentials",
    // `sealed` is the encrypted credential, NULL after sign-out; `retained` keeps non-secret identity for returning.
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_credentials (
        provider_id TEXT PRIMARY KEY,
        type TEXT CHECK (type IN ('api_key', 'oauth')),
        sealed BLOB,
        retained TEXT,
        updated_at INTEGER NOT NULL,
        CHECK ((type IS NULL) = (sealed IS NULL))
      ) STRICT`);
    },
  },
  {
    version: 4,
    name: "owner_and_settings",
    // Sessions are stored by token hash only: a copied database cannot be replayed as a cookie.
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        passphrase TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT`);
      await transaction.exec(`CREATE TABLE pal_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT`);
      await transaction.exec(`CREATE TABLE pal_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT`);
    },
  },
  {
    version: 5,
    name: "projects",
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_projects (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('managed', 'existing')),
        state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'failed')),
        root TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL
      ) STRICT`);
      await transaction.exec("ALTER TABLE pal_chats ADD COLUMN project_id TEXT");
      // Mutable display label, unlike the frozen intent; the first input names an untitled chat.
      await transaction.exec("ALTER TABLE pal_chats ADD COLUMN title TEXT");
    },
  },
  {
    version: 6,
    name: "mcp_servers",
    // Keys live in the credential store as `mcp:<id>`; `approved` holds the exact tool definitions the owner approved.
    up: async (transaction) => {
      await transaction.exec(`CREATE TABLE pal_mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        preset TEXT,
        url TEXT NOT NULL,
        auth TEXT NOT NULL,
        private INTEGER NOT NULL CHECK (private IN (0, 1)),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        approved TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT`);
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
