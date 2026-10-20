import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { checkout } from "./tasks.ts";

const grader = fileURLToPath(import.meta.url);
const tasks = fileURLToPath(new URL("tasks.ts", import.meta.url));
const original = fileURLToPath(new URL("../../test/fixtures/evaluation/buggy", import.meta.url));
const timeoutMs = 2_000;
const maxOutputBytes = 16 * 1024;

async function snapshot(root: string) {
  if (!/^\/nix\/store\/[a-z0-9]{32}-[^/]+(?:\/|$)/.test(root) || (await realpath(root)) !== root)
    throw new Error("grading requires a canonical, frozen Nix-store candidate, not a writable workspace");
  const digest = createHash("sha256");
  let bytes = 0,
    files = 0,
    entries = 0;
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 8 || ++entries > 256) throw new Error("candidate exceeds its directory depth or entry limit");
    const info = await lstat(path);
    if (info.isSymbolicLink() || (info.mode & 0o222) !== 0)
      throw new Error("candidate contains a symlink or writable path");
    if (info.isDirectory()) {
      const names: string[] = [];
      for await (const entry of await opendir(path)) {
        if (names.length >= 128) throw new Error("candidate directory contains too many entries");
        names.push(entry.name);
      }
      for (const name of names.sort()) await walk(join(path, name), depth + 1);
      return;
    }
    if (!info.isFile() || ++files > 128 || (bytes += info.size) > 1024 * 1024)
      throw new Error("candidate must contain at most 128 regular files and one MiB");
    const content = await readFile(path);
    digest.update(JSON.stringify([relative(root, path), content.length]));
    digest.update(content);
  }
  await walk(root, 0);
  return { path: root, digest: digest.digest("hex"), files, bytes };
}

/** Grade frozen artifacts, never a candidate's tests, commands or self-reported success. */
export async function grade(candidate: string) {
  const artifact = await snapshot(candidate);
  const initial = await snapshot(original);
  const source = createHash("sha256")
    .update(await readFile(grader))
    .update(await readFile(tasks))
    .digest("hex");
  const cases = checkout.cases.map((test) => {
    const started = performance.now();
    const result = spawnSync(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${candidate}`,
        "--max-old-space-size=64",
        join(candidate, checkout.entrypoint),
        grader,
        tasks,
      ],
      {
        cwd: candidate,
        env: { LANG: "C", TZ: "UTC" },
        input: JSON.stringify(test.input),
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: maxOutputBytes,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output: unknown = null;
    let failure: string | null = null;
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ETIMEDOUT") failure = "timeout";
    else if (code === "ENOBUFS") failure = "output_limit";
    else if (result.error !== undefined || result.status !== 0) failure = "execution_error";
    else {
      try {
        output = JSON.parse(result.stdout) as unknown;
        if (!isDeepStrictEqual(output, test.expected)) failure = "incorrect_output";
      } catch {
        failure = "invalid_json";
      }
    }
    return {
      id: test.id,
      passed: failure === null,
      failure,
      exitCode: result.status,
      signal: result.signal,
      elapsedMs: Math.round(performance.now() - started),
      output,
      stderr: (result.stderr ?? "").slice(0, maxOutputBytes),
    };
  });
  return {
    schema: 1,
    kind: "independent-development-grade",
    task: {
      id: checkout.id,
      version: checkout.version,
      split: checkout.split,
      digest: createHash("sha256").update(JSON.stringify(checkout)).digest("hex"),
      initial,
    },
    candidate: artifact,
    grader: { path: grader, digest: source },
    environment: { platform: process.platform, arch: process.arch, node: process.versions.node },
    budget: { timeoutMsPerCase: timeoutMs, maxOutputBytesPerCase: maxOutputBytes },
    passed: cases.every((test) => test.passed),
    cases,
  };
}
