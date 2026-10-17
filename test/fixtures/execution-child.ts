import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openPal } from "../../src/core/app.ts";
import type { ChatGPTEndpoints } from "../../src/pi/chatgpt.ts";
import { browse } from "./openai-server.ts";

const endpoints = JSON.parse(process.argv[3] ?? "null") as ChatGPTEndpoints;
const pal = await openPal({ dataRoot: process.argv[2] ?? "", installRoot: "/nonexistent-install", endpoints }, context);
const announced = Promise.withResolvers<string>();
const login = pal.chatgpt.signIn({
  signal: AbortSignal.timeout(5000),
  notify: (event) => {
    if (event.type === "auth_url") announced.resolve(event.url);
  },
  prompt: () => Promise.withResolvers<string>().promise,
});
login.catch(() => {});
await browse(await announced.promise);
await login;
await pal.settings.setModel("gpt-5.5");
const project = await pal.projects.create("recovery-project", { name: "Fixture" });
const chat = await pal.chats.createChat("recovery-chat", { projectId: project.id }, context);
console.log(JSON.stringify({ root: project.root, chatId: chat.id }));
await pal.chats.submit(chat.id, "recovery-input", { text: "run the fixture" }, context);
setInterval(() => {}, 1000);
