import { describe, expect, it } from "vitest";
import { runProbes } from "../src/probe.ts";

describe("host capability probes", () => {
  it("load SQLite FTS5, the fff native library and the Code Mode worker on this host", async () => {
    const results = await runProbes();
    expect(results.map(({ check }) => check)).toEqual(["sqlite", "fff", "codemode"]);
    for (const result of results) expect(result, result.detail).toMatchObject({ ok: true });
  });
});
