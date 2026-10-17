import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { type McpClient, type Tool as McpTool, toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";

// Provider tool names allow at most 64 characters of [A-Za-z0-9_-].
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Durable tools for the owner-granted tools of one connected MCP server, named `mcp__<server>__<tool>`.
 * `callers: ["tools"]` keeps them out of model declarations: the model reaches them only through `codemode`,
 * whose nested calls run under Durable validation, hooks and replay policy. Calls are not replay-safe.
 */
export function mcpTools(
  server: string,
  client: McpClient,
  listed: readonly McpTool[],
  granted: ReadonlySet<string>,
): ToolRegistration[] {
  return listed
    .filter((tool) => granted.has(tool.name))
    .map((tool) => {
      const name = `mcp__${server}__${tool.name}`;
      if (!NAME.test(name)) throw new Error(`MCP tool name is not usable by models: ${JSON.stringify(name)}`);
      const { outputSchema } = tool;
      const structured = outputSchema !== undefined;
      return defineTool({
        name,
        description: tool.description ?? tool.title ?? tool.name,
        // Providers require an object schema, and some reject one without `properties`.
        parameters: Type.Unsafe<Record<string, unknown>>({
          ...tool.inputSchema,
          type: "object",
          properties: tool.inputSchema.properties ?? {},
        }),
        ...(structured ? { structuredOutputSchema: Type.Unsafe(outputSchema) } : {}),
        callers: ["tools"],
        execute: async (args, _api, context) => {
          const signal = context.abortSignal;
          const result = await client.callTool(tool.name, args, signal === undefined ? {} : { signal });
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
