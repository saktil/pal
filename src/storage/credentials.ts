import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";

const KEY_BYTES = 32;
const SEALED_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Non-secret identity a credential keeps after sign-out, so the next sign-in can return to the same registration. */
const RETAINED_FIELDS = ["clientId", "accountId", "email"];

/** Read the credential master key, creating it on first use. It lives outside SQLite, so a copied database alone reveals no secret. */
export async function loadMasterKey(path: string): Promise<Buffer> {
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      const key = randomBytes(KEY_BYTES);
      await handle.writeFile(key);
      await handle.sync();
      return key;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (((await stat(path)).mode & 0o077) !== 0)
    throw new Error(`${path} must be readable only by its owner (chmod 600)`);
  const key = await readFile(path);
  if (key.length !== KEY_BYTES) throw new Error(`${path} is not a Pal credential key`);
  return key;
}

/**
 * Pi's credential store over `pal_credentials`, sealed with AES-256-GCM bound to this installation and provider.
 * `modify` holds a per-provider lock across its callback, so a refresh that rotates tokens is persisted before any
 * other reader or writer proceeds; the store's exclusive database ownership extends that to other processes. Each
 * write is one statement, so no SQL transaction spans the callback's network I/O.
 */
export class SqliteCredentialStore implements CredentialStore {
  readonly #database: SqliteDatabase;
  readonly #key: Buffer;
  readonly #installationId: string;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(database: SqliteDatabase, key: Buffer, installationId: string) {
    this.#database = database;
    this.#key = key;
    this.#installationId = installationId;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const row = await this.#database.get<{ sealed: Uint8Array | null }>(
      "SELECT sealed FROM pal_credentials WHERE provider_id = ?",
      providerId,
    );
    return row?.sealed == null ? undefined : this.#unseal(providerId, row.sealed);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return (
      await this.#database.all<{ provider_id: string; type: Credential["type"] }>(
        "SELECT provider_id, type FROM pal_credentials WHERE sealed IS NOT NULL ORDER BY provider_id",
      )
    ).map((row) => ({ providerId: row.provider_id, type: row.type }));
  }

  async modify(
    providerId: string,
    change: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#serial(providerId, async () => {
      const current = await this.read(providerId);
      const next = await change(current);
      if (next === undefined) return current;
      const fields: Partial<Record<string, unknown>> = { ...next };
      const retained = Object.fromEntries(
        RETAINED_FIELDS.flatMap((field) => (typeof fields[field] === "string" ? [[field, fields[field]]] : [])),
      );
      await this.#database.run(
        `INSERT INTO pal_credentials (provider_id, type, sealed, retained, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider_id) DO UPDATE SET type = excluded.type, sealed = excluded.sealed,
           retained = COALESCE(excluded.retained, pal_credentials.retained), updated_at = excluded.updated_at`,
        providerId,
        next.type,
        this.#seal(providerId, next),
        Object.keys(retained).length === 0 ? null : JSON.stringify(retained),
        Date.now(),
      );
      return next;
    });
  }

  /** Sign out: drop the secret, keep the retained identity. */
  async delete(providerId: string): Promise<void> {
    await this.#serial(providerId, () =>
      this.#database.run(
        "UPDATE pal_credentials SET type = NULL, sealed = NULL, updated_at = ? WHERE provider_id = ?",
        Date.now(),
        providerId,
      ),
    );
  }

  /** Forget the provider entirely, so the next sign-in starts a new registration. */
  async forget(providerId: string): Promise<void> {
    await this.#serial(providerId, () =>
      this.#database.run("DELETE FROM pal_credentials WHERE provider_id = ?", providerId),
    );
  }

  /** Keep identity without a credential, such as a verified registration whose plan use was not granted. */
  async retain(providerId: string, retained: Readonly<Record<string, string>>): Promise<void> {
    await this.#serial(providerId, () =>
      this.#database.run(
        `INSERT INTO pal_credentials (provider_id, retained, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (provider_id) DO UPDATE SET retained = excluded.retained, updated_at = excluded.updated_at`,
        providerId,
        JSON.stringify(retained),
        Date.now(),
      ),
    );
  }

  async retained(providerId: string): Promise<Readonly<Record<string, string>> | undefined> {
    const row = await this.#database.get<{ retained: string | null }>(
      "SELECT retained FROM pal_credentials WHERE provider_id = ?",
      providerId,
    );
    return row?.retained == null ? undefined : JSON.parse(row.retained);
  }

  async #serial<T>(providerId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.#locks.get(providerId) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => {});
    this.#locks.set(providerId, settled);
    try {
      return await run;
    } finally {
      if (this.#locks.get(providerId) === settled) this.#locks.delete(providerId);
    }
  }

  #aad(providerId: string): Buffer {
    return Buffer.from(`pal-credential:${this.#installationId}:${providerId}`);
  }

  #seal(providerId: string, credential: Credential): Uint8Array {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv, { authTagLength: TAG_BYTES }).setAAD(
      this.#aad(providerId),
    );
    const data = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
    return Buffer.concat([Buffer.of(SEALED_VERSION), iv, cipher.getAuthTag(), data]);
  }

  #unseal(providerId: string, sealed: Uint8Array): Credential {
    const bytes = Buffer.from(sealed);
    if (bytes[0] !== SEALED_VERSION) throw new Error(`credential for ${providerId} has an unknown format`);
    if (bytes.length <= 1 + IV_BYTES + TAG_BYTES)
      throw new Error(`credential for ${providerId} has a truncated envelope`);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(1, 1 + IV_BYTES), {
      authTagLength: TAG_BYTES,
    })
      .setAAD(this.#aad(providerId))
      .setAuthTag(bytes.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
    const data = Buffer.concat([decipher.update(bytes.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
    return JSON.parse(data.toString("utf8"));
  }
}
