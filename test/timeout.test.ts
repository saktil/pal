import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gnuTimeout } from "../src/core/timeout.ts";

const saved = { PATH: process.env.PATH, PAL_TIMEOUT: process.env.PAL_TIMEOUT };
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.PAL_TIMEOUT === undefined) delete process.env.PAL_TIMEOUT;
  else process.env.PAL_TIMEOUT = saved.PAL_TIMEOUT;
});

describe("GNU timeout lookup", () => {
  it("uses the pinned path, otherwise finds coreutils' gtimeout, and never substitutes a missing one", async () => {
    process.env.PAL_TIMEOUT = "/pinned/timeout";
    expect(gnuTimeout()).toBe("/pinned/timeout");
    delete process.env.PAL_TIMEOUT;
    const empty = await mkdtemp(join(tmpdir(), "pal-timeout-"));
    process.env.PATH = empty;
    expect(gnuTimeout()).toBe("timeout");
    await writeFile(join(empty, "gtimeout"), "#!/bin/sh\n");
    await chmod(join(empty, "gtimeout"), 0o755);
    expect(gnuTimeout()).toBe(join(empty, "gtimeout"));
    await rm(empty, { recursive: true, force: true });
  });
});
