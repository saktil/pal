import { type CallToolResult, toLlmContent } from "@earendil-works/pi-mcp";

/** Includes structured data and JSON framing, not only the model-visible text. */
export const MAX_RESULT_BYTES = 256 * 1024;

/** A server may echo its credential anywhere in a result; sanitize before durable storage or model delivery. */
export function safeMcpResult(result: CallToolResult, key?: string): CallToolResult {
  const json = JSON.stringify(
    {
      content: toLlmContent(result).map((block) =>
        block.type === "text" ? block : { type: "text", text: "[non-text MCP content omitted]" },
      ),
      isError: result.isError === true,
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    },
    (_name, value: unknown) => {
      if (key === undefined || key === "") return value;
      const redact = (text: string) => text.split(key).join("[redacted]");
      if (typeof value === "string") return redact(value);
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [redact(name), item]));
      return value;
    },
  );
  if (Buffer.byteLength(json) > MAX_RESULT_BYTES)
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "MCP result exceeds 256 KiB; request a smaller result. No partial structured data was returned.",
        },
      ],
    };
  return JSON.parse(json) as CallToolResult;
}
