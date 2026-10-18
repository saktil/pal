// SIGKILL after Git registered the worktree, before the host records readiness.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeFiles, type WorktreeIntent } from "../../src/core/worktree-files.ts";

const [root, journal] = process.argv.slice(2);
if (root === undefined || journal === undefined) throw new Error("usage: worktree-child <root> <journal>");
const intent = JSON.parse(await readFile(journal, "utf8")) as WorktreeIntent;
const dataRoot = join(root, "data");
const files = new WorktreeFiles(dataRoot, [dataRoot, "/nonexistent-install", "/nix/store"]);
await files.provision(intent, AbortSignal.timeout(30_000), async (identity) => {
  intent.identity = identity;
  await writeFile(journal, JSON.stringify(intent));
  console.log(JSON.stringify({ registered: true }));
  setInterval(() => {}, 60_000);
  await new Promise<never>(() => {});
});
