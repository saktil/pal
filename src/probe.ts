// Host capability checks for `pal probe`. Loaded only by that command, never by server startup.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { FileFinder } from "@ff-labs/fff-node";
import { spawn } from "node-pty";
import { openDatabase } from "./storage/sqlite.ts";

export type ProbeResult = { check: string; ok: boolean; detail: string };

export async function runProbes(): Promise<ProbeResult[]> {
  const dir = await mkdtemp(join(tmpdir(), "pal-probe-"));
  try {
    return [
      await probe("sqlite", () => probeSqlite(dir)),
      await probe("fff", () => probeFff(dir)),
      await probe("codemode", probeCodemode),
      await probe("pty", probePty),
    ];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probe(check: string, run: () => Promise<string>): Promise<ProbeResult> {
  try {
    return { check, ok: true, detail: await run() };
  } catch (error) {
    return { check, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function probeSqlite(dir: string): Promise<string> {
  const database = await openDatabase(join(dir, "probe.sqlite"));
  try {
    await database.exec("CREATE VIRTUAL TABLE notes USING fts5(body)");
    await database.run("INSERT INTO notes (body) VALUES (?), (?)", "durable agent harness", "unrelated text");
    const hits = await database.all<{ body: string }>("SELECT body FROM notes WHERE notes MATCH ?", "harness");
    if (hits.length !== 1 || hits[0]?.body !== "durable agent harness") {
      throw new Error(`FTS5 MATCH returned ${JSON.stringify(hits)}`);
    }
    const version = await database.get<{ version: string }>("SELECT sqlite_version() AS version");
    return `SQLite ${version?.version}; exclusive WAL, synchronous=FULL, fullfsync, FTS5 MATCH`;
  } finally {
    await database.close();
  }
}

async function probeFff(dir: string): Promise<string> {
  const root = join(dir, "workspace");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "needle-finder.ts"), "export const needle = 1;\n");
  await writeFile(join(root, "README.md"), "# probe\n");

  // No frecency/history database paths and no watcher: the probe leaves nothing behind.
  const created = FileFinder.create({ basePath: root, disableWatch: true, aiMode: true });
  if (!created.ok) throw new Error(`create failed: ${created.error}`);
  const finder = created.value;
  try {
    const scanned = await finder.waitForScan(10_000);
    if (!scanned.ok || !scanned.value) throw new Error("initial scan did not finish within 10 s");
    const search = finder.fileSearch("needle");
    if (!search.ok) throw new Error(`search failed: ${search.error}`);
    const paths = search.value.items.map((item) => item.relativePath);
    if (!paths.some((path) => path.endsWith("needle-finder.ts"))) {
      throw new Error(`search missed the fixture file: ${JSON.stringify(paths)}`);
    }
  } finally {
    finder.destroy();
  }
  if (!finder.isDestroyed) throw new Error("finder was not destroyed");
  return "index, search and destroy";
}

async function probeCodemode(): Promise<string> {
  const sandbox = new CodemodeSandbox({
    timeoutMs: 10_000,
    memoryLimitBytes: 32 * 1024 * 1024,
    tools: [
      {
        name: "add",
        execute: (args) => {
          const { a, b } = args as { a: number; b: number };
          return a + b;
        },
      },
    ],
  });
  try {
    const result = await sandbox.execute("return await tools.add({ a: 2, b: 3 });");
    if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);
    if (result.value !== 5) throw new Error(`script returned ${JSON.stringify(result.value)}`);
    return "QuickJS WASM worker ran a script that called a host tool";
  } finally {
    await sandbox.close();
  }
}

async function probePty(): Promise<string> {
  const marker = "pal-pty-ok";
  // A minimal environment: the probe must not hand the host's variables to the child.
  const terminal = spawn("/bin/sh", ["-c", `test -t 0 && test -t 1 && printf ${marker}`], {
    cols: 80,
    rows: 24,
    env: { PATH: "/usr/bin:/bin" },
  });
  return await new Promise((resolve, reject) => {
    let output = "";
    let exitCode: number | undefined;
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error(`no result within 5 s (exit ${exitCode}, output ${JSON.stringify(output)})`));
    }, 5_000);
    // Exit can be reported before the last output arrives, so settle on whichever completes the picture.
    const settle = () => {
      if (exitCode === undefined || (exitCode === 0 && !output.includes(marker))) return;
      clearTimeout(timer);
      if (exitCode === 0) resolve("spawned a shell on a pseudo-terminal");
      else reject(new Error(`child exited ${exitCode}: ${JSON.stringify(output)}`));
    };
    terminal.onData((data) => {
      output += data;
      settle();
    });
    terminal.onExit((event) => {
      exitCode = event.exitCode;
      settle();
    });
  });
}
