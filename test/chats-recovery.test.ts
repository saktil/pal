import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Barrier } from "../src/core/chats.ts";

const child = join(import.meta.dirname, "fixtures", "chats-child.ts");
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function runChild(args: string[]): Promise<{ code: number | null; signal: string | null; output: string }> {
  const proc = spawn(process.execPath, [child, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  proc.stdout.on("data", (chunk) => (output += chunk));
  const [code, signal] = (await once(proc, "exit")) as [number | null, string | null];
  return { code, signal, output };
}

describe("chat recovery", () => {
  it.each<Barrier>(["chat-recorded", "chat-created", "input-recorded", "input-submitted"])(
    "completes a chat and its input exactly once after SIGKILL at %s",
    async (barrier) => {
      const dataRoot = await mkdtemp(join(tmpdir(), "pal-chats-recovery-"));
      cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));

      const crashed = await runChild(["run", dataRoot, barrier]);
      expect(crashed.signal).toBe("SIGKILL");
      expect(crashed.output).toBe("");

      const inspected = await runChild(["inspect", dataRoot]);
      expect(inspected.code).toBe(0);
      const state = JSON.parse(inspected.output);
      // One conversation, one user message: neither the crash nor the client's retry duplicated anything.
      expect(state.conversations).toBe(1);
      expect(state.userMessages).toBe(1);
      // Reopening alone completed the recorded work; the retry then returned the same chat and submission.
      const chats = [{ id: state.chat.id, state: "ready", conversation_id: state.chat.conversationId }];
      const admissions = [
        {
          chat_id: state.chat.id,
          request_id: "input-request-1",
          state: "admitted",
          submission_id: state.admission.submissionId,
        },
      ];
      expect(state.reconciled).toEqual({ chats, admissions: barrier.startsWith("input") ? admissions : [] });
      expect(state.after).toEqual({ chats, admissions });
    },
  );
});
