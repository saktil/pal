// The built UI in Chromium against the real server, with ChatGPT replaced by the loopback OpenAI fixture.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../src/core/api.ts";
import { openPal, type Pal } from "../../src/core/app.ts";
import { startServer } from "../../src/core/server.ts";
import { startMcpFixture } from "../fixtures/mcp-server.ts";
import { browse, startOpenAIFixture } from "../fixtures/openai-server.ts";

const webRoot = join(import.meta.dirname, "..", "..", "dist", "public");
const exec = promisify(execFile);
/** Where to save screenshots for design review; unset, none are kept. */
const shots = process.env.PAL_E2E_SCREENSHOTS;

let fixture: Awaited<ReturnType<typeof startOpenAIFixture>>;
let mcp: Awaited<ReturnType<typeof startMcpFixture>>;
let pal: Pal;
let dataRoot: string;
let base: string;
let browser: Browser;
let page: Page;
let chatUrl: string;
const cleanups: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  fixture = await startOpenAIFixture();
  cleanups.push(fixture.close);
  mcp = await startMcpFixture();
  cleanups.push(mcp.close);
  dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-e2e-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  pal = await openPal({ dataRoot, installRoot: "/nonexistent-install", endpoints: fixture.endpoints }, context);
  cleanups.push(() => pal.close());
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    version: "e2e",
    webRoot,
    api: createApi(pal),
    upgrade: (request, socket, head) => pal.terminals.upgrade(request, socket, head),
  });
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  cleanups.push(() => browser.close());
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // A private-network HTTP page lacks randomUUID, but must still be able to create projects and send messages.
  await page.addInitScript(() => Object.defineProperty(crypto, "randomUUID", { value: undefined }));
  if (shots !== undefined) await mkdir(shots, { recursive: true });
});

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function shoot(name: string): Promise<void> {
  if (shots !== undefined) await page.screenshot({ path: join(shots, `${name}.png`) });
}

