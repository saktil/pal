import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteCredentialStore } from "../src/storage/credentials.ts";
import { openStore } from "../src/storage/store.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pal-credential-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = await openStore(root);
  cleanups.push(() => store.close());
  const key = randomBytes(32);
  const credentials = new SqliteCredentialStore(store.database, key, store.installationId);
  const encode = (text: string, provider = "fixture") => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(
      Buffer.from(`pal-credential:${store.installationId}:${provider}`),
    );
    const data = Buffer.concat([cipher.update(text), cipher.final()]);
    return Buffer.concat([Buffer.of(1), iv, cipher.getAuthTag(), data]);
  };
  const save = (sealed: Uint8Array) =>
    store.database.run(
      "INSERT INTO pal_credentials (provider_id, type, sealed, updated_at) VALUES ('fixture', 'api_key', ?, 0) ON CONFLICT (provider_id) DO UPDATE SET sealed = excluded.sealed",
      sealed,
    );
  return { store, key, credentials, encode, save };
}

describe("credential envelopes", () => {
  it("reads existing full-tag envelopes and rejects truncated ones before decoding", async () => {
    const { credentials, encode, save } = await setup();
    const value = { type: "api_key", key: "fixture-only" };
    const sealed = encode(JSON.stringify(value));
    await save(sealed);
    expect(await credentials.read("fixture")).toEqual(value);
    for (const length of [1, 12, 13, 25, 28, 29]) {
      await save(sealed.subarray(0, length));
      await expect(credentials.read("fixture")).rejects.toThrow(/truncated envelope/);
    }
  });

  it("rejects tag tampering and installation or provider substitution", async () => {
    const { store, key, credentials, encode, save } = await setup();
    const sealed = encode(JSON.stringify({ type: "api_key", key: "fixture-only" }));
    const damaged = Buffer.from(sealed);
    damaged[13] = (damaged[13] ?? 0) ^ 1;
    await save(damaged);
    await expect(credentials.read("fixture")).rejects.toThrow();
    await save(encode(JSON.stringify({ type: "api_key", key: "fixture-only" }), "another-provider"));
    await expect(credentials.read("fixture")).rejects.toThrow();
    await save(sealed);
    const other = new SqliteCredentialStore(store.database, key, "another-installation");
    await expect(other.read("fixture")).rejects.toThrow();
  });

  it("does not turn corrupt credential or retained JSON into anonymous credentials", async () => {
    const { store, credentials, encode, save } = await setup();
    await save(encode("not-json"));
    await expect(credentials.read("fixture")).rejects.toBeInstanceOf(SyntaxError);
    await store.database.run("UPDATE pal_credentials SET retained = '{broken' WHERE provider_id = 'fixture'");
    await expect(credentials.retained("fixture")).rejects.toBeInstanceOf(SyntaxError);
  });
});
