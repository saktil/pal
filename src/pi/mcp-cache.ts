import type { CallToolResult } from "@earendil-works/pi-mcp";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { MAX_RESULT_BYTES } from "./mcp-result.ts";

const RAM_BYTES = 8 * 1024 * 1024;
const DISK_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 512;
const MAX_TTL = 24 * 60 * 60 * 1000;
const Result = Type.Object(
  {
    content: Type.Array(
      Type.Object({ type: Type.Literal("text"), text: Type.String() }, { additionalProperties: false }),
    ),
    isError: Type.Literal(false),
    structuredContent: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type CacheScope = { key: string; project: string; server: string };
type Row = {
  key: string;
  project_id: string;
  server_id: string;
  value: string;
  fetched_at: number;
  expires_at: number;
  bytes: number;
};
export type CachedMcpResult = { result: CallToolResult; fetchedAt: number; expiresAt: number };

/** Derived, project-scoped results only. Authority and schema revisions belong in the caller's opaque key. */
export class McpQueryCache {
  readonly #database: SqliteDatabase;
  readonly #now: () => number;
  readonly #ram = new Map<string, Row>();
  #bytes = 0;
  constructor(database: SqliteDatabase, now: () => number = Date.now) {
    this.#database = database;
    this.#now = now;
  }

  async get(scope: CacheScope): Promise<CachedMcpResult | undefined> {
    const row =
      this.#ram.get(scope.key) ??
      (await this.#database.get<Row>(
        "SELECT * FROM pal_mcp_cache WHERE key = ? AND project_id = ? AND server_id = ?",
        scope.key,
        scope.project,
        scope.server,
      ));
    if (row === undefined) return;
    if (row.project_id !== scope.project || row.server_id !== scope.server) return;
    const now = this.#now();
    if (
      row.fetched_at > now ||
      row.expires_at <= now ||
      row.expires_at - row.fetched_at > MAX_TTL ||
      row.bytes > MAX_RESULT_BYTES ||
      Buffer.byteLength(row.value) !== row.bytes
    ) {
      await this.#remove(scope);
      return;
    }
    let result: CallToolResult;
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (!Value.Check(Result, parsed)) throw new Error("invalid derived result");
      result = parsed;
    } catch {
      await this.#remove(scope);
      return;
    }
    await this.#database.run(
      "UPDATE pal_mcp_cache SET last_used = ? WHERE key = ? AND project_id = ? AND server_id = ?",
      now,
      scope.key,
      scope.project,
      scope.server,
    );
    this.#remember(row);
    return { result, fetchedAt: row.fetched_at, expiresAt: row.expires_at };
  }

  async put(
    scope: CacheScope,
    result: CallToolResult,
    fetchedAt: number,
    ttlMs: number,
  ): Promise<CachedMcpResult | undefined> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      await this.#remove(scope);
      return;
    }
    if (result.isError === true) return;
    const value = JSON.stringify(result),
      bytes = Buffer.byteLength(value);
    if (bytes > MAX_RESULT_BYTES || !Value.Check(Result, result)) return;
    const expiresAt = fetchedAt + Math.min(Math.floor(ttlMs), MAX_TTL);
    if (expiresAt <= this.#now() || fetchedAt > this.#now()) return;
    const row: Row = {
      key: scope.key,
      project_id: scope.project,
      server_id: scope.server,
      value,
      bytes,
      fetched_at: fetchedAt,
      expires_at: expiresAt,
    };
    const evicted = await this.#database.transaction(async (tx) => {
      await tx.run("DELETE FROM pal_mcp_cache WHERE expires_at <= ? OR fetched_at > ?", this.#now(), this.#now());
      await tx.run(
        "INSERT INTO pal_mcp_cache (key, project_id, server_id, value, bytes, fetched_at, expires_at, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET project_id = excluded.project_id, server_id = excluded.server_id, value = excluded.value, bytes = excluded.bytes, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, last_used = excluded.last_used",
        row.key,
        row.project_id,
        row.server_id,
        value,
        bytes,
        fetchedAt,
        expiresAt,
        this.#now(),
      );
      const rows = await tx.all<{ key: string; bytes: number }>(
        "SELECT key, bytes FROM pal_mcp_cache ORDER BY last_used DESC, rowid DESC",
      );
      let total = 0;
      const removed: string[] = [];
      for (const [index, item] of rows.entries()) {
        total += item.bytes;
        if (index >= MAX_ENTRIES || total > DISK_BYTES) {
          await tx.run("DELETE FROM pal_mcp_cache WHERE key = ?", item.key);
          removed.push(item.key);
        }
      }
      return removed;
    });
    for (const key of evicted) this.#forget(key);
    if (!evicted.includes(scope.key)) this.#remember(row);
    return { result, fetchedAt, expiresAt };
  }

  async clear(server: string): Promise<void> {
    const forget = () => {
      for (const [key, row] of this.#ram) if (row.server_id === server) this.#forget(key);
    };
    forget();
    await this.#database.run("DELETE FROM pal_mcp_cache WHERE server_id = ?", server);
    forget();
  }
  close(): void {
    this.#ram.clear();
    this.#bytes = 0;
  }

  async #remove(scope: CacheScope) {
    this.#forget(scope.key);
    await this.#database.run(
      "DELETE FROM pal_mcp_cache WHERE key = ? AND project_id = ? AND server_id = ?",
      scope.key,
      scope.project,
      scope.server,
    );
  }
  #forget(key: string) {
    const prior = this.#ram.get(key);
    if (prior !== undefined) this.#bytes -= prior.bytes;
    this.#ram.delete(key);
  }
  #remember(row: Row) {
    this.#forget(row.key);
    this.#ram.set(row.key, row);
    this.#bytes += row.bytes;
    while (this.#bytes > RAM_BYTES) {
      const key = this.#ram.keys().next().value;
      if (key === undefined) break;
      this.#forget(key);
    }
  }
}

/** HTTP response policy can only shorten the reviewed tool's default TTL, never extend it. */
export function responseCacheTtl(headers: Headers, defaultMs: number): number {
  const control = headers.get("cache-control") ?? "";
  if (
    /(?:^|,)\s*(?:no-store|no-cache)\s*(?:=|,|$)/i.test(control) ||
    headers.get("pragma")?.toLowerCase().includes("no-cache") ||
    headers
      .get("vary")
      ?.split(",")
      .some((name) => name.trim() === "*")
  )
    return 0;
  const age = Number(headers.get("age") ?? "0");
  if (!Number.isFinite(age) || age < 0) return 0;
  const now = Date.now(),
    date = Date.parse(headers.get("date") ?? ""),
    elapsed = Math.max(age * 1000, Number.isFinite(date) ? now - date : 0);
  let ttl = Math.min(defaultMs, MAX_TTL) - elapsed;
  const limits = control.split(",").filter((part) => /^\s*max-age\b/i.test(part));
  if (limits.length > 1) return 0;
  const maxAge = /^\s*max-age\s*=\s*"?(\d+)"?\s*$/i.exec(limits[0] ?? "");
  if (maxAge !== null) ttl = Math.min(ttl, Number(maxAge[1]) * 1000 - elapsed);
  else if (limits.length !== 0) return 0;
  const expiry = headers.get("expires");
  if (expiry !== null && maxAge === null) {
    const at = Date.parse(expiry);
    if (!Number.isFinite(at)) return 0;
    ttl = Math.min(ttl, at - (Number.isFinite(date) ? date : now) - elapsed);
  }
  return Math.max(0, ttl);
}
