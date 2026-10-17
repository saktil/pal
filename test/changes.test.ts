import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { Changes } from "../src/core/changes.ts";
import { WorkspaceLocks } from "../src/core/execution.ts";
import { fileTools } from "../src/core/files.ts";
import { Projects } from "../src/core/projects.ts";
import { openStore } from "../src/storage/store.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  exec(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
    { cwd },
  );

async function setup(committed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-changes-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "pal-data");
  const store = await openStore(dataRoot);
  cleanups.push(() => store.close());
  await git(root, "init", "-q");
  await writeFile(join(root, "file.txt"), "before\n");
  await writeFile(join(root, "deleted.txt"), "old\n");
  if (committed) {
    await git(root, "add", "file.txt", "deleted.txt");
    await git(root, "commit", "-qm", "base");
  }
  const projects = await Projects.open({ database: store.database, dataRoot, installRoot: "/nonexistent-install" });
  const project = await projects.create("fixture-project", { name: "Repo", folder: root });
  const changes = new Changes(store.database, projects, dataRoot);
  return { root, dataRoot, store, projects, project, changes };
}

describe("revision-bound Git changes", () => {
  it("captures before file tools mutate, includes manual dirt and never moves the recorded baseline", async () => {
    const { root, dataRoot, store, projects, project, changes } = await setup();
    const head = (await git(root, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(root, "file.txt"), "manual edit\n");
    const locks = new WorkspaceLocks((root) => changes.capture(root));
    const tools = fileTools({ root: async () => root, deny: [dataRoot], locks });
    const write = tools.tools?.find((tool) => tool.name === "files_write") as ToolRegistration;
    const expectedHash = createHash("sha256").update("manual edit\n").digest("hex");
    await write.execute(
      { path: "file.txt", content: "after\n", expectedHash } as never,
      { conversationId: 1 as ConversationId } as ToolExecutionApi,
      context,
    );
    await writeFile(join(root, "new.txt"), "new\n");
    await unlink(join(root, "deleted.txt"));
    const first = await changes.list(project.id);
    expect(first.base).toBe(head);
    expect(first.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "deleted.txt", status: "D" },
      { path: "file.txt", status: "M" },
      { path: "new.txt", status: "A" },
    ]);
    expect(first.files.find((file) => file.path === "file.txt")?.patch).toContain("-before\n+after");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("after\n");
    await git(root, "add", "file.txt");
    await git(root, "commit", "-qm", "later");
    expect((await new Changes(store.database, projects, dataRoot).list(project.id)).base).toBe(head);
  });

  it("binds reviewed marks to bytes and rejects stale reviews, including after reopen", async () => {
    const { root, dataRoot, store, project, changes } = await setup();
    await writeFile(join(root, "file.txt"), "manual\n");
    const file = (await changes.list(project.id)).files[0];
    if (file === undefined) throw new Error("missing diff");
    expect(file.patch).toContain("+manual");
    await changes.review(project.id, file.path, file.revision, true);
    expect((await changes.list(project.id)).files[0]?.reviewed).toBe(true);
    await store.close();
    const reopened = await openStore(dataRoot);
    cleanups.push(() => reopened.close());
    const projects = await Projects.open({ database: reopened.database, dataRoot, installRoot: "/nonexistent" });
    const next = new Changes(reopened.database, projects, dataRoot);
    expect((await next.list(project.id)).files[0]?.reviewed).toBe(true);
    await writeFile(join(root, "file.txt"), "later\n");
    await expect(next.review(project.id, file.path, file.revision, true)).rejects.toMatchObject({
      status: 409,
      code: "changes_stale",
    });
    expect((await next.list(project.id)).files[0]?.reviewed).toBe(false);
    await projects.remove(project.id);
    await expect(next.list(project.id)).rejects.toMatchObject({ status: 404 });
  });

  it("never invokes repository clean filters, textconv, external diffs or hooks", async () => {
    const { root, project, changes } = await setup();
    const marker = join(root, "executed");
    for (const key of ["filter.evil.clean", "diff.evil.textconv", "diff.external", "core.fsmonitor"])
      await git(root, "config", key, `touch ${marker}`);
    await writeFile(join(root, ".gitattributes"), "*.txt filter=evil diff=evil\n");
    await writeFile(join(root, "file.txt"), "after\n");
    const result = await changes.list(project.id);
    expect(result.files.find((file) => file.path === "file.txt")?.patch).toContain("+after");
    await expect(access(marker)).rejects.toThrow();
  });

  it("shows unsupported bytes and links without reading Pal data or escaping the project", async () => {
    const { root, dataRoot, project, changes } = await setup();
    await writeFile(join(dataRoot, "private.txt"), "NEVER DISPLAY");
    await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "large"), "x".repeat(256 * 1024 + 1));
    await symlink(join(dataRoot, "private.txt"), join(root, "link"));
    const result = await changes.list(project.id);
    expect(result.files.map((file) => file.path)).toEqual(["binary", "large", "link"]);
    expect(result.files.every((file) => file.problem !== undefined && file.patch === "")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("NEVER DISPLAY");
    await expect(changes.review(project.id, "link", "", true)).rejects.toMatchObject({ status: 409 });
  });

  it("supports an unborn repository, bounds scans and does not invent a non-Git rollback", async () => {
    const { root, project, changes, projects } = await setup(false);
    expect((await changes.list(project.id)).files.every((file) => file.status === "A")).toBe(true);
    await Promise.all(Array.from({ length: 130 }, (_, i) => writeFile(join(root, `extra-${i}`), "x")));
    expect(await changes.list(project.id)).toMatchObject({ truncated: true });
    const folder = join(root, "nested");
    await mkdir(folder);
    const nested = await projects.create("nested-project", { name: "Nested", folder });
    expect(await changes.list(nested.id)).toMatchObject({ state: "unavailable", files: [] });
  });
});
