import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { type CallToolResult, toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { safeMcpResult } from "./mcp-result.ts";

/** The parts of an MCP tool listing an approval covers. */
export type McpToolDefinition = {
  readonly remote: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
};

/** Calls one server's tools; the caller decides connection, limits and whether the tool may still run. */
export type McpConnection = {
  call(
    remote: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    api: ToolExecutionApi,
  ): Promise<CallToolResult>;
};

/**
 * `mcp__<server>__<tool>`, provider-safe (at most 64 of [A-Za-z0-9_-]). A remote name that had to change gets a hash
 * suffix, so two remote names never map to one tool.
 */
export function mcpToolName(server: string, remote: string): string {
  const prefix = `mcp__${server}__`;
  const safe = remote.replace(/[^A-Za-z0-9_-]/g, "_");
  if (safe === remote && prefix.length + safe.length <= 64) return prefix + safe;
  const suffix = createHash("sha256").update(remote).digest("hex").slice(0, 8);
  return `${prefix}${safe.slice(0, 64 - prefix.length - suffix.length - 1)}_${suffix}`;
}

/**
 * Durable tools for one server's approved tools. `callers: ["tools"]` keeps them out of model declarations: the model
 * reaches them only through `codemode`, whose nested calls run under Durable validation, hooks and replay policy.
 * `replay: "safe"` is for reviewed read-only search/docs tools; anything else is never re-run after a crash.
 */
export function mcpTools(
  server: string,
  connection: McpConnection,
  tools: readonly McpToolDefinition[],
  replay: "safe" | "unsafe",
): ToolRegistration[] {
  return tools.map((tool) => {
    const structured = tool.outputSchema !== undefined;
    return defineTool({
      name: mcpToolName(server, tool.remote),
      description: tool.description,
      // Providers require an object schema, and some reject one without `properties`.
      parameters: Type.Unsafe<Record<string, unknown>>({
        ...tool.inputSchema,
        type: "object",
        properties: tool.inputSchema.properties ?? {},
      }),
      ...(structured ? { structuredOutputSchema: Type.Unsafe(tool.outputSchema) } : {}),
      callers: ["tools"],
      replay,
      outputLimits: { maxBytes: 64 * 1024, maxLines: 2000 },
      execute: async (args, api, context) => {
        const result = safeMcpResult(await connection.call(tool.remote, args, context.abortSignal, api));
        return {
          output: toLlmContent(result),
          isError: result.isError === true,
          ...(structured && result.structuredContent !== undefined
            ? { structuredOutput: result.structuredContent as JsonValue }
            : {}),
        };
      },
    });
  });
}
