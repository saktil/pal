import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { createPalCodemode } from "../src/pi/codemode.ts";
import { mcpTools } from "../src/pi/mcp-tools.ts";
import { openDatabase } from "../src/storage/sqlite.ts";
import { startMcpFixture } from "./fixtures/mcp-server.ts";

const SCRIPT = `
const found = await searchTools("fixture web", { namespace: "fixture" });
const { results } = await tools.mcp__fixture__search({ query: "durable agents" });
const titles = [];
for (const result of results.filter((result) => result.score >= 0.5)) {
  titles.push((await tools.mcp__fixture__fetch({ url: result.url })).split("\\n")[0]);
}
let missing;
try {
  await tools.mcp__fixture__fetch({ url: "https://fixture.invalid/missing" });
} catch (error) {
  missing = error.message;
}
return { found: found.map((tool) => tool.name).sort(), all: ALL_TOOLS.map((tool) => tool.name).sort(), titles, missing };
`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Code Mode over MCP", () => {
  it("lets a script discover and call only granted MCP tools through durable nested calls", async () => {
    const fixture = await startMcpFixture();
    cleanups.push(fixture.close);
    const client = new McpClient({ name: "pal", version: "0.0.0" });
    await client.connect(new StreamableHttpTransport({ url: fixture.url }));
    cleanups.push(() => client.close());
    const listed = await client.listTools();
    expect(listed.map((tool) => tool.name)).toEqual(["search", "fetch", "delete_everything"]);

    const granted = mcpTools("fixture", client, listed, new Set(["search", "fetch"]));
    const { extensions, sandbox } = createPalCodemode({
      allows: (_conversation, name) => granted.some((tool) => tool.name === name),
      namespaces: [{ name: "fixture", description: "Fixture web search", prefix: "mcp__fixture__" }],
    });
    cleanups.push(() => sandbox.close());
    const registry = createRegistry();
    registry.install(defineExtension({ name: "mcp", tools: granted }));
    for (const extension of extensions) registry.install(extension);

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: SCRIPT }), { stopReason: "toolUse" }),
      // A model that names an MCP tool directly must not reach the server.
      fauxAssistantMessage(fauxToolCall("mcp__fixture__search", { query: "direct" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    const dir = await mkdtemp(join(tmpdir(), "pal-codemode-test-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const storage = await SqliteStorage.open(await openDatabase(join(dir, "pal.sqlite")), { prefix: "pi_" });
    const harness = await Harness.open(storage, { models, registry }, context);
    cleanups.push(() => harness.close(context));
    const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });

    const agent = await root.agent(context);
    expect(agent.tools.map((tool) => tool.name)).toEqual(["codemode"]);
    expect(agent.callable.map((tool) => tool.name).sort()).toEqual(["mcp__fixture__fetch", "mcp__fixture__search"]);

    const submission = await root.submit({ type: "input", content: "Research durable agents" }, context);
    const settled = await submission.wait(context);
    expect(settled.status).toBe("done");

    const { messages } = await root.context(context);
    const results = messages.flatMap((message) => (message.role === "toolResult" ? [message] : []));
    expect(results.map((result) => [result.toolName, result.isError])).toEqual([
      ["codemode", false],
      ["mcp__fixture__search", true],
    ]);
    const output = results[0]?.content.map((block) => (block.type === "text" ? block.text : "")).join("\n") ?? "";
    expect(output).toContain('"titles":["Durable agents","Code Mode"]');
    expect(output).toContain('"found":["mcp__fixture__fetch","mcp__fixture__search"]');
    expect(output).toContain('"all":["mcp__fixture__fetch","mcp__fixture__search"]');
    expect(output).toMatch(/"missing":"[^"]*404 https:\/\/fixture.invalid\/missing/);
    expect(output).not.toContain("Unrelated");

    // The server saw exactly the script's calls: never the ungranted tool, never the direct model call.
    expect(fixture.calls.map((call) => [call.name, call.arguments])).toEqual([
      ["search", { query: "durable agents" }],
      ["fetch", { url: "https://fixture.invalid/durable" }],
      ["fetch", { url: "https://fixture.invalid/codemode" }],
      ["fetch", { url: "https://fixture.invalid/missing" }],
    ]);
  });
});
