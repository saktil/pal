import { describe, expect, it } from "vitest";
import { mcpEvidence } from "../src/pi/mcp-source.ts";

describe("MCP source evidence", () => {
  it("distinguishes reported structured links from requested URLs and redacts query credentials", () => {
    const evidence = mcpEvidence(
      { content: [], structuredContent: { results: [{ url: "https://example.test/docs", title: "Docs" }] } },
      {
        query: "help secret",
        libraryId: "/library/v2",
        urls: ["https://example.test/docs", "https://example.test/other"],
      },
      "secret",
    );
    expect(evidence).toMatchObject({ query: "help [redacted]", library: "/library/v2", isError: false });
    expect(evidence.sources).toEqual([
      { url: "https://example.test/docs", title: "Docs", kind: "reported" },
      { url: "https://example.test/other", title: "example.test", kind: "requested" },
    ]);
  });

  it("reads JSON, Exa-style title/URL, Context7 Source and Markdown links without inventing URLs", () => {
    const evidence = mcpEvidence(
      {
        content: [
          { type: "text", text: '[{"title":"JSON","url":"https://example.test/json"}]' },
          {
            type: "text",
            text: "Title: Web page\nURL: https://example.test/web\nSource: https://example.test/docs\n[Guide](https://example.test/guide)\nNo real citation here.",
          },
        ],
      },
      {},
    );
    expect(evidence.sources.map((source) => [source.title, source.url])).toEqual([
      ["JSON", "https://example.test/json"],
      ["Web page", "https://example.test/web"],
      ["example.test", "https://example.test/docs"],
      ["Guide", "https://example.test/guide"],
    ]);
  });

  it("never treats error links as evidence or turns unsafe destinations into clickable sources", () => {
    const failed = mcpEvidence(
      { content: [{ type: "text", text: "Source: https://example.test/error" }], isError: true },
      { url: "https://example.test/request" },
    );
    expect(failed.sources).toEqual([]);
    const unsafe = mcpEvidence(
      {
        content: [],
        structuredContent: [
          { url: "javascript:alert(1)" },
          { url: "data:text/html,test" },
          { url: "file:///private" },
          { url: "https://user:pass@example.test/" },
          { url: "https://example.test/\nother" },
        ],
      },
      {},
    );
    expect(unsafe.sources).toEqual([]);
  });

  it("bounds source count, title/query sizes and nested scans", () => {
    const evidence = mcpEvidence(
      {
        content: [],
        structuredContent: Array.from({ length: 200 }, (_, n) => ({
          url: `https://example.test/${n}`,
          title: "t".repeat(1000),
        })),
      },
      { query: "q".repeat(2000) },
    );
    expect(evidence.sources).toHaveLength(20);
    expect(evidence.sources.every((source) => source.title.length <= 160)).toBe(true);
    expect(evidence.query).toHaveLength(1000);
    let nested: unknown = { url: "https://example.test/too-deep" };
    for (let i = 0; i < 50; i++) nested = { nested };
    expect(mcpEvidence({ content: [], structuredContent: nested }, {}).sources).toEqual([]);
  });
});