describe("Pal in a browser", () => {
  it("refuses to start without the terminal's setup link, then sets up the owner from it", async () => {
    await page.goto(base);
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
    await expect.poll(() => page.getByRole("heading", { name: "Pal isn't set up yet" }).count()).toBe(1);
    await page.goto(`${base}/#setup=${pal.owner.setupToken}`);
    await page.getByLabel("Passphrase", { exact: true }).fill("correct horse battery");
    await page.getByLabel("Confirm passphrase").fill("correct horse battery");
    await shoot("setup-1440");
    await page.getByRole("button", { name: "Create owner" }).click();
    await page.getByRole("heading", { name: "Welcome to Pal" }).waitFor();
    // The token leaves the address bar once used; projects cannot precede sign-in.
    expect(page.url()).not.toContain("setup=");
    expect(await page.getByRole("button", { name: "Create project" }).count()).toBe(0);
    await page.reload();
    await page.getByRole("button", { name: "Sign in with ChatGPT" }).waitFor();
    await shoot("onboarding-1440");
  });

  it("connects ChatGPT before offering internet tools or projects", async () => {
    await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
    const link = page.getByRole("link", { name: "Open ChatGPT sign-in" });
    const authUrl = await link.getAttribute("href");
    if (authUrl === null) throw new Error("no sign-in link");
    await shoot("chatgpt-waiting-1440");
    // The owner's own browser completes sign-in on ChatGPT and lands on the server's callback.
    await browse(authUrl);
    await page.getByText("Enable internet tools?").waitFor();
    expect(await page.getByRole("button", { name: "Create project" }).count()).toBe(0);
    await shoot("onboarding-internet-1440");
  });

  it("reviews internet tools, then creates the first project and chats", async () => {
    await page.getByRole("button", { name: "Not now" }).click();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    expect((await pal.mcp.list()).every((server) => !server.enabled)).toBe(true);
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByLabel("Project name").fill("Notes");
    await shoot("create-project-1440");
    await page.getByRole("dialog", { name: "Create project" }).getByRole("button", { name: "Create project" }).click();
    await page.getByRole("heading", { name: "Start the conversation" }).waitFor();
    chatUrl = page.url();
    await page.getByLabel("Message").fill("hi");
    await page.getByRole("button", { name: "Send" }).click({ timeout: 3000 });
    await page.getByText("Hello").waitFor();
    await page.getByRole("heading", { name: "hi" }).waitFor();
    await shoot("chat-1440");
  });

  it("keeps reasoning effort for this chat across reload and sends it to the model", async () => {
    await page.getByRole("button", { name: "Choose model" }).click();
    const high = page
      .getByRole("radiogroup", { name: "Reasoning effort" })
      .getByRole("radio", { name: "High", exact: true });
    await high.click();
    await expect.poll(() => high.getAttribute("aria-checked")).toBe("true");
    await page.reload();
    await page.getByRole("button", { name: "Choose model" }).click();
    await expect.poll(() => high.getAttribute("aria-checked")).toBe("true");
    await shoot("reasoning-1440");
    await page.getByRole("button", { name: "Choose model" }).click();
    await page.getByLabel("Message").fill("reason carefully");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.getByText("Hello", { exact: true }).count()).toBe(2);
    expect(fixture.apiRequests.filter((call) => call.path === "/v1/responses").at(-1)?.body.reasoning).toMatchObject({
      effort: "high",
    });
  });

  it("explains the usage limit instead of retrying", async () => {
    fixture.behavior.responses = "usage_limit";
    await page.getByLabel("Message").fill("again");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("ChatGPT usage limit reached.").waitFor();
    fixture.behavior.responses = "ok";
  });

  it("adds a private MCP server, approves its tools, and a chat script calls them", async () => {
    await page.goto(`${base}/#/settings/mcp`);
    await page.getByRole("button", { name: "Add server" }).click();
    await page.getByLabel("Name").fill("Fixture");
    await page.getByLabel("URL").fill(mcp.url);
    await page.getByLabel(/Private endpoint/).check();
    await page.getByRole("button", { name: "Add and test" }).click();
    await page.getByRole("checkbox", { name: /^search/ }).check();
    await page.getByRole("checkbox", { name: /^fetch/ }).check();
    await page.getByRole("button", { name: "Approve selected tools" }).click();
    await page.getByRole("switch", { name: "Enable Fixture" }).check();
    await page.getByText("Ready", { exact: true }).waitFor();
    // Testing and approving never called a tool.
    expect(mcp.calls).toEqual([]);
    await shoot("settings-mcp-1440");
    await page.getByRole("button", { name: /^Context7/ }).click();
    const routing = page.getByRole("checkbox", { name: "Allow fake-IP routing for Context7" });
    await routing.check();
    await expect.poll(async () => (await pal.mcp.get("context7")).fakeIp).toBe(true);
    expect((await pal.mcp.get("context7")).enabled).toBe(false);
    await routing.uncheck();
    await expect.poll(async () => (await pal.mcp.get("context7")).fakeIp).toBe(false);

    const server = (await pal.mcp.list()).find((candidate) => candidate.name === "Fixture");
    fixture.behavior.responses = "script";
    fixture.behavior.script = `return (await tools.mcp__${server?.id}__search({ query: "durable" })).results[0].title;`;
    await page.goto(chatUrl);
    await page.getByLabel("Message").fill("research durable agents");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: /Ran a script/ }).click();
    await page.getByText(`${server?.id} · search`).waitFor();
    // The model answers once the script's result is back; the run ends instead of looping.
    await page.getByText("Hello").last().waitFor();
    await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
    expect(mcp.calls.map((call) => call.name)).toEqual(["search"]);
    await shoot("chat-mcp-1440");
    fixture.behavior.responses = "ok";
  });

  it("narrows project internet tools, rejects stale settings and fits every viewport", async () => {
    const project = (await pal.projects.list())[0];
    const server = (await pal.mcp.list()).find((candidate) => candidate.name === "Fixture");
    if (project === undefined || server === undefined) throw new Error("missing project or server");
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    const button = page.getByRole("button", { name: "Project internet tools" });
    const dialog = page.getByRole("dialog", { name: "Internet tools", exact: true });
    const card = dialog.getByRole("region", { name: "Fixture project permissions" });
    await button.click();
    await card.getByLabel("Permissions for Fixture").selectOption("subset");
    await card.getByRole("checkbox", { name: /^fetch/ }).uncheck();
    await card.getByRole("button", { name: "Save Fixture project permissions" }).click();
    await expect.poll(async () => (await pal.mcp.grants.decision(project.id, server.id, "fetch")).allowed).toBe(false);
    await dialog.getByRole("button", { name: "Close project internet tools" }).click();
    await page.reload();
    await button.click();
    await expect.poll(() => card.getByLabel("Permissions for Fixture").inputValue()).toBe("subset");
    expect(await card.getByRole("checkbox", { name: /^search/ }).isChecked()).toBe(true);
    expect(await card.getByRole("checkbox", { name: /^fetch/ }).isChecked()).toBe(false);
    expect(await dialog.getByRole("region", { name: "Context7 project permissions" }).innerText()).toContain(
      "Owner disabled",
    );

    // A second owner tab changes the saved selection while this dialog keeps its reviewed snapshot.
    const current = (await pal.mcp.grants.view(project.id)).servers.find((candidate) => candidate.id === server.id);
    if (current === undefined) throw new Error("missing grant");
    await pal.mcp.grants.set(project.id, server.id, { revision: current.revision, mode: "subset", tools: [] });
    await card.getByRole("button", { name: "Save Fixture project permissions" }).click();
    await dialog.getByRole("alert").filter({ hasText: "Refresh before saving" }).waitFor();
    await dialog.getByRole("button", { name: "Refresh permissions" }).click();
    await expect.poll(() => card.getByRole("checkbox", { name: /^search/ }).isChecked()).toBe(false);
    await card.getByRole("checkbox", { name: /^search/ }).check();
    await card.getByRole("button", { name: "Save Fixture project permissions" }).click();
    await expect.poll(async () => (await pal.mcp.grants.decision(project.id, server.id, "search")).allowed).toBe(true);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await card.scrollIntoViewIfNeeded();
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await card.locator("label.fl").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(
        100,
      );
      await shoot(`project-mcp-${width}`);
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await button.evaluate((element) => element.matches(":focus"))).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await button.click();
    await card.getByLabel("Permissions for Fixture").selectOption("inherit");
    await card.getByRole("button", { name: "Save Fixture project permissions" }).click();
    await expect.poll(async () => (await pal.mcp.grants.decision(project.id, server.id, "fetch")).allowed).toBe(true);
    await expect
      .poll(() => dialog.getByRole("button", { name: "Close project internet tools" }).isEnabled())
      .toBe(true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("complementary", { name: "Workspace panel" }).waitFor();
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    expect(errors).toEqual([]);
    page.off("pageerror", onError);
  });

  it("uploads from this device and lets a script read the project folder", async () => {
    await page.locator('input[type="file"]').setInputFiles({
      name: "plan.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("The launch is on Tuesday."),
    });
    await page.getByRole("button", { name: "Remove plan.txt" }).waitFor();
    fixture.behavior.responses = "script";
    fixture.behavior.script = "return await tools.files_list({});";
    await page.getByLabel("Message").fill("what is in the project?");
    await page.getByRole("button", { name: "Send" }).click();
    // The sent message shows its attachment; the upload reached the model with it.
    await page.locator(".user .chip").filter({ hasText: "plan.txt" }).waitFor();
    await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
    const sent = fixture.apiRequests.filter((call) => call.path === "/v1/responses");
    expect(JSON.stringify(sent.map((call) => call.body.input))).toContain("The launch is on Tuesday.");
    await page
      .getByRole("button", { name: /Ran a script/ })
      .last()
      .click();
    await page.getByText("files_list", { exact: true }).waitFor();
    await shoot("chat-upload-1440");
    fixture.behavior.responses = "ok";
  });

  it("writes a project file and shows a real host command receipt through Code Mode", async () => {
    const projectBefore = (await pal.projects.list())[0];
    if (projectBefore === undefined) throw new Error("missing project");
    await exec("git", ["init", "-q"], { cwd: projectBefore.root });
    await writeFile(join(projectBefore.root, "base.txt"), "original\n");
    await exec("git", ["add", "base.txt"], { cwd: projectBefore.root });
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "base",
      ],
      { cwd: projectBefore.root },
    );
    fixture.behavior.responses = "script";
    fixture.behavior.script =
      'await tools.files_write({ path: "host.txt", content: "before\\n", expectedHash: null }); return await tools.shell_run({ command: "printf after >> host.txt; printf host-output", timeout: 2 });';
    await page.getByLabel("Message").fill("write and test the file");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Exit 0", { exact: true }).waitFor();
    await page.locator("summary").filter({ hasText: "Host command" }).click();
    await page.getByText("host-output", { exact: true }).waitFor();
    await page.getByRole("status").filter({ hasText: "Running" }).waitFor({ state: "detached" });
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    expect(await readFile(join(project.root, "host.txt"), "utf8")).toBe("before\nafter");
    const chat = (await pal.chats.list(project.id))[0];
    if (chat === undefined) throw new Error("missing chat");
    const agent = await (await pal.harness.conversation(chat.conversationId, context))?.agent(context);
    expect(agent?.tools.map((tool) => tool.name)).toEqual(["codemode"]);
    for (const name of ["files_write", "files_edit", "shell_run"])
      expect(agent?.callable.find((tool) => tool.name === name)).toMatchObject({
        replay: "unsafe",
        callers: ["tools"],
      });
    await shoot("host-command-1440");
    fixture.behavior.responses = "ok";
  });

  it("reviews actual Git diffs, rejects stale marks and fits desktop, tablet and phone", async () => {
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace panel" });
    await panel.getByRole("button", { name: /host.txt/ }).click();
    await panel.getByLabel("File diff").filter({ hasText: "+before" }).waitFor();
    await panel.getByRole("button", { name: "Mark reviewed" }).click();
    await expect
      .poll(() => panel.getByRole("button", { name: "Reviewed", exact: true }).getAttribute("aria-pressed"))
      .toBe("true");
    await page.reload();
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await panel.getByRole("button", { name: /host.txt/ }).click();
    await panel.getByRole("button", { name: "Reviewed", exact: true }).waitFor();
    await writeFile(join(project.root, "host.txt"), "manual edit\n");
    await panel.getByRole("button", { name: "Reviewed", exact: true }).click();
    await panel
      .getByRole("alert")
      .filter({ hasText: /file changed/ })
      .waitFor();
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await panel.getByLabel("File diff").filter({ hasText: "+manual edit" }).waitFor();
    await panel.getByRole("button", { name: "Mark reviewed" }).waitFor();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await shoot(`changes-${width}`);
    }
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    await page.getByLabel("Message").waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it("reattaches a real human shell on a phone, transfers control and shares only selected output", async () => {
    const project = (await pal.projects.list())[0];
    if (project === undefined) throw new Error("missing project");
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    const modelRequests = fixture.apiRequests.length;
    expect(await pal.terminals.list(project.id)).toEqual([]);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace panel" });
    await panel.getByText(/No terminal sessions/).waitFor();
    expect(await pal.terminals.list(project.id)).toEqual([]);
    await panel.getByRole("checkbox", { name: /I understand/ }).check();
    await panel.getByRole("button", { name: "New host terminal" }).click();
    await panel.getByRole("status").filter({ hasText: "You control this shell" }).waitFor();
    await panel.getByLabel("Terminal input").focus();
    await page.keyboard.insertText("printf '\\033[2J\\033[Hterminal-live\\r\\n'; printf once >> terminal-count.txt");
    await page.keyboard.press("Enter");
    await expect.poll(() => panel.locator(".xterm-rows").innerText()).toContain("terminal-live");
    await expect.poll(() => readFile(join(project.root, "terminal-count.txt"), "utf8")).toBe("once");
    const id = (await pal.terminals.list(project.id))[0]?.id;
    await panel.getByRole("checkbox", { name: "Screen reader mode" }).check();
    await panel.getByLabel("Terminal input").pressSequentially("printf reader-ok", { delay: 15 });
    await page.keyboard.press("Enter");
    await expect.poll(() => panel.locator(".xterm-accessibility-tree").innerText()).toContain("reader-ok");
    await panel.getByRole("checkbox", { name: "Screen reader mode" }).uncheck();
    await shoot("terminal-1440");
    await panel.getByRole("button", { name: "Close panel", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "You control this shell" }).waitFor();
    await expect.poll(() => panel.locator(".xterm-rows").innerText()).toContain("terminal-live");
    expect((await pal.terminals.list(project.id))[0]?.id).toBe(id);
    expect(await page.getByLabel("Message").inputValue()).toBe("");

    const phoneContext = await browser.newContext({ storageState: await page.context().storageState() });
    const phone = await phoneContext.newPage();
    try {
      phone.on("pageerror", onError);
      await phone.setViewportSize({ width: 390, height: 844 });
      await phone.goto(chatUrl);
      await phone.getByRole("button", { name: "Terminal", exact: true }).click();
      const mobile = phone.getByRole("complementary", { name: "Workspace panel" });
      await mobile.getByRole("button", { name: "Take control" }).click();
      await mobile.getByRole("status").filter({ hasText: "You control this shell" }).waitFor();
      await panel.getByRole("button", { name: "Take control" }).waitFor();
      await expect.poll(async () => (await pal.terminals.list(project.id))[0]?.cols).toBeLessThan(60);
      await mobile
        .getByRole("toolbar", { name: "Terminal keys" })
        .getByRole("button", { name: "Esc", exact: true })
        .click();
      await mobile
        .getByRole("toolbar", { name: "Terminal keys" })
        .getByRole("button", { name: "Ctrl+C", exact: true })
        .click();
      await mobile.getByLabel("Terminal input").focus();
      await phone.keyboard.insertText("printf phone > phone.txt");
      await phone.keyboard.press("Enter");
      await expect.poll(() => readFile(join(project.root, "phone.txt"), "utf8")).toBe("phone");
      expect(await phone.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      if (shots !== undefined) await phone.screenshot({ path: join(shots, "terminal-390.png") });
      await mobile.getByRole("button", { name: "Select output", exact: true }).click();
      await mobile.getByRole("button", { name: "Send selection to composer" }).click();
      await expect.poll(() => phone.getByLabel("Message").inputValue()).toContain("terminal-live");
      expect(fixture.apiRequests.length).toBe(modelRequests);
      expect(await readFile(join(project.root, "terminal-count.txt"), "utf8")).toBe("once");
    } finally {
      await phoneContext.close();
    }
    await panel.getByRole("button", { name: "Take control" }).click();
    await page.setViewportSize({ width: 768, height: 1024 });
    await shoot("terminal-768");
    await panel.getByRole("button", { name: "Close terminal 1" }).click();
    await panel.getByText(/No terminal sessions/).waitFor();
    expect(await pal.terminals.list(project.id)).toEqual([]);
    expect(errors).toEqual([]);
    page.off("pageerror", onError);
    await panel.getByRole("button", { name: "Close panel", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it("clicks Send in a legacy chat created before ChatGPT sign-in", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pal-e2e-legacy-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const legacy = await openPal(
      { dataRoot: root, installRoot: "/nonexistent-install", endpoints: fixture.endpoints },
      context,
    );
    cleanups.push(() => legacy.close());
    const project = await legacy.projects.create("legacy-project", { name: "Legacy" });
    const chat = await legacy.chats.createChat("legacy-chat", { projectId: project.id }, context);
    const server = await startServer({ host: "127.0.0.1", port: 0, version: "e2e", webRoot, api: createApi(legacy) });
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const legacyPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    cleanups.push(() => legacyPage.close());
    await legacyPage
      .context()
      .addCookies([
        { name: "pal_session", value: await legacy.owner.setup(legacy.owner.setupToken, "correct horse battery"), url },
      ]);
    await legacyPage.goto(`${url}/#/chat/${chat.id}`);
    await legacyPage.getByLabel("Message").fill("hi");
    expect(await legacyPage.getByRole("button", { name: "Send" }).isDisabled()).toBe(true);
    await legacyPage.getByRole("button", { name: "Connect", exact: true }).click();
    await legacyPage.getByRole("button", { name: "Sign in with ChatGPT" }).click();
    const auth = await legacyPage.getByRole("link", { name: "Open ChatGPT sign-in" }).getAttribute("href");
    if (auth === null) throw new Error("no sign-in link");
    await browse(auth);
    await legacyPage.getByText("Signed in as").waitFor();
    await legacyPage.goto(`${url}/#/chat/${chat.id}`);
    await legacyPage.getByLabel("Message").fill("hi");
    await legacyPage.getByRole("button", { name: "Send" }).click({ timeout: 3000 });
    await legacyPage.getByText("Hello").waitFor();
    expect(
      (await (await legacy.harness.conversation(chat.conversationId, context))?.agent(context))?.model?.modelId,
    ).toBe("gpt-5.5");
  });

  it("lays out for tablet and phone", async () => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await shoot("chat-768");
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot("chat-390");
    await page.getByRole("button", { name: "Projects and chats" }).click();
    await page.getByRole("navigation", { name: "Projects" }).getByText("Notes").waitFor();
    await shoot("drawer-390");
  });

  it("confirms chat deletion and project removal, including cancel and Escape", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "New chat in Notes", exact: true }).click();
    await page.getByRole("heading", { name: "Start the conversation" }).waitFor();
    const removedChat = page.url();
    await page.getByRole("button", { name: "Delete chat New chat", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    expect(await dialog.getByRole("button", { name: "Cancel" }).evaluate((button) => button.matches(":focus"))).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("heading", { name: "Start the conversation" }).waitFor();
    await page.getByRole("button", { name: "Delete chat New chat", exact: true }).click();
    await dialog.getByRole("button", { name: "Delete chat", exact: true }).click();
    await page.getByRole("heading", { name: "Pick a chat" }).waitFor();
    expect((await page.request.get(`${base}/api/chats/${removedChat.split("/").at(-1)}`)).status()).toBe(404);
    await page.getByRole("button", { name: "Remove project Notes", exact: true }).click();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Remove project Notes", exact: true }).click();
    await shoot("remove-project-1440");
    await dialog.getByRole("button", { name: "Remove project", exact: true }).click();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Create your first project" }).waitFor();
    expect(await pal.projects.list()).toEqual([]);
  });
});
