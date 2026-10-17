// Child process for chat recovery tests over Pal's real store and a faux model.
// `run <dataRoot> <barrier>` creates a chat and submits one input, SIGKILLing itself at the barrier;
// `inspect <dataRoot>` reopens, records what reconciliation completed, repeats both requests as a client retry
// would, and prints the state.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { type Barrier, ChatService } from "../../src/core/chats.ts";
import { openStore } from "../../src/storage/store.ts";

const [mode, dataRoot, crashAt] = process.argv.slice(2);
if (dataRoot === undefined) throw new Error("usage: chats-child.ts <run|inspect> <dataRoot> [barrier]");

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage(fauxText("ok"))));
const model = faux.getModel();

const store = await openStore(dataRoot);
const harness = await Harness.open(store.storage, { models, registry: createRegistry() }, context);
const chats = await ChatService.open(
  {
    database: store.database,
    harness,
    agentFor: async (projectId: string) =>
      projectId === "project-1" ? { model: { provider: model.provider, modelId: model.id } } : undefined,
    barrier: (point: Barrier) => {
      if (point === crashAt) process.kill(process.pid, "SIGKILL");
    },
  },
  context,
);
const rows = async () => ({
  chats: await store.database.all("SELECT id, state, conversation_id FROM pal_chats"),
  admissions: await store.database.all("SELECT chat_id, request_id, state, submission_id FROM pal_admissions"),
});
// What reconciliation alone completed, before any retry.
const reconciled = await rows();

const chat = await chats.createChat("chat-request-1", { projectId: "project-1", title: "Recovery" }, context);
const admission = await chats.submit(chat.id, "input-request-1", { text: "hello" }, context);
await harness.waitForIdle(context);

if (mode === "inspect") {
  const conversations = await store.storage.scanConversations({}, 100, undefined, context);
  const conversation = await harness.conversation(chat.conversationId, context);
  const { messages } = (await conversation?.context(context)) ?? { messages: [] };
  console.log(
    JSON.stringify({
      chat,
      admission,
      conversations: conversations.items.length,
      userMessages: messages.filter((message) => message.role === "user").length,
      reconciled,
      after: await rows(),
    }),
  );
}
await harness.close(context);
