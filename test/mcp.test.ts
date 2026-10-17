import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { createPalCodemode } from "../src/pi/codemode.ts";
import { type McpAuth, McpConfigError, McpManager, PRESETS } from "../src/pi/mcp.ts";
import { loadMasterKey, SqliteCredentialStore } from "../src/storage/credentials.ts";
import { openStore } from "../src/storage/store.ts";
import { startMcpFixture } from "./fixtures/mcp-server.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = await startMcpFixture();
  cleanups.push(fixture.close);
  const dataRoot = await mkdtemp(join(tmpdir(), "pal-mcp-test-"));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  cleanups.push(() => store.close());
  const credentials = new SqliteCredentialStore(
    store.database,
    await loadMasterKey(join(dataRoot, "credentials.key")),
    store.installationId,
  );
  const registry = createRegistry();
  // The policy closure exists before the manager it asks.
  const ref: { manager?: McpManager } = {};
  const codemode = createPalCodemode({ allows: (_conversation, name) => ref.manager?.allows(name) === true });
  cleanups.push(() => codemode.sandbox.close());
  for (const extension of codemode.extensions) registry.install(extension);
  const open = () =>
    McpManager.open({ database: store.database, credentials, registry, codemode: codemode.withNamespaces });
  const manager = await open();
  ref.manager = manager;
  cleanups.push(() => manager.close());
  const add = (auth: McpAuth = { kind: "none" }, url = fixture.url) =>
    manager.add({ name: "Fixture", url, auth, private: true });

  /** Run one model turn whose script is `code`, and return the script's result text. */
  async function script(code: string): Promise<string> {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    cleanups.push(() => harness.close(context));
    const model = faux.getModel();
    const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
    await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
    const { messages } = await root.context(context);
    const result = messages.find((message): message is ToolResultMessage => message.role === "toolResult");
    return result?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
  }

  return { fixture, store, credentials, registry, manager, open, add, script };
}

const tryCall = (call: string) => `try { return await ${call}; } catch (error) { return "error: " + error.message; }`;

