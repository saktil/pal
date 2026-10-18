// A Pal process with one Ask-mode command waiting, or approved and dispatched, for the parent to SIGKILL.
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { openPal } from "../../src/core/app.ts";

const [dataRoot = "", command = "", approve = ""] = process.argv.slice(2);
const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install" }, context);
const faux = fauxProvider();
(pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
const project = await pal.projects.create("approval-project", { name: "Fixture" });
const chat = await pal.chats.createChat("approval-chat", { projectId: project.id }, context);
const conversation = await pal.harness.conversation(chat.conversationId, context);
if (conversation === undefined) throw new Error("fixture conversation missing");
const model = faux.getModel();
await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
const code = `return await tools.shell_run({ command: ${JSON.stringify(command)}, timeout: 30 });`;
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
  fauxAssistantMessage("done"),
]);
await pal.chats.submit(chat.id, "approval-input", { text: "run the fixture" }, context);
for (;;) {
  const waiting = (await pal.approvals.view(chat.id)).approvals.find((approval) => approval.state === "pending");
  if (waiting !== undefined) {
    if (approve === "approve") await pal.approvals.decide(chat.id, waiting.id, "approve", waiting.digest);
    console.log(JSON.stringify({ root: project.root, chatId: chat.id, approval: waiting.id }));
    break;
  }
  await sleep(20);
}
setInterval(() => {}, 1000);
