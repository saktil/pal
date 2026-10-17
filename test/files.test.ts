import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { fileTools } from "../src/core/files.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A home-like folder holding Pal's data, a project inside it, and a secret outside the project. */
async function setup(root: "home" | "managed" = "home") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pal-files-test-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const dataRoot = join(home, ".local", "share", "pal");
  await mkdir(join(dataRoot, "projects", "p1", "workspace"), { recursive: true });
  await writeFile(join(dataRoot, "credentials.key"), "master key bytes");
  await writeFile(join(dataRoot, "projects", "p1", "workspace", "notes.md"), "managed notes\n");
  await mkdir(join(home, "repo", ".git"), { recursive: true });
  await mkdir(join(home, "repo", "src"), { recursive: true });
  await writeFile(join(home, "repo", "src", "main.ts"), "one\ntwo\nthree\nfour\n");
  await writeFile(join(home, "repo", "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await writeFile(join(home, "repo", ".git", "config"), "[core]\n");
  await writeFile(join(home, "secret.txt"), "not for the model");
  await symlink(join(home, "secret.txt"), join(home, "repo", "escape.txt"));
  const projectRoot = root === "home" ? home : join(dataRoot, "projects", "p1", "workspace");
  const extension = fileTools({ root: async () => projectRoot, deny: [dataRoot] });
  const tools = Object.fromEntries((extension.tools ?? []).map((tool) => [tool.name, tool]));
  const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools[name] as ToolRegistration;
    // The tools read only the calling conversation from their API.
    const api = { conversationId: 1 as ConversationId } as ToolExecutionApi;
    const result = await tool.execute(args as never, api, context);
    return result.output?.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
  };
  return { home, dataRoot, run };
}

describe("project file tools", () => {
  it("list, read by lines and find inside the project folder", async () => {
    const { run } = await setup();
    expect(await run("files_list", { path: "repo" })).toBe(".git/\nsrc/\nescape.txt\nimage.bin  4 bytes");
    expect(await run("files_read", { path: "repo/src/main.ts", offset: 2, limit: 2 })).toBe("2\ttwo\n3\tthree");
    expect(await run("files_read", { path: "repo/image.bin" })).toBe("repo/image.bin is a binary file of 4 bytes.");
    const found = await run("files_find", { query: "main" });
    expect(found).toBe("repo/src/main.ts");
    // Searches skip .git contents.
    expect(await run("files_find", { query: "config" })).toBe("No matches.");
  });

  it("refuses paths outside the folder, including through symlinks", async () => {
    const { run } = await setup("managed");
    expect(await run("files_read", { path: "notes.md" })).toBe("1\tmanaged notes\n2\t");
    await expect(run("files_read", { path: "../../../credentials.key" })).rejects.toThrow(/outside the project folder/);
    await expect(run("files_read", { path: "/etc/hosts" })).rejects.toThrow(/relative/);
  });

  it("follows a symlink only when its target stays inside the project", async () => {
    const { home, run } = await setup();
    // The home-folder project contains the link's target, so this read is inside it.
    expect(await run("files_read", { path: "repo/escape.txt" })).toBe("1\tnot for the model");
    const narrow = fileTools({ root: async () => join(home, "repo"), deny: [] });
    const read = (narrow.tools ?? []).find((tool) => tool.name === "files_read") as ToolRegistration;
    const api = { conversationId: 1 as ConversationId } as ToolExecutionApi;
    await expect(read.execute({ path: "escape.txt" } as never, api, context)).rejects.toThrow(
      /outside the project folder/,
    );
  });

  it("hides and refuses Pal's own data inside a broader project folder", async () => {
    const { run } = await setup();
    expect(await run("files_list", { path: ".local/share" })).toBe("(empty folder)");
    await expect(run("files_read", { path: ".local/share/pal/credentials.key" })).rejects.toThrow(/Pal's own files/);
    expect(await run("files_find", { query: "credentials" })).toBe("No matches.");
  });
});
