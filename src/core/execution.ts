import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { defineExtension, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
import { gnuTimeout } from "./timeout.ts";

const MAX_OUTPUT = 64 * 1024;
export const SHELL_NAMESPACE: CodemodeNamespace = {
  name: "shell",
  prefix: "shell_",
  description: "Trusted host commands, not sandboxed.",
  instructions:
    "Commands start in the project folder as the Pal user. Never access Pal data, credentials or unrelated private files. Print or return results. Interrupted commands have unknown effects: inspect before retrying.",
};

export class WorkspaceBusy extends Error {}

/** Serializes overlapping writable roots, not external editors or arbitrary host processes. */
export class WorkspaceLocks {
  readonly #active = new Set<string>();
  readonly #before: ((root: string) => Promise<void>) | undefined;
  constructor(before?: (root: string) => Promise<void>) {
    this.#before = before;
  }
  async run<T>(root: string, work: () => Promise<T>): Promise<T> {
    const inside = (a: string, b: string) => {
      const path = relative(a, b);
      return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    };
    if ([...this.#active].some((other) => inside(root, other) || inside(other, root)))
      throw new WorkspaceBusy("an overlapping workspace is busy; wait for its mutation to finish");
    this.#active.add(root);
    try {
      await this.#before?.(root);
      return await work();
    } finally {
      this.#active.delete(root);
    }
  }
}

export type ShellResult = { output: string; exitCode: number; truncated: boolean; timedOut: boolean };

/** Marks a chat whose host commands run through rtk's compact equivalents; it adds no tools of its own. */
export const COMPACT_EXTENSION = "pal.compact";
export const compactOutput = defineExtension({ name: COMPACT_EXTENSION });

function cleanEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/run/current-system/sw/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    LANG: "C",
    TERM: "dumb",
  };
}

/** Explicit high-trust host execution. Cwd and a clean environment are not filesystem/network confinement. */
export class HostCommands {
  readonly #running = new Map<AbortController, Promise<ShellResult>>();

  /**
   * rtk's own rewrite, as its agent hooks use it: the compact equivalent (exit 0 or 3), or undefined to run the
   * command unchanged. It runs with an empty home, so the owner's rtk and agent configuration never apply, and a
   * missing, slow or failing rtk only leaves the command as it was.
   */
  async rewrite(cwd: string, command: string): Promise<string | undefined> {
    const home = await mkdtemp(join(tmpdir(), "pal-rtk-"));
    try {
      return await new Promise<string | undefined>((resolve) => {
        execFile(
          "rtk",
          ["rewrite", command],
          { cwd, env: cleanEnv(home), timeout: 5_000, maxBuffer: 64 * 1024 },
          (error, stdout) => {
            const code = error === null ? 0 : error.code;
            const rewritten = stdout.trim();
            const valid = rewritten !== "" && rewritten.length <= 16_384 && !rewritten.includes("\0");
            resolve((code === 0 || code === 3) && valid && rewritten !== command ? rewritten : undefined);
          },
        );
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  async run(
    cwd: string,
    command: string,
    timeout: number,
    signal?: AbortSignal,
    onOutput?: (text: string) => void,
  ): Promise<ShellResult> {
    if (this.#running.size >= 2) throw new Error("at most two host commands may run at once");
    if (!(timeout > 0 && timeout <= 120) || command.length > 16_384 || command.includes("\0"))
      throw new Error("invalid command or timeout (maximum 120 seconds)");
    const controller = new AbortController();
    const active = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const job = this.#execute(cwd, command, timeout, active, onOutput);
    this.#running.set(controller, job);
    try {
      return await job;
    } finally {
      this.#running.delete(controller);
    }
  }
  async close(): Promise<void> {
    for (const controller of this.#running.keys()) controller.abort();
    await Promise.allSettled(this.#running.values());
  }
  async #execute(
    cwd: string,
    command: string,
    timeout: number,
    signal: AbortSignal,
    onOutput?: (text: string) => void,
  ): Promise<ShellResult> {
    signal.throwIfAborted();
    const home = await mkdtemp(join(tmpdir(), "pal-command-"));
    try {
      signal.throwIfAborted();
      return await new Promise<ShellResult>((resolve, reject) => {
        // GNU timeout retains an independent deadline even if Pal is killed before it can cancel the process group.
        const child = spawn(
          gnuTimeout(),
          ["--kill-after=1s", `${timeout}s`, process.env.PAL_BASH ?? "bash", "--noprofile", "--norc", "-c", command],
          {
            cwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: cleanEnv(home),
          },
        );
        let output = "";
        let truncated = false;
        let timedOut = false;
        const kill = () => {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already exited. */
            }
          }
        };
        const timer = setTimeout(
          () => {
            timedOut = true;
            kill();
          },
          timeout * 1000 + 1500,
        );
        const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")] as const;
        let callbackError: Error | undefined;
        const keep = (text: string) => {
          if (callbackError !== undefined) return;
          try {
            onOutput?.(text);
          } catch (error) {
            callbackError = error instanceof Error ? error : new Error(String(error));
            kill();
            return;
          }
          const bytes = Buffer.from(output + text);
          truncated ||= bytes.length > MAX_OUTPUT;
          const tail = bytes.subarray(-MAX_OUTPUT);
          let offset = 0;
          while (offset < tail.length && ((tail[offset] ?? 0) & 0xc0) === 0x80) offset++;
          output = tail.subarray(offset).toString("utf8");
        };
        child.stdout.on("data", (chunk: Buffer) => keep(decoders[0].write(chunk)));
        child.stderr.on("data", (chunk: Buffer) => keep(decoders[1].write(chunk)));
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", kill);
          kill();
        };
        child.once("error", (error: NodeJS.ErrnoException) => {
          cleanup();
          reject(
            error.code === "ENOENT"
              ? new Error("host commands need GNU timeout from coreutils on PATH (gtimeout on macOS); nothing was run")
              : error,
          );
        });
        child.once("exit", kill);
        child.once("close", (code) => {
          cleanup();
          for (const decoder of decoders) keep(decoder.end());
          if (callbackError !== undefined) reject(callbackError);
          else if (signal.aborted) reject(new Error("host command stopped; effects already performed are not undone"));
          else resolve({ output, exitCode: code ?? 137, truncated, timedOut: timedOut || code === 124 });
        });
        signal.addEventListener("abort", kill, { once: true });
        if (signal.aborted) kill();
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}

export function shellTools(options: {
  root: (id: ConversationId) => Promise<string | undefined>;
  commands: HostCommands;
  locks: WorkspaceLocks;
  /** Whether the conversation's frozen extension selection includes compact output. */
  compact?: (id: ConversationId, context: Context) => Promise<boolean>;
}) {
  return defineExtension({
    name: "pal.shell",
    tools: [
      defineTool({
        name: "shell_run",
        description:
          "Run a trusted host command in the project folder. Not sandboxed; clean environment, bounded output, 120-second maximum. Never access Pal secrets. An interrupted command must not be blindly retried. When `executed` is present, the command ran as that rtk equivalent and its output is condensed; if the result is unusable, run `rtk bypass <command>` for the unfiltered output.",
        parameters: Type.Object({
          command: Type.String({ minLength: 1, maxLength: 16_384 }),
          timeout: Type.Optional(Type.Number({ minimum: 0.01, maximum: 120 })),
        }),
        callers: ["tools"],
        replay: "unsafe",
        outputLimits: { maxBytes: MAX_OUTPUT, maxLines: 2000 },
        structuredOutputSchema: Type.Object({
          output: Type.String(),
          exitCode: Type.Number(),
          truncated: Type.Boolean(),
          timedOut: Type.Boolean(),
          executed: Type.Optional(Type.String()),
        }),
        execute: async (args, api, context) => {
          const configured = await options.root(api.conversationId);
          if (configured === undefined) throw new Error("this conversation has no active project");
          const cwd = await realpath(configured);
          return options.locks.run(cwd, async () => {
            // Decided before the durable intent, so the receipt names exactly what was dispatched.
            const executed =
              (await options.compact?.(api.conversationId, context)) === true
                ? await options.commands.rewrite(cwd, args.command)
                : undefined;
            const shell = {
              callId: String(api.taskId),
              command: args.command,
              ...(executed === undefined ? {} : { executed }),
              cwd,
              status: "started",
            };
            await api.commit(
              (tx) => tx.appendEntry(api.conversationId, { kind: "pal.shell", data: { shell } }),
              context,
            );
            if ((await options.root(api.conversationId)) !== configured)
              throw new Error("the workspace was revoked before command dispatch");
            const ran = await options.commands.run(
              cwd,
              executed ?? args.command,
              args.timeout ?? 120,
              context.abortSignal,
              (text) => api.output(text),
            );
            const result = executed === undefined ? ran : { ...ran, executed };
            await api.commit(
              (tx) =>
                tx.appendEntry(api.conversationId, {
                  kind: "pal.shell",
                  data: { shell: { ...shell, status: "finished", ...result } },
                }),
              context,
            );
            return { structuredOutput: result, isError: result.exitCode !== 0 || result.timedOut, details: result };
          });
        },
      }),
    ],
  });
}
