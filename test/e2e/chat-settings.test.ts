import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../src/core/api.ts";
import { openPal } from "../../src/core/app.ts";
import { startServer } from "../../src/core/server.ts";
import { runGit } from "../../src/core/git.ts";
import { GOOD_KEY, startProviderFixture } from "../fixtures/provider-server.ts";
import { startMcpFixture } from "../fixtures/mcp-server.ts";

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
  for (const chat of [saved, other]) expect(await pal.workspaces.info(chat.id)).toMatchObject({ state: "ready" });
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
  return { pal, page, base, project, saved, other, provider, errors, mutations };
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
    const [submitted] = await Promise.all([
      page.waitForResponse(`${base}/api/chats/${saved.id}/inputs`),
      page.getByRole("button", { name: "Send", exact: true }).click(),
    ]);
    expect(submitted.status()).toBe(409);
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

describe("MCP catalog consent", () => {
  it.each([1440, 390])(
    "keeps a stale tab's selection but requires the changed definitions to be reviewed at %s px",
    async (width) => {
      const { pal, page, base, provider, errors } = await setup(width);
      const fixture = await startMcpFixture();
      cleanups.push(fixture.close);
      const server = await pal.mcp.add({
        name: "Catalog fixture",
        url: fixture.url,
        auth: { kind: "none" },
        private: true,
      });
      const a = await pal.mcp.test(server.id);
      await pal.mcp.approve(server.id, ["fetch"], a.catalog);
      const tab = await page.context().newPage();
      tab.on("pageerror", (error) => errors.push(error.message));
      for (const view of [page, tab]) {
        await view.goto(`${base}/#/settings/mcp`);
        await view.getByRole("button", { name: /^Catalog fixture/ }).click();
        await view.getByRole("checkbox", { name: /^fetch/ }).waitFor();
      }
      await page.getByRole("checkbox", { name: /^search/ }).check();
      const search = fixture.state.tools[0];
      if (search === undefined) throw new Error("missing fixture tool");
      search.description = "Search definition B needs scope";
      search.inputSchema.required = ["query", "scope"];
      await tab.getByRole("button", { name: "Test connection", exact: true }).click();
      await tab.getByText(search.description, { exact: true }).waitFor();
      const approval = page.getByRole("button", { name: "Approve selected tools", exact: true });
      const [stale] = await Promise.all([
        page.waitForResponse(`${base}/api/mcp/servers/${server.id}/tools`),
        approval.click(),
      ]);
      expect(stale.status()).toBe(409);
      await page
        .getByRole("alert")
        .filter({ hasText: /catalog.*changed/ })
        .waitFor();
      await page.getByText(search.description, { exact: true }).waitFor();
      expect(await page.getByRole("checkbox", { name: /^search/ }).isChecked()).toBe(true);
      expect(await page.getByRole("checkbox", { name: /^fetch/ }).isChecked()).toBe(true);
      expect(await approval.isDisabled()).toBe(true);
      expect((await pal.mcp.get(server.id)).tools.filter((tool) => tool.approved).map((tool) => tool.name)).toEqual([
        "fetch",
      ]);
      await page.getByText("Previously reviewed catalog and selection", { exact: true }).click();
      const previous = page
        .locator("details")
        .filter({ has: page.getByText("Previously reviewed catalog and selection", { exact: true }) });
      expect(await previous.innerText()).toContain("Search the fixture web index");
      expect(await previous.innerText()).not.toContain(search.description);
      expect(await previous.innerText()).toContain('"selection": [');
      await page.getByText("Definition: search", { exact: true }).click();
      const definition = page.locator("details").filter({ has: page.getByText("Definition: search", { exact: true }) });
      expect(await definition.innerText()).toContain('"scope"');
      await screenshot(page, `mcp-catalog-conflict-${width}`);
      await page.getByRole("button", { name: "I reviewed the current catalog", exact: true }).click();
      const [approved] = await Promise.all([
        page.waitForResponse(`${base}/api/mcp/servers/${server.id}/tools`),
        approval.click(),
      ]);
      expect(approved.status()).toBe(200);
      await expect
        .poll(async () => (await pal.mcp.get(server.id)).tools.find((tool) => tool.name === "search")?.approved)
        .toBe(true);
      expect((await pal.mcp.get(server.id)).tools.find((tool) => tool.name === "search")?.changed).toBe(false);
      expect(fixture.calls).toEqual([]);
      expect(provider.requests).toEqual([]);
      expect(errors).toEqual([]);
    },
  );
});

