import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../src/core/api.ts";
import { openPal } from "../../src/core/app.ts";
import { startServer } from "../../src/core/server.ts";
import { GOOD_KEY, startProviderFixture } from "../fixtures/provider-server.ts";

let browser: Browser;
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
});
afterAll(async () => browser.close());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(width: number) {
  const provider = await startProviderFixture();
  cleanups.push(provider.close);
  const root = await mkdtemp(join(tmpdir(), "pal-chat-settings-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pal = await openPal({ dataRoot: root, installRoot: "/nonexistent", providerOrigin: provider.origin }, context);
  cleanups.push(() => pal.close());
  const token = await pal.owner.setup(pal.owner.setupToken, "correct horse battery");
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    version: "test",
    webRoot: join(import.meta.dirname, "../../dist/public"),
    api: createApi(pal),
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = async (path: string, body: object) => {
    const response = await fetch(`${base}/api/${path}`, {
      method: "PUT",
      headers: { origin: base, cookie: `pal_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
  };
  for (const id of ["openrouter", "anthropic"]) {
    await put(`providers/${id}/key`, { key: GOOD_KEY });
    await put(`providers/${id}/enabled`, { enabled: true });
  }
  await put("default-model", { provider: "openrouter", model: "~deepseek/deepseek-flash-latest" });
  const project = await pal.projects.create("settings-project", { name: "Settings" });
  const saved = await pal.chats.createChat(
    "saved-chat",
    { projectId: project.id, title: "Saved destination" },
    context,
  );
  const other = await pal.chats.createChat(
    "other-chat",
    { projectId: project.id, title: "Other destination" },
    context,
  );
  await put(`chats/${saved.id}/model`, { provider: "anthropic", model: "claude-haiku-4-5" });
  const view = await browser.newContext({ viewport: { width, height: 900 } });
  cleanups.push(() => view.close());
  await view.addCookies([{ name: "pal_session", value: token, url: base, httpOnly: true, sameSite: "Strict" }]);
  const page = await view.newPage();
  const errors: string[] = [];
  const mutations: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/chats/"))
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return { page, base, saved, other, provider, errors, mutations };
}

async function holdMetadata(page: Page, id: string) {
  const seen = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const done = Promise.withResolvers<undefined>();
  let started = false;
  await page.route(`**/api/chats/${id}`, async (route) => {
    started = true;
    try {
      const response = await route.fetch({ timeout: 5000 });
      seen.resolve(undefined);
      await release.promise;
      await route.fulfill({ response });
    } finally {
      done.resolve(undefined);
    }
  });
  cleanups.push(async () => {
    release.resolve(undefined);
    if (started) await done.promise;
  });
  return { seen: seen.promise, release: () => release.resolve(undefined), done: done.promise };
}
async function modelControl(page: Page, width: number) {
  if (width < 700) await page.getByRole("button", { name: "Workspace tools" }).click();
  return page.getByRole("button", { name: /^Model and reasoning:/ });
}
async function dismissTools(page: Page, width: number) {
  if (width < 700) await page.keyboard.press("Escape");
}
async function screenshot(page: Page, name: string) {
  const bounds = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  expect(bounds.content).toBeLessThanOrEqual(bounds.viewport);
  const root = process.env.PAL_E2E_SCREENSHOTS;
  if (root === undefined) return;
  await mkdir(root, { recursive: true });
  await page.screenshot({ path: join(root, `${name}.png`), animations: "disabled" });
}

describe("saved chat settings", () => {
  it.each([1440, 390])("waits for the saved provider before any model change or input at %s px", async (width) => {
    const { page, base, saved, provider, errors, mutations } = await setup(width);
    const held = await holdMetadata(page, saved.id);
    await page.goto(`${base}/#/chat/${saved.id}`);
    await held.seen;
    await page.getByLabel("Message", { exact: true }).fill("Use the saved destination");
    expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
    await page.getByLabel("Message", { exact: true }).press("Enter");
    const control = await modelControl(page, width);
    expect(await control.isDisabled()).toBe(true);
    await dismissTools(page, width);
    expect(mutations).toEqual([]);
    expect(provider.requests).toEqual([]);
    await screenshot(page, `settings-loading-${width}`);
    held.release();
    await held.done;
    await expect.poll(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
    const loaded = await modelControl(page, width);
    expect(await loaded.getAttribute("title")).toContain("Anthropic API");
    await dismissTools(page, width);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => provider.requests.map((request) => request.path)).toEqual(["/v1/messages"]);
    expect(provider.requests[0]?.body.model).toBe("claude-haiku-4-5");
    expect(mutations).toEqual([`POST /api/chats/${saved.id}/inputs`]);
    expect(errors).toEqual([]);
  });

  it.each([1440, 390])(
    "offers retry after a metadata failure without falling back or clearing text at %s px",
    async (width) => {
      const { page, base, saved, provider, errors, mutations } = await setup(width);
      let attempts = 0;
      await page.route(`**/api/chats/${saved.id}`, async (route) => {
        if (++attempts === 1)
          await route.fulfill({ status: 503, json: { error: "fixture", message: "Saved settings unavailable" } });
        else await route.continue();
      });
      await page.goto(`${base}/#/chat/${saved.id}`);
      await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
      await page.getByRole("alert").filter({ hasText: "Couldn't load saved chat settings" }).waitFor();
      expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
      expect(await (await modelControl(page, width)).isDisabled()).toBe(true);
      await dismissTools(page, width);
      expect(mutations).toEqual([]);
      expect(provider.requests).toEqual([]);
      await screenshot(page, `settings-failed-${width}`);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect.poll(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
      expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe("Keep this draft");
      expect(await (await modelControl(page, width)).getAttribute("title")).toContain("Anthropic API");
      await dismissTools(page, width);
      expect(attempts).toBe(2);
      expect(errors).toEqual([]);
    },
  );

  it("refuses a destination changed in another tab and keeps the draft for an explicit retry", async () => {
    const { page, base, saved, provider, errors } = await setup(1440);
    await page.goto(`${base}/#/chat/${saved.id}`);
    const control = page.getByRole("button", { name: /^Model and reasoning:/ });
    await expect.poll(() => control.getAttribute("title")).toContain("Anthropic API");
    const changed = await page.request.put(`${base}/api/chats/${saved.id}/model`, {
      headers: { origin: base },
      data: { provider: "openrouter", model: "~deepseek/deepseek-flash-latest" },
    });
    expect(changed.status()).toBe(200);
    await page.getByLabel("Message", { exact: true }).fill("Keep this destination explicit");
    const submitted = page.waitForResponse(`${base}/api/chats/${saved.id}/inputs`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    expect((await submitted).status()).toBe(409);
    expect(provider.requests).toEqual([]);
    await page.getByRole("alert").filter({ hasText: "Chat settings changed elsewhere" }).waitFor();
    expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe("Keep this destination explicit");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => control.getAttribute("title")).toContain("OpenRouter");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => provider.requests.map((request) => request.path)).toEqual(["/api/v1/chat/completions"]);
    expect(errors).toEqual([]);
  });

  it("keeps malformed successful responses out of chat and project settings", async () => {
    const { page, base, saved, errors, mutations } = await setup(1440);
    await page.route(`**/api/chats/${saved.id}`, (route) =>
      route.fulfill({ contentType: "application/json", body: '{"model":' }),
    );
    await page.route("**/api/projects/*/mcp", (route) =>
      route.fulfill({ contentType: "application/json", body: '{"servers":' }),
    );
    await page.goto(`${base}/#/chat/${saved.id}`);
    await page.getByRole("alert").filter({ hasText: "Couldn't load saved chat settings" }).waitFor();
    expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Project internet tools", exact: true }).click();
    await page.getByRole("dialog", { name: "Internet tools", exact: true }).getByRole("alert").waitFor();
    expect(mutations).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("ignores a late metadata response after navigating to a different chat", async () => {
    const { page, base, saved, other, provider, errors } = await setup(1440);
    const held = await holdMetadata(page, saved.id);
    await page.goto(`${base}/#/chat/${saved.id}`);
    await held.seen;
    const loaded = page.waitForResponse(`${base}/api/chats/${other.id}`);
    await page.evaluate((id) => {
      location.hash = `#/chat/${id}`;
    }, other.id);
    await loaded;
    await expect
      .poll(() => page.getByRole("button", { name: /^Model and reasoning:/ }).getAttribute("title"))
      .toContain("OpenRouter");
    held.release();
    await held.done;
    await page.getByLabel("Message", { exact: true }).fill("Use the other chat");
    await expect.poll(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => provider.requests.map((request) => request.path)).toEqual(["/api/v1/chat/completions"]);
    expect(errors).toEqual([]);
  });
});
