import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../src/core/server.ts";
import { releaseHealth } from "../src/core/supervise.ts";

let dir: string;
const servers: Server[] = [];

async function serve(webRoot: string | undefined): Promise<string> {
  const server = await startServer({ host: "127.0.0.1", port: 0, version: "1.2.3", webRoot });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pal-server-test-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>Pal</title>");
});

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  await rm(dir, { recursive: true, force: true });
});

describe("HTTP server", () => {
  it("holds APIs, assets and upgrades behind probation/drain while health verifies the exact artifact", async () => {
    let available = false,
      calls = 0,
      upgrades = 0;
    const release = "c".repeat(64);
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      version: "test",
      webRoot: dir,
      available: () => available,
      health: () => ({ status: "ok", release, admitting: available }),
      api: async (_request, response) => {
        calls++;
        response.end("{}");
      },
      upgrade: async (_request, socket) => {
        upgrades++;
        socket.destroy();
      },
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port,
      base = `http://127.0.0.1:${port}`;
    await releaseHealth(base, release);
    await expect(releaseHealth(base, "d".repeat(64))).rejects.toThrow(/immutable artifact/);
    for (const path of ["/", "/api/session", "/api/projects"]) expect((await fetch(`${base}${path}`)).status).toBe(503);
    expect(calls).toBe(0);
    const upgrade = () =>
      new Promise<void>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.on("error", () => {});
        socket.once("close", () => resolve());
        socket.end(
          `GET /api/socket HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        );
      });
    await upgrade();
    expect(upgrades).toBe(0);
    available = true;
    await upgrade();
    expect(upgrades).toBe(1);
    expect((await fetch(`${base}/api/session`)).status).toBe(200);
    expect(calls).toBe(1);
    expect((await fetch(base)).status).toBe(200);
    await expect(releaseHealth(base, release)).rejects.toThrow(/admission barrier/);
  });

  it("reports health with security headers and no caching", async () => {
    const base = await serve(dir);
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", name: "pal", version: "1.2.3" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self' data: blob:;");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self';");

    const head = await fetch(`${base}/api/health`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("rejects writes and unknown API routes", async () => {
    const base = await serve(dir);
    const post = await fetch(`${base}/api/health`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    const missing = await fetch(`${base}/api/unknown`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect((await fetch(`${base}/`, { method: "DELETE" })).status).toBe(405);
  });

  it("serves the built shell, falling back to index.html for client routes", async () => {
    const base = await serve(dir);
    for (const path of ["/", "/projects/abc"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>Pal</title>");
    }
  });

  it("answers a malformed request target with 400 and keeps serving", async () => {
    const base = await serve(dir);
    const { port } = new URL(base);
    const socket = connect(Number(port), "127.0.0.1");
    socket.end("GET http://[bad HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    let reply = "";
    for await (const chunk of socket) reply += chunk;
    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it("serves only the API when no frontend was built", async () => {
    const base = await serve(undefined);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(404);
    expect(await page.json()).toEqual({ error: "web_not_built" });
  });
});
