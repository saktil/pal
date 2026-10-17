// The built UI in Chromium against the real server, with ChatGPT replaced by the loopback OpenAI fixture.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
  const server = await startServer({ host: "127.0.0.1", port: 0, version: "e2e", webRoot, api: createApi(pal) });
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  cleanups.push(() => browser.close());
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
});
