// P0-A feasibility for the later browser feature: the pinned playwright-core drives Nix's matched Chromium with
// its sandbox on, and a persistent profile keeps a site's cookie across close and reopen. Run through
// `nix build .#checks.<system>.browser`, which provides the browsers; nothing here is part of normal startup.
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { version } = createRequire(import.meta.url)("playwright-core/package.json") as { version: string };
const server = createServer((request, response) => {
  if (request.url === "/login") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "set-cookie": "session=fixture; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax",
    });
    response.end("signed in");
  } else if (request.url === "/whoami") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(request.headers.cookie ?? "anonymous");
  } else {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Pal fixture</title><button onclick="this.textContent='clicked'">go</button>`);
  }
});
let base: string;
let profile: string;

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profile = await mkdtemp(join(tmpdir(), "pal-browser-profile-"));
});

afterAll(async () => {
  server.close();
  await rm(profile, { recursive: true, force: true });
});

describe("Chromium feasibility", () => {
  it("uses the playwright-core release that matches the provided browsers", () => {
    expect(process.env.PLAYWRIGHT_BROWSERS_PATH, "run via nix build .#checks.<system>.browser").toBeTruthy();
    expect(version).toBe(process.env.PAL_EXPECTED_PLAYWRIGHT);
  });

  it("drives a sandboxed page and keeps a persistent profile's cookie across reopen", async () => {
    const launch = () => chromium.launchPersistentContext(profile, { headless: true, chromiumSandbox: true });

    let context = await launch();
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(base);
      expect(await page.title()).toBe("Pal fixture");
      await page.click("button");
      expect(await page.textContent("button")).toBe("clicked");
      expect((await page.screenshot()).byteLength).toBeGreaterThan(0);
      await page.goto(`${base}/login`);
    } finally {
      await context.close();
    }

    context = await launch();
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(`${base}/whoami`);
      expect(await page.textContent("body")).toBe("session=fixture");
    } finally {
      await context.close();
    }
  });
});
