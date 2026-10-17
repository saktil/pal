import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { fileTools } from "../src/core/files.ts";
import { ProjectSearch, SearchError } from "../src/core/search.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function folder(files: Record<string, string | Buffer>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-search-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function searcher(deny: string[] = []): ProjectSearch {
  const search = new ProjectSearch(deny);
  cleanups.push(() => search.close());
  return search;
}

describe("project search", () => {
  it("finds exact text with lines and ranges, never turning zero matches into a guess", async () => {
    const root = await folder({
      "src/app.ts": "const x = 1;\nconsole.log('needle here');\n",
      "docs/guide.md": "# Guide\nA needle and another needle.\n",
      "image.bin": Buffer.from([0x00, 0x01, ...Buffer.from("needle")]),
    });
    const search = searcher();
    const text = await search.search(root, "needle", "text");
    expect(text.indexing).toBe(false);
    expect(text.hits.map(({ path, line }) => `${path}:${line}`).sort()).toEqual(["docs/guide.md:2", "src/app.ts:2"]);
    const guide = text.hits.find((hit) => hit.path === "docs/guide.md");
    expect(guide?.ranges?.map(([start, end]) => guide.text?.slice(start, end))).toEqual(["needle", "needle"]);
    expect((await search.search(root, "nedle", "text")).hits).toEqual([]);

    const regex = await search.search(root, "need(le)? and", "regex");
    expect(regex.hits.map((hit) => hit.path)).toEqual(["docs/guide.md"]);
    await expect(search.search(root, "(unclosed", "regex")).rejects.toThrow(/invalid regex/);

    expect((await search.search(root, "guide", "files")).hits.map((hit) => hit.path)).toContain("docs/guide.md");
    await expect(search.search(root, "  ", "text")).rejects.toBeInstanceOf(SearchError);
  });

  it("never indexes a folder holding Pal's data, but indexes a managed workspace inside it", async () => {
    const home = await folder({
      "notes.txt": "needle\n",
      "data/pal/credentials.key": "secret needle\n",
      "data/pal/projects/p1/workspace/a.txt": "needle\n",
    });
    const search = searcher([join(home, "data", "pal")]);
    await expect(search.search(home, "needle", "text")).rejects.toThrow(/contains Pal's own data/);
    expect(search.size).toBe(0);
    const workspace = join(home, "data", "pal", "projects", "p1", "workspace");
    expect((await search.search(workspace, "needle", "text")).hits.map((hit) => hit.path)).toEqual(["a.txt"]);
  });

  it("keeps at most three indexes and releases idle or forgotten ones", async () => {
    const roots = await Promise.all([1, 2, 3, 4].map((n) => folder({ [`f${n}.txt`]: `needle ${n}\n` })));
    const search = searcher();
    for (const root of roots) await search.search(root, "needle", "text");
    expect(search.size).toBe(3);
    await search.forget(roots[3] as string);
    expect(search.size).toBe(2);
    search.reclaim(Date.now() + 1);
    expect(search.size).toBe(0);
    // A reclaimed index is rebuilt on the next search.
    expect((await search.search(roots[0] as string, "needle", "text")).hits).toHaveLength(1);
  });

  it("serves the model's files_search tool from the same indexes, reporting zero matches plainly", async () => {
    const root = await folder({ "src/app.ts": "const x = 1;\nconsole.log('needle here');\n" });
    const search = searcher();
    const tools = fileTools({ root: async () => root, deny: [], search }).tools ?? [];
    const tool = tools.find((candidate) => candidate.name === "files_search") as ToolRegistration;
    const api = { conversationId: 1 as ConversationId } as ToolExecutionApi;
    const run = async (args: Record<string, unknown>) =>
      (await tool.execute(args as never, api, context)).output
        ?.map((block) => (block.type === "text" ? block.text : ""))
        .join("");
    expect(await run({ query: "needle" })).toBe("src/app.ts:2: console.log('needle here');");
    expect(await run({ query: "nedle" })).toBe("No matches.");
    expect(tool).toMatchObject({ callers: ["tools"], replay: "safe" });
    expect(
      fileTools({ root: async () => root, deny: [] }).tools?.some((candidate) => candidate.name === "files_search"),
    ).toBe(false);
  });
});
