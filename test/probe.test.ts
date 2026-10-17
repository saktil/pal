import { describe, expect, it } from "vitest";
import { runProbes } from "../src/probe.ts";

describe("host capability probes", () => {
  it("load SQLite FTS5, the fff native library, the Code Mode worker and node-pty on this host", async () => {
    const results = await runProbes();
    expect(results.map(({ check }) => check)).toEqual(["sqlite", "fff", "codemode", "pty"]);
    for (const result of results) expect(result, result.detail).toMatchObject({ ok: true });
  });
});
