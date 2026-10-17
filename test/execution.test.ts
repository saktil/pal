import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openPal } from "../src/core/app.ts";
import { startOpenAIFixture } from "./fixtures/openai-server.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostCommands, WorkspaceLocks } from "../src/core/execution.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pal-command-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const commands = new HostCommands();
  cleanups.push(() => commands.close());
  return { root, commands };
}
async function running(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") return !/^\d+ \(.*\) [ZX]/.test(await readFile(`/proc/${pid}/stat`, "utf8"));
    return true;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

describe("trusted host commands", () => {
  it("starts in the project and does not inherit secrets or shell startup configuration", async () => {
    const { root, commands } = await setup();
    const old = { key: process.env.OPENAI_API_KEY, startup: process.env.BASH_ENV };
    await writeFile(join(root, "startup"), "echo startup-leaked\n");
    process.env.OPENAI_API_KEY = "fixture-secret-must-not-leak";
    process.env.BASH_ENV = join(root, "startup");
    try {
      const result = await commands.run(
        root,
        'pwd; printf "%s" "${OPENAI_API_KEY-missing}:${BASH_ENV-missing}"; printf error >&2; exit 7',
        2,
      );
      expect(result).toMatchObject({ exitCode: 7, timedOut: false, truncated: false });
      expect(result.output).toContain(root);
      expect(result.output).toContain("missing:missing");
      expect(result.output).toContain("error");
      expect(result.output).not.toMatch(/fixture-secret|startup-leaked/);
    } finally {
      if (old.key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old.key;
      if (old.startup === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = old.startup;
    }
  });
  it("bounds Unicode flood output and has a real deadline", async () => {
    const { root, commands } = await setup();
    const flood = await commands.run(root, `${process.execPath} -e 'process.stdout.write("é".repeat(200000))'`, 3);
    expect(flood.truncated).toBe(true);
    expect(Buffer.byteLength(flood.output)).toBeLessThanOrEqual(64 * 1024);
    expect(flood.output).not.toContain("�");
    expect(await commands.run(root, "sleep 30", 0.1)).toMatchObject({ timedOut: true, exitCode: 124 });
  });
  it("kills the process group on Stop and does not leave ordinary background children", async () => {
    const { root, commands } = await setup();
    const controller = new AbortController();
    const stopped = commands
      .run(root, "sleep 30 & echo $! > child.pid; wait", 10, controller.signal)
      .catch((error: unknown) => error);
    await expect.poll(() => readFile(join(root, "child.pid"), "utf8")).toMatch(/^\d+/);
    const pid = Number((await readFile(join(root, "child.pid"), "utf8")).trim());
    controller.abort();
    expect(await stopped).toBeInstanceOf(Error);
    await expect.poll(() => running(pid)).toBe(false);
    await commands.run(root, "sleep 30 >/dev/null 2>&1 & echo $! > background.pid", 2);
    const background = Number((await readFile(join(root, "background.pid"), "utf8")).trim());
    await expect.poll(() => running(background)).toBe(false);
  });
  it("caps active commands, closes them, and contains an output callback failure", async () => {
    const { root, commands } = await setup();
    const first = commands.run(root, "sleep 30", 10).catch((error: unknown) => error);
    const second = commands.run(root, "sleep 30", 10).catch((error: unknown) => error);
    await expect(commands.run(root, "true", 1)).rejects.toThrow(/two host commands/);
    await commands.close();
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    await expect(
      commands.run(root, "printf test", 1, undefined, () => {
        throw new Error("consumer closed");
      }),
    ).rejects.toThrow("consumer closed");
    await expect(commands.run(root, "true", 999)).rejects.toThrow(/120/);
  });
  it("does not replay an unknown host effect after SIGKILL and bounds the orphan command", async () => {
    const { root } = await setup();
    const fixture = await startOpenAIFixture();
    cleanups.push(fixture.close);
    fixture.behavior.responses = "script";
    fixture.behavior.script =
      'return await tools.shell_run({ command: "printf run >> marker; echo $PPID > command.pid; sleep 30", timeout: 1 });';
    const dataRoot = join(root, "data");
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "fixtures/execution-child.ts"), dataRoot, JSON.stringify(fixture.endpoints)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    const lines = createInterface({ input: child.stdout });
    const [line] = await Promise.race([
      once(lines, "line"),
      once(child, "exit").then(() => {
        throw new Error("fixture exited before ready");
      }),
    ]);
    const ready = JSON.parse(String(line)) as { root: string; chatId: string };
    await expect.poll(() => readFile(join(ready.root, "command.pid"), "utf8"), { timeout: 5000 }).toMatch(/^\d+/);
    const commandPid = Number((await readFile(join(ready.root, "command.pid"), "utf8")).trim());
    child.kill("SIGKILL");
    await once(child, "exit");
    const reopened = await openPal(
      { dataRoot, installRoot: "/nonexistent-install", endpoints: fixture.endpoints },
      context,
    );
    cleanups.push(() => reopened.close());
    await reopened.harness.waitForIdle(context);
    await expect.poll(() => running(commandPid), { timeout: 4000 }).toBe(false);
    expect(await readFile(join(ready.root, "marker"), "utf8")).toBe("run");
    const chat = await reopened.chats.get(ready.chatId);
    if (chat === undefined) throw new Error("missing recovered chat");
    const history = await (await reopened.harness.conversation(chat.conversationId, context))?.context(context);
    const intents = history?.entries.filter((entry) => entry.kind === "pal.shell");
    expect(intents).toHaveLength(1);
    expect(intents?.[0]?.data).toMatchObject({ shell: { status: "started" } });
  });

  it("locks overlapping roots and releases them even when work fails", async () => {
    const locks = new WorkspaceLocks();
    const done = Promise.withResolvers<undefined>();
    const held = locks.run("/workspace", () => done.promise);
    await expect(locks.run("/workspace/nested", async () => true)).rejects.toThrow(/busy/);
    await expect(locks.run("/workspace/..nested", async () => true)).rejects.toThrow(/busy/);
    await expect(locks.run("/", async () => true)).rejects.toThrow(/busy/);
    expect(await locks.run("/other", async () => true)).toBe(true);
    done.resolve(undefined);
    await held;
    await expect(
      locks.run("/workspace", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(await locks.run("/workspace", async () => true)).toBe(true);
  });
});
