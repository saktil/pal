import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const child = join(import.meta.dirname, "fixtures", "codemode-child.ts");
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The mutating service the script talks to. A write never answers, so the test can kill the child mid-effect. */
async function startService() {
  const requests: string[] = [];
  let inFlight: () => void = () => {};
  const writeInFlight = new Promise<void>((resolve) => {
    inFlight = resolve;
  });
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "POST") {
      inFlight();
      return;
    }
    response.end(`value of ${new URL(request.url ?? "/", "http://fixture.invalid").searchParams.get("key")}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, writeInFlight };
}

function runChild(args: string[]): { process: ChildProcess; output: () => Promise<string> } {
  const proc = spawn(process.execPath, [child, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  cleanups.push(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await once(proc, "exit");
    }
  });
  let output = "";
  proc.stdout?.on("data", (chunk) => (output += chunk));
  const exited = once(proc, "exit");
  return {
    process: proc,
    output: async () => {
      const [code] = await exited;
      if (code !== 0) throw new Error(`child exited ${code}`);
      return output;
    },
  };
}

/** Kill a first process while its non-replay-safe write is in flight, then resume in a second one. */
async function crashDuringWrite(resumeArgs: string[] = []) {
  const service = await startService();
  const dataRoot = await mkdtemp(join(tmpdir(), "pal-codemode-recovery-"));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));

  const first = runChild(["start", dataRoot, service.url]);
  await service.writeInFlight;
  first.process.kill("SIGKILL");
  await once(first.process, "exit");
  const beforeResume = [...service.requests];

  const resumed = runChild(["resume", dataRoot, service.url, ...resumeArgs]);
  const results = JSON.parse((await resumed.output()).trim()) as {
    isError?: boolean;
    text?: string;
    answer?: string;
  }[];
  return { requests: service.requests, beforeResume, results };
}

describe("code mode recovery", () => {
  it("resumes without re-running finished calls and reports the interrupted write as unknown", async () => {
    const { requests, beforeResume, results } = await crashDuringWrite();
    expect(beforeResume).toEqual(["GET /read?key=a", "POST /write?key=b"]);
    // After the restart only the script's next call runs: the read is not repeated, the write is not replayed.
    expect(requests).toEqual(["GET /read?key=a", "POST /write?key=b", "GET /read?key=c"]);

    const script = results.find((result) => result.text !== undefined);
    expect(script?.isError).toBe(false);
    expect(script?.text).toContain('"a":"value of a"');
    expect(script?.text).toMatch(/"b":"unknown: [^"]*interrupted/i);
    expect(script?.text).toContain('"c":"value of c"');
    expect(results.at(-1)).toEqual({ answer: "Done." });
  });

  it("stops visibly instead of resuming on a changed sandbox", async () => {
    const { requests, results } = await crashDuringWrite([String(32 * 1024 * 1024)]);
    expect(requests).toEqual(["GET /read?key=a", "POST /write?key=b"]);
    const script = results.find((result) => result.text !== undefined);
    expect(script?.isError).toBe(true);
    expect(script?.text).toMatch(/cannot resume: the sandbox changed/);
  });
});