async function reviewFixture(width: number) {
  const fixture = await setup(width);
  const { pal, project, saved, page, base } = fixture;
  const workspace = await pal.workspaces.info(saved.id);
  if (workspace?.state !== "ready" || workspace.root === null) throw new Error("missing review workspace");
  const root = workspace.root;
  const git = (...args: string[]) =>
    runGit(
      root,
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
      { signal: AbortSignal.timeout(5000) },
    );
  await git("init", "-q");
  for (const path of ["a.txt", "b.txt"]) await writeFile(join(root, path), `Base ${path}\n`);
  await git("add", "a.txt", "b.txt");
  await git("commit", "-qm", "Baseline");
  await pal.changes.capture(root);
  for (const path of ["a.txt", "b.txt"]) await writeFile(join(root, path), `Changed ${path}\n`);
  const changes = await pal.changes.list(project.id, "normal", workspace.id);
  const a = changes.files.find((file) => file.path === "a.txt"),
    b = changes.files.find((file) => file.path === "b.txt");
  if (a === undefined || b === undefined) throw new Error("missing review fixtures");
  await page.goto(`${base}/#/chat/${saved.id}`);
  if (width < 700) await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Workspace panel" });
  await panel.getByRole("button", { name: /^a\.txt/ }).click();
  await panel.getByRole("button", { name: "Comment on line 1", exact: true }).waitFor();
  return { ...fixture, workspace, root, a, b, panel };
}

