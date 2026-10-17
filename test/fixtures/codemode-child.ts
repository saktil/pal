// Child process for code mode recovery tests: Pal's store and code mode policy over a parent-owned HTTP fixture.
// `start` admits one input whose script reads, writes and reads again, and runs until the parent kills it;
// `resume` reopens the same store, lets the Harness finish, and prints the tool results.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { createPalCodemode, DEFAULT_CODEMODE_CAPS } from "../../src/pi/codemode.ts";
import { openStore } from "../../src/storage/store.ts";

export const SCRIPT = `
const a = await tools.fx_read({ key: "a" });
let b;
try { b = await tools.fx_write({ key: "b" }); } catch (error) { b = "unknown: " + error.message; }
const c = await tools.fx_read({ key: "c" });
return { a, b, c };
`;

const [mode, dataRoot, service, heap] = process.argv.slice(2);
if (dataRoot === undefined || service === undefined) {
  throw new Error("usage: codemode-child.ts <start|resume> <dataRoot> <serviceUrl> [heapBytes]");
}

async function call(path: string, key: string, method: string): Promise<string> {
  const response = await fetch(`${service}/${path}?key=${key}`, { method });
  return await response.text();
}

const registry = createRegistry();
registry.install(
  defineExtension({
    name: "fixture",
    tools: [
      defineTool({
        name: "fx_read",
        description: "Read a fixture value",
        parameters: Type.Object({ key: Type.String() }),
        callers: ["tools"],
        replay: "safe",
        execute: async (args) => ({ output: [{ type: "text", text: await call("read", args.key, "GET") }] }),
      }),
      defineTool({
        name: "fx_write",
        description: "Mutate the fixture service",
        parameters: Type.Object({ key: Type.String() }),
        callers: ["tools"],
        execute: async (args) => ({ output: [{ type: "text", text: await call("write", args.key, "POST") }] }),
      }),
    ],
  }),
);
const { extensions, sandbox } = createPalCodemode({
  allows: () => true,
  caps: { ...DEFAULT_CODEMODE_CAPS, ...(heap === undefined ? {} : { memoryLimitBytes: Number(heap) }) },
});
for (const extension of extensions) registry.install(extension);

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// The resumed process only answers after the script: its first request comes after the tool result.
faux.setResponses([
  ...(mode === "start"
    ? [fauxAssistantMessage(fauxToolCall("codemode", { code: SCRIPT }), { stopReason: "toolUse" })]
    : []),
  fauxAssistantMessage(fauxText("Done.")),
]);

const store = await openStore(dataRoot);
const harness = await Harness.open(store.storage, { models, registry }, context);
const model = faux.getModel();
const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });

if (mode === "start") {
  await root.submit({ type: "input", content: "go", requestId: "recovery-1" }, context);
  harness.resume();
  setInterval(() => {}, 60_000);
} else if (mode === "resume") {
  harness.resume();
  await root.waitForIdle(context);
  const { messages } = await root.context(context);
  const results = messages.flatMap((message): ({ isError: boolean; text: string } | { answer: string })[] =>
    message.role === "toolResult"
      ? [
          {
            isError: message.isError,
            text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          },
        ]
      : message.role === "assistant"
        ? [{ answer: message.content.map((block) => (block.type === "text" ? block.text : "")).join("") }]
        : [],
  );
  console.log(JSON.stringify(results));
  await harness.close(context);
  await sandbox.close();
  await store.close();
} else {
  throw new Error(`unknown mode ${mode}`);
}
