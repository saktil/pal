// A real packaged Pal child with an independent private IPC parent; no recursive Nix build in smoke.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

const [entry, dataRoot] = process.argv.slice(2);
if (!entry || !dataRoot) throw new Error("pass the packaged main entry and isolated data directory");
await mkdir(dataRoot, { mode: 0o700 });
const lock = await open(join(dataRoot, "fixture.lock"), "wx", 0o600);
const child = spawn(process.execPath, [entry, "serve", "--port", "0", "--data-dir", dataRoot], {
  env: { ...process.env, PAL_SUPERVISED: "1" },
  stdio: ["ignore", "pipe", "pipe", "ipc", lock.fd],
});
const ready = Promise.withResolvers<{ port: number; release: string }>();
const exited = new Promise<number | null>((resolve) => {
  child.once("exit", (code) => resolve(code));
  child.once("error", () => resolve(null));
});
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let diagnostic = "";
child.stdout?.resume();
child.stderr?.on("data", (bytes: Buffer) => {
  diagnostic = (diagnostic + bytes.toString()).slice(-32 * 1024);
});
child.on("error", (error) => ready.reject(error));
child.on(
  "message",
  (message: {
    kind?: string;
    id?: string;
    op?: string;
    args?: { port: number; release: string };
    value?: unknown;
    message?: string;
  }) => {
    if (message.kind === "pal.release.call" && message.op === "online" && message.args !== undefined) {
      ready.resolve(message.args);
      child.send({ kind: "pal.release.result", id: message.id, value: { received: true } });
    } else if (message.id !== undefined) {
      const call = pending.get(message.id);
      if (call !== undefined) {
        pending.delete(message.id);
        if (message.kind === "pal.release.error") call.reject(new Error(message.message));
        else call.resolve(message.value);
      }
    }
  },
);
async function bounded<T>(promise: Promise<T>): Promise<T> {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 15_000);
  try {
    return await Promise.race([
      promise,
      exited.then(() => {
        throw new Error(`Pal exited unexpectedly: ${diagnostic}`);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function call(op: "promote" | "prepare" | "resume") {
  const id = randomUUID();
  return bounded(
    new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.send({ kind: "pal.release.call", id, op, args: {} });
    }),
  );
}
try {
  const online = await bounded(ready.promise),
    origin = `http://127.0.0.1:${online.port}`;
  assert.match(online.release, /^[a-f0-9]{64}$/);
  const health = async () => {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    return (await response.json()) as { release: string; admitting: boolean };
  };
  assert.deepEqual(await health(), {
    status: "ok",
    name: "pal",
    version: pkg.version,
    release: online.release,
    admitting: false,
  });
  assert.equal((await fetch(`${origin}/api/session`)).status, 503);
  assert.equal((await fetch(origin)).status, 503);
  await call("promote");
  assert.equal((await health()).admitting, true);
  assert.deepEqual(await (await fetch(`${origin}/api/session`)).json(), { owner: false, signedIn: false });
  await call("prepare");
  assert.equal((await health()).admitting, false);
  assert.equal((await fetch(`${origin}/api/session`)).status, 503);
  await call("resume");
  assert.equal((await health()).admitting, true);
  child.disconnect();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const code = await exited;
  clearTimeout(deadline);
  assert.equal(code, 0, diagnostic);
  await assert.rejects(fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }));
  process.stdout.write(
    "Packaged supervised child: probation, exact health, promote, drain, resume and disconnect shutdown passed\n",
  );
} finally {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
  await lock.close();
}
