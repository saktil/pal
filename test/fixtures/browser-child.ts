// A clicked page sends its external effect before returning, so the parent can SIGKILL before the native receipt.
import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { WebSocket } from "ws";
import { createApi } from "../../src/core/api.ts";
import { openPal } from "../../src/core/app.ts";
import { browserRuntime } from "../../src/core/browser.ts";
import { startServer } from "../../src/core/server.ts";

const [dataRoot = "", site = "", effect = ""] = process.argv.slice(2);
const runtime = browserRuntime();
if (runtime === undefined) throw new Error("no browser runtime");
const pal = await openPal(
  {
    dataRoot,
    installRoot: "/nonexistent-install",
    browser: {
      runtime: process.env.PAL_TEST_USER_SCOPE === "1" ? runtime : { ...runtime, scope: null },
      egress: { allowPrivate: true, ports: new Set([Number(site)]) },
    },
  },
  context,
);
const server = await startServer({
  host: "127.0.0.1",
  port: 0,
  version: "test",
  api: createApi(pal),
  upgrade: (request, socket, head) => pal.upgrade(request, socket, head),
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const token = await pal.owner.setup(pal.owner.setupToken, "correct horse battery");
const project = await pal.projects.create("browser-project", { name: "Fixture" });
const chat = await pal.chats.createChat("browser-chat", { projectId: project.id }, context);
const ws = new WebSocket(`${base.replace("http", "ws")}/api/projects/${project.id}/browser/socket`, {
  headers: { origin: base, cookie: `pal_session=${token}` },
});
let state:
  | { epoch: number; control: boolean; mode: string; tabs: { active: boolean; url: string; title?: string }[] }
  | undefined;
let parsed = false;
ws.on("message", (data, binary) => {
  if (binary) return;
  const message = JSON.parse(String(data));
  if (message.type === "state") state = message;
  if (message.type === "titles" && message.titles.some((tab: { title: string }) => tab.title === "Crash fixture"))
    parsed = true;
});
const until = async (done: () => boolean) => {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("browser child timed out");
    await sleep(20);
  }
};
await until(() => state?.control === true);
const url = `http://127.0.0.1:${site}/crash-page/${effect.split("/").at(-1)}`;
ws.send(JSON.stringify({ type: "navigate", epoch: state?.epoch, url }));
await until(() => state?.tabs.some((tab) => tab.active && tab.url === url) === true);
await until(() => parsed);
ws.send(JSON.stringify({ type: "handoff", epoch: state?.epoch, chat: chat.id, url }));
await until(() => state?.mode === "agent");
const faux = fauxProvider();
(pal.models as ReturnType<typeof createModels>).setProvider(faux.provider);
const model = faux.getModel();
const conversation = await pal.harness.conversation(chat.conversationId, context);
if (conversation === undefined) throw new Error("no fixture conversation");
await conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context);
const code =
  'const page = await tools.browser_observe({}); try { return await tools.browser_act({session:page.session,epoch:page.epoch,observation:page.observation,action:{type:"click",target:page.targets[0].id}}); } catch(error) { return String(error); }';
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
  fauxAssistantMessage("done"),
]);
await pal.chats.submit(chat.id, "browser-input", { text: "run fixture" }, context);
const deadline = Date.now() + 10_000;
for (;;) {
  const waiting = (await pal.approvals.view(chat.id)).approvals.find((item) => item.state === "pending");
  if (waiting !== undefined) {
    console.log(JSON.stringify({ chat: chat.id, project: project.id }));
    await pal.approvals.decide(chat.id, waiting.id, "approve", waiting.digest);
    break;
  }
  if (Date.now() > deadline)
    throw new Error(`no browser approval: ${JSON.stringify((await conversation.context(context)).messages)}`);
  await sleep(20);
}
setInterval(() => {}, 1000);
