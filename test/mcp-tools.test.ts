import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { createPalCodemode } from "../src/pi/codemode.ts";
import { mcpTools } from "../src/pi/mcp-tools.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Exa's actual web_search_exa input schema shape (2026-10-18): both query and objective required, nothing else. */
const SEARCH = {
  remote: "web_search_exa",
  description: "Search the web",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, objective: { type: "string", description: "Goal for this search." } },
    required: ["query", "objective"],
    additionalProperties: false,
  },
};

async function run(defaults: Record<string, Record<string, string>>) {
  const received: Record<string, unknown>[] = [];
  const connection = {
    call: async (_remote: string, args: Record<string, unknown>) => {
      received.push(args);
      return { content: [{ type: "text" as const, text: "result" }] };
    },
  };
  const { extensions, sandbox } = createPalCodemode({ allows: () => true });
  cleanups.push(() => sandbox.close());
  const registry = createRegistry();
  registry.install(defineExtension({ name: "mcp", tools: mcpTools("exa", connection, [SEARCH], "safe", defaults) }));
  for (const extension of extensions) registry.install(extension);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const code = `try { return await tools.mcp__exa__web_search_exa({ query: "Citami Sinaga" }); } catch (error) { return "ERROR: " + error.message; }`;
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
  const result = messages.find((message) => message.role === "toolResult");
  const output =
    result?.role === "toolResult" ? result.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
  return { received, output };
}

describe("MCP tool argument defaults", () => {
  it("fills a reviewed preset's omitted required argument instead of failing validation", async () => {
    const { received, output } = await run({ web_search_exa: { objective: "query" } });
    expect(output).not.toContain("ERROR");
    expect(received).toEqual([{ query: "Citami Sinaga", objective: "Citami Sinaga" }]);
  });

  it("without a default, the call fails validation before reaching the server", async () => {
    const { received, output } = await run({});
    expect(output).toMatch(/ERROR: Validation failed[\s\S]*objective/);
    expect(received).toEqual([]);
  });
});