describe("review comment drafts", () => {
  it.each([1440, 390])(
    "keeps the original target through a delayed refresh and only retargets explicitly at %s px",
    async (width) => {
      const { pal, page, base, project, workspace, root, a, panel, errors } = await reviewFixture(width);
      await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
      const draft = panel.getByRole("textbox", { name: "Comment on line 1", exact: true });
      await draft.fill("Feedback about revision A");
      await writeFile(join(root, "a.txt"), "New revision B\n");
      const seen = Promise.withResolvers<undefined>(),
        release = Promise.withResolvers<undefined>(),
        done = Promise.withResolvers<undefined>();
      await page.route(
        "**/api/projects/*/changes?*",
        async (route) => {
          const response = await route.fetch();
          seen.resolve(undefined);
          await release.promise;
          await route.fulfill({ response });
          done.resolve(undefined);
        },
        { times: 1 },
      );
      cleanups.push(async () => {
        release.resolve(undefined);
      });
      await panel.getByRole("button", { name: "Refresh", exact: true }).click();
      await seen.promise;
      await draft.fill("Feedback about revision A, edited while refreshing");
      release.resolve(undefined);
      await done.promise;
      await panel
        .getByRole("region", { name: "File diff", exact: true })
        .getByText("New revision B", { exact: true })
        .waitFor();
      const path = `${base}/api/projects/${project.id}/comments`;
      const [stale] = await Promise.all([
        page.waitForResponse(path),
        panel.getByRole("button", { name: "Add comment", exact: true }).click(),
      ]);
      expect(stale.request().postDataJSON()).toMatchObject({
        path: "a.txt",
        revision: a.revision,
        line: 1,
        workspace: workspace.id,
      });
      expect(stale.status()).toBe(409);
      await panel
        .getByRole("alert")
        .filter({ hasText: /draft.*kept/ })
        .waitFor();
      expect(await draft.inputValue()).toBe("Feedback about revision A, edited while refreshing");
      expect((await pal.changes.list(project.id, "normal", workspace.id)).comments).toEqual([]);
      await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
      expect(await draft.inputValue()).toBe("Feedback about revision A, edited while refreshing");
      await panel.getByRole("button", { name: "Retarget draft", exact: true }).click();
      await screenshot(page, `review-retarget-${width}`);
      const [submitted] = await Promise.all([
        page.waitForResponse(path),
        panel.getByRole("button", { name: "Add comment", exact: true }).click(),
      ]);
      expect(submitted.status()).toBe(200);
      const comments = (await pal.changes.list(project.id, "normal", workspace.id)).comments;
      expect(comments).toMatchObject([
        {
          path: "a.txt",
          line: 1,
          lineText: "New revision B",
          body: "Feedback about revision A, edited while refreshing",
        },
      ]);
      expect(comments[0]?.revision).not.toBe(a.revision);
      expect(errors).toEqual([]);
    },
  );

  it("keeps newer comment text when an older comment acknowledgement arrives", async () => {
    const { pal, page, project, workspace, panel, errors } = await reviewFixture(1440);
    await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
    const draft = panel.getByRole("textbox", { name: "Comment on line 1", exact: true });
    await draft.fill("First comment");
    const seen = Promise.withResolvers<undefined>(),
      release = Promise.withResolvers<undefined>(),
      done = Promise.withResolvers<undefined>();
    await page.route(
      "**/api/projects/*/comments",
      async (route) => {
        const response = await route.fetch();
        seen.resolve(undefined);
        await release.promise;
        await route.fulfill({ response });
        done.resolve(undefined);
      },
      { times: 1 },
    );
    cleanups.push(async () => {
      release.resolve(undefined);
    });
    await panel.getByRole("button", { name: "Add comment", exact: true }).click();
    await seen.promise;
    await draft.fill("Newer unsent comment");
    release.resolve(undefined);
    await done.promise;
    await panel.getByText("First comment", { exact: true }).waitFor();
    expect(await draft.inputValue()).toBe("Newer unsent comment");
    expect((await pal.changes.list(project.id, "normal", workspace.id)).comments).toMatchObject([
      { body: "First comment" },
    ]);
    expect(errors).toEqual([]);
  });

  it("retains an ignored-file draft without exposing it while ignored review is off", async () => {
    const { page, root, panel, errors } = await reviewFixture(1440);
    await writeFile(join(root, ".gitignore"), "private.secret\n");
    await writeFile(join(root, "private.secret"), "Private fixture excerpt\n");
    await panel.locator(".details > summary").click();
    const scope = panel.getByRole("checkbox", { name: "Include ignored files for review", exact: true });
    await scope.check();
    await panel.getByRole("button", { name: /private\.secret/ }).click();
    await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
    await panel.getByRole("textbox", { name: "Comment on line 1", exact: true }).fill("Private draft fixture");
    await scope.uncheck();
    await panel.getByText("Your ignored-file draft is kept.", { exact: false }).waitFor();
    expect(await panel.getByRole("textbox", { name: /Comment on line/ }).count()).toBe(0);
    expect(await panel.innerText()).not.toContain("Private fixture excerpt");
    expect(await panel.innerText()).not.toContain("Private draft fixture");
    await scope.check();
    expect(await panel.getByRole("textbox", { name: "Comment on line 1", exact: true }).inputValue()).toBe(
      "Private draft fixture",
    );
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await panel.getByRole("textbox", { name: /Comment on line/ }).count()).toBe(0);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  it("keeps a draft on its original file when another file is selected", async () => {
    const { pal, page, base, project, workspace, a, panel, errors } = await reviewFixture(1440);
    await panel.getByRole("button", { name: "Comment on line 1", exact: true }).click();
    await panel.getByRole("textbox", { name: "Comment on line 1", exact: true }).fill("Only about a.txt");
    await panel.getByRole("button", { name: /^b\.txt/ }).click();
    expect(await panel.getByRole("textbox", { name: "Comment on line 1", exact: true }).inputValue()).toBe(
      "Only about a.txt",
    );
    const [submitted] = await Promise.all([
      page.waitForResponse(`${base}/api/projects/${project.id}/comments`),
      panel.getByRole("button", { name: "Add comment", exact: true }).click(),
    ]);
    expect(submitted.status()).toBe(200);
    expect(submitted.request().postDataJSON()).toMatchObject({
      path: "a.txt",
      revision: a.revision,
      workspace: workspace.id,
    });
    expect((await pal.changes.list(project.id, "normal", workspace.id)).comments).toMatchObject([
      { path: "a.txt", body: "Only about a.txt" },
    ]);
    expect(errors).toEqual([]);
  });
});

describe("chat code rendering", () => {
  it.each([1440, 390])("keeps adversarial YAML/TOML responsive, escaped and intact at %s px", async (width) => {
    const { pal, page, base, saved, provider, errors } = await setup(width);
    const code = " ".repeat(100_000) + "x <img src=x onerror=alert(1)>&";
    const body = ["yaml", "toml"].map((language) => `\`\`\`${language}\n${code}\n\`\`\``).join("\n\n");
    const conversation = await pal.harness.conversation(saved.conversationId, context);
    if (conversation === undefined) throw new Error("missing fixture chat");
    await conversation.submit(
      { type: "write", entry: { kind: "pi.assistant", model: [fauxAssistantMessage(body)] } },
      context,
    );
    const started = Date.now();
    await page.goto(`${base}/#/chat/${saved.id}`);
    await expect.poll(() => page.locator(".code pre code").count()).toBe(2);
    await page.getByLabel("Message", { exact: true }).fill("Still responsive");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await page.locator(".code pre code").allTextContents()).toEqual([code, code]);
    expect(await page.locator(".code img").count()).toBe(0);
    await screenshot(page, `highlight-long-lines-${width}`);
    expect(provider.requests).toEqual([]);
    expect(errors).toEqual([]);
  });
});