describe("MCP connections", () => {
  it("seeds the Exa and Context7 presets once, disabled until the owner's first-run review", async () => {
    const { manager, open } = await setup();
    const servers = await manager.list();
    expect(servers.map(({ id, enabled, state }) => ({ id, enabled, state }))).toEqual([
      { id: "exa", enabled: false, state: "disabled" },
      { id: "context7", enabled: false, state: "disabled" },
    ]);
    // Exa's tools are pinned in the URL so a key cannot turn on its separate research agent.
    expect(servers[0]?.url).toBe("https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa");
    expect(servers[0]?.auth).toEqual({ kind: "header", header: "x-api-key" });
    expect(servers[1]?.auth).toEqual({ kind: "bearer" });
    expect(PRESETS.map((preset) => preset.tools)).toEqual([
      ["web_search_exa", "web_fetch_exa"],
      ["resolve-library-id", "query-docs"],
    ]);
    expect(await manager.reviewPending()).toBe(true);
    await manager.finishReview(false);
    await manager.setEnabled("context7", false);
    const reopened = await open();
    cleanups.push(() => reopened.close());
    expect(await reopened.reviewPending()).toBe(false);
    expect((await reopened.list()).map((server) => server.id)).toEqual(["exa", "context7"]);
  });

  it("keeps keys write-only and sends them only in the configured header", async () => {
    const { fixture, manager, add } = await setup();
    const header = await add({ kind: "header", header: "x-api-key" });
    const keyed = await manager.setKey(header.id, "secret-key-123");
    expect(keyed.keyConfigured).toBe(true);
    expect(JSON.stringify(await manager.list())).not.toContain("secret-key-123");
    await manager.test(header.id);
    expect(fixture.requests.at(-1)?.headers["x-api-key"]).toBe("secret-key-123");
    expect(fixture.requests.every((request) => !request.path.includes("secret"))).toBe(true);

    const bearer = await add({ kind: "bearer" });
    await manager.setKey(bearer.id, "secret-bearer-456");
    await manager.test(bearer.id);
    expect(fixture.requests.at(-1)?.headers.authorization).toBe("Bearer secret-bearer-456");
    expect((await manager.setKey(bearer.id, null)).keyConfigured).toBe(false);
  });

  it("tests without calling tools; scripts reach only approved tools of enabled servers", async () => {
    const { fixture, manager, add, script } = await setup();
    const server = await add();
    const tested = await manager.test(server.id);
    expect(tested).toMatchObject({ enabled: false, state: "ready" });
    expect(tested.tools.map((tool) => [tool.name, tool.approved])).toEqual([
      ["search", false],
      ["fetch", false],
      ["delete_everything", false],
    ]);
    expect(fixture.calls).toEqual([]);

    await manager.approve(server.id, ["search", "fetch"]);
    // Approved but not enabled: the tool is not installed, so the script cannot call it.
    expect(await script(tryCall(`tools.mcp__${server.id}__search({ query: "x" })`))).toMatch(/error: /);
    await manager.setEnabled(server.id, true);
    const output = await script(`
      const found = await tools.mcp__${server.id}__search({ query: "durable" });
      let destroy;
      try { destroy = await tools.mcp__${server.id}__delete_everything({}); } catch (error) { destroy = "error: " + error.message; }
      return { first: found.results[0].title, destroy };
    `);
    expect(output).toContain('"first":"Durable agents"');
    expect(output).toMatch(/"destroy":"error: /);
    expect(fixture.calls.map((call) => call.name)).toEqual(["search"]);
    expect((await manager.get(server.id)).state).toBe("ready");
  });

  it("stops a running script's next call once the server is disabled", async () => {
    const { fixture, manager, add, script } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search", "fetch"]);
    await manager.setEnabled(server.id, true);
    let disabling: Promise<unknown> | undefined;
    fixture.state.beforeCall = async (call) => {
      if (call.name === "search") await (disabling = manager.setEnabled(server.id, false));
    };
    // Disabling closes the connection, so the call in flight may end too; the next one never reaches the server.
    const output = await script(`
      let first, second;
      try { first = (await tools.mcp__${server.id}__search({ query: "x" })).results.length; } catch (error) { first = "error"; }
      try { second = await tools.mcp__${server.id}__fetch({ url: "https://fixture.invalid/durable" }); }
      catch (error) { second = "error: " + error.message; }
      return { first, second };
    `);
    expect(output).toMatch(/"second":"error: [^"]*not granted/);
    expect(fixture.calls.map((call) => call.name)).toEqual(["search"]);
    await disabling;
  });

  it("refuses a tool the server now describes differently until it is approved again", async () => {
    const { fixture, manager, add, script } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search"]);
    await manager.setEnabled(server.id, true);
    const search = fixture.state.tools[0];
    if (search === undefined) throw new Error("fixture has no tools");
    (search.inputSchema as { properties: Record<string, unknown> }).properties = {
      query: { type: "string" },
      everything: { type: "boolean" },
    };
    const changed = await manager.test(server.id);
    expect(changed.state).toBe("changed");
    expect(changed.tools.find((tool) => tool.name === "search")?.changed).toBe(true);
    expect(await script(tryCall(`tools.mcp__${server.id}__search({ query: "x" })`))).toMatch(/error: .*not granted/);
    expect(fixture.calls).toEqual([]);

    await manager.approve(server.id, ["search"]);
    expect(await script(tryCall(`tools.mcp__${server.id}__search({ query: "x" })`))).not.toMatch(/error: /);
    expect(fixture.calls.map((call) => call.name)).toEqual(["search"]);
  });

  it("enforces HTTPS, public addresses and no redirects for public endpoints", async () => {
    const { fixture, manager } = await setup();
    const add = (url: string, isPrivate = false) =>
      manager.add({ name: "Remote", url, auth: { kind: "none" }, private: isPrivate });
    await expect(add("http://example.com/mcp")).rejects.toBeInstanceOf(McpConfigError);
    await expect(add("https://user:pass@example.com/mcp")).rejects.toBeInstanceOf(McpConfigError);

    // Names and literals that reach this machine are refused before any request is sent.
    for (const url of [`https://localhost:${fixture.port}/mcp`, `https://127.0.0.1:${fixture.port}/mcp`]) {
      const server = await add(url);
      const tested = await manager.test(server.id);
      expect(tested.state).toBe("blocked");
    }
    expect(fixture.requests).toEqual([]);

    // A redirect is refused rather than followed, so a key could not travel with it.
    const redirected = await add(`http://127.0.0.1:${fixture.port}/redirect`, true);
    expect(await manager.test(redirected.id)).toMatchObject({
      state: "blocked",
      detail: expect.stringMatching(/redirect/),
    });
    expect(fixture.requests.map((request) => request.path)).toEqual(["/redirect"]);
  });

  it("reports rate limits and missing keys as states", async () => {
    const { fixture, manager, add } = await setup();
    const server = await add();
    fixture.state.status = 429;
    expect(await manager.test(server.id)).toMatchObject({ state: "rate_limited", detail: "forced 429" });
    fixture.state.status = 401;
    expect(await manager.test(server.id)).toMatchObject({
      state: "key_required",
      detail: "This server needs an API key.",
    });
  });

  it("clears approvals and disables a server whose endpoint changes", async () => {
    const { fixture, manager, add } = await setup();
    const server = await add();
    await manager.test(server.id);
    await manager.approve(server.id, ["search"]);
    await manager.setEnabled(server.id, true);
    const moved = await manager.update(server.id, {
      name: "Fixture",
      url: `${fixture.url}?v=2`,
      auth: { kind: "none" },
      private: true,
    });
    expect(moved.enabled).toBe(false);
    expect(moved.tools.filter((tool) => tool.approved)).toEqual([]);
    await expect(
      manager.update("exa", { name: "Exa", url: "https://evil.example/mcp", auth: { kind: "none" }, private: false }),
    ).rejects.toBeInstanceOf(McpConfigError);
  });
});
