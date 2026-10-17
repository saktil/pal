import { describe, expect, it } from "vitest";
import { MAX_RESULT_BYTES, safeMcpResult } from "../src/pi/mcp-result.ts";

describe("MCP result boundary", () => {
  it("preserves structured errors and redacts string values and object keys, not numbers", () => {
    expect(
      safeMcpResult(
        { content: [{ type: "text", text: "key 129" }], structuredContent: { "129": [129, "129"] }, isError: true },
        "129",
      ),
    ).toEqual({
      content: [{ type: "text", text: "key [redacted]" }],
      structuredContent: { "[redacted]": [129, "[redacted]"] },
      isError: true,
    });
  });

  it("counts UTF-8, JSON escaping, all blocks and structured data together", () => {
    for (const content of [
      [{ type: "text" as const, text: "😊".repeat(MAX_RESULT_BYTES / 4) }],
      [{ type: "text" as const, text: "\0".repeat(MAX_RESULT_BYTES / 2) }],
      Array.from({ length: 20_000 }, () => ({ type: "text" as const, text: "" })),
    ]) {
      const bounded = safeMcpResult({ content });
      expect(bounded.isError).toBe(true);
      expect(bounded.content).toEqual([{ type: "text", text: expect.stringContaining("MCP result exceeds") }]);
      expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(MAX_RESULT_BYTES);
      expect(bounded.structuredContent).toBeUndefined();
    }
  });

  it("omits binary content and unneeded metadata instead of storing it", () => {
    const result = safeMcpResult({
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      _meta: { unused: "private metadata" },
    });
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(JSON.stringify(result)).not.toContain("private metadata");
    expect(result.content).toEqual([{ type: "text", text: "[non-text MCP content omitted]" }]);
  });
});
