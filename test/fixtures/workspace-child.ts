import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openPal } from "../../src/core/app.ts";
import { WorktreeFiles } from "../../src/core/worktree-files.ts";

const [root, phase] = process.argv.slice(2);
if (root === undefined || phase === undefined) throw new Error("usage: workspace-child <root> <phase>");
const pal = await openPal({ dataRoot: join(root, "data"), installRoot: "/nonexistent-install" }, context);
const project = (await pal.projects.list())[0];
if (project === undefined) throw new Error("fixture project missing");
const chat = await pal.chats.createChat(`recovery-${phase}`, { projectId: project.id, workspace: "worktree" }, context);
const pause = async () => {
  console.log(JSON.stringify({ phase, chatId: chat.id }));
  setInterval(() => {}, 60_000);
  await new Promise<never>(() => {});
};
if (phase === "recorded") await pause();
const provision = WorktreeFiles.prototype.provision;
WorktreeFiles.prototype.provision = async function (intent, signal, record, check) {
  const identity = await provision.call(
    this,
    intent,
    signal,
    async (identity) => {
      if (phase === "registered") await pause();
      await record(identity);
      if (phase === "identified") await pause();
    },
    check,
  );
  if (phase === "materialized") await pause();
  return identity;
};
await pal.workspaces.provision(chat.id);
if (phase === "ready") await pause();
throw new Error("fixture phase was not reached");
