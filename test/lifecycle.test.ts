import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../src/core/api.ts";
import { openPal } from "../src/core/app.ts";
import { createRequestListener, startServer } from "../src/core/server.ts";
import { releaseHealth } from "../src/core/supervise.ts";

const main = join(import.meta.dirname, "../src/main.ts");
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "pal-lifecycle-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function cli(fault = false) {
  const root = await directory();
  const child = spawn(
    process.execPath,
    [
      ...(fault ? ["--import", join(import.meta.dirname, "fixtures/failing-harness.ts")] : []),
      main,
      "serve",
      "--port",
      "0",
      "--data-dir",
      join(root, "data"),
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const exited = once(child, "exit");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  child.stderr?.resume();
  const ready = Promise.withResolvers<string>();
  child.once("error", ready.reject);
  child.once("exit", () => ready.reject(new Error("CLI exited before readiness")));
  let output = "",
    online = false;
  child.stdout?.on("data", (bytes: Buffer) => {
    if (online) return;
    output = (output + bytes.toString()).slice(-4096);
    const origin = /listening on (http:\/\/\S+)/.exec(output)?.[1];
    if (origin !== undefined) {
      online = true;
      output = "";
      ready.resolve(origin);
    }
  });
  const timer = setTimeout(() => ready.reject(new Error("CLI did not become ready")), 5000);
  try {
    const origin = await ready.promise;
    return { child, exited, origin };
  } finally {
    clearTimeout(timer);
  }
}

describe("durable runtime lifecycle", () => {
  it("rejects a malformed origin before creating a request listener", () => {
    expect(() => createRequestListener({ version: "test", publicOrigin: "not-an-origin" })).toThrow(
      "invalid public origin",
    );
  });

  it("refuses APIs and probation health after an actual SQLite failure instead of touching closed storage", async () => {
    const root = await directory();
    const pal = await openPal({ dataRoot: join(root, "data"), installRoot: "/nonexistent" }, context);
    cleanups.push(() => pal.close());
    expect(() => createApi(pal, "not-an-origin")).toThrow("invalid public origin");
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      version: "test",
      api: createApi(pal),
      health: () => ({
        status: pal.status === "ready" ? "ok" : pal.status,
        release: pal.extensions.release,
        admitting: false,
      }),
    });
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/api/session`)).status).toBe(200);
    await releaseHealth(base, pal.extensions.release);
    await pal.store.database.exec("PRAGMA query_only = ON");
    await expect(pal.harness.createConversation({ ownership: { kind: "ownerless" } }, context)).rejects.toThrow();
    expect(await pal.harness.closed).toMatchObject({ reason: "failed" });
    expect((await fetch(`${base}/api/health`)).status).toBe(503);
    await expect(releaseHealth(base, pal.extensions.release)).rejects.toThrow(/health/);
    const unavailable = await fetch(`${base}/api/session`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: "runtime_unavailable" });
    expect(pal).toHaveProperty("status", "failed");
    const closed = pal.close();
    expect(pal.close()).toBe(closed);
    await closed;
    expect(pal).toHaveProperty("status", "failed");
  });

  it("seals availability synchronously during idempotent normal teardown", async () => {
    const pal = await openPal({ dataRoot: await directory(), installRoot: "/nonexistent" }, context);
    cleanups.push(() => pal.close());
    expect(pal).toHaveProperty("status", "ready");
    const closed = pal.close();
    expect(pal).toHaveProperty("status", "closing");
    expect(pal.close()).toBe(closed);
    await closed;
    expect(pal).toHaveProperty("status", "closed");
  });

  it("keeps a healthy standalone server ready and shuts down with zero status", async () => {
    const { child, exited, origin } = await cli();
    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });
    child.kill("SIGTERM");
    expect((await exited)[0]).toBe(0);
    await expect(fetch(`${origin}/api/health`)).rejects.toThrow();
  });

  it("exits a standalone server nonzero when its durable runtime fails after startup", async () => {
    const { child, exited } = await cli(true);
    child.send("fail");
    await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(1);
    expect((await exited)[0]).toBe(1);
  });

  it("never opens a listener after a startup storage failure", async () => {
    const file = join(await directory(), "not-a-directory");
    await writeFile(file, "keep");
    await expect(
      promisify(execFile)(process.execPath, [main, "serve", "--port", "0", "--data-dir", file], {
        timeout: 5000,
        maxBuffer: 64 * 1024,
      }),
    ).rejects.toMatchObject({ code: 1, stdout: expect.not.stringContaining("listening on") });
  });
});
