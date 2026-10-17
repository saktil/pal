import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import {
  type ConversationId,
  defineExtension,
  type Extension,
  hook,
  type JsonObject,
  ToolTask,
} from "@earendil-works/pi-durable";
import {
  CODEMODE_TOOL_NAME,
  type CodemodeNamespace,
  createCodemodeExtension,
} from "@earendil-works/pi-durable/codemode";

/** Host limits for every script; a script's own options may lower the first two, never raise them. */
export type CodemodeCaps = {
  /** Wall-clock deadline per script, recorded with the script so it also bounds a resumed run. */
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  /** Calls one script may make, counted by VM call number (discovery globals included). */
  readonly maxCalls: number;
  readonly memoryLimitBytes: number;
  /** Script workers alive at once, counted until each worker actually exits. */
  readonly maxWorkers: number;
};

export const DEFAULT_CODEMODE_CAPS: CodemodeCaps = {
  timeoutMs: 120_000,
  maxOutputTokens: 8_000,
  maxCalls: 100,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxWorkers: 2,
};

/** The host's current decision whether a conversation's scripts may call a tool; asked before every nested call. */
export type ToolPolicy = (conversationId: ConversationId, toolName: string) => boolean | Promise<boolean>;

export type PalCodemodeOptions = {
  readonly allows: ToolPolicy;
  readonly caps?: CodemodeCaps;
  readonly namespaces?: readonly CodemodeNamespace[];
};

/**
 * Pi's durable `codemode` extension under Pal's host policy. `models: false`: no implicit model or image helpers.
 * The returned sandbox belongs to the caller, who closes it after the Harness.
 */
export function createPalCodemode(options: PalCodemodeOptions): { extensions: Extension[]; sandbox: CodemodeSandbox } {
  const caps = options.caps ?? DEFAULT_CODEMODE_CAPS;
  let workers = 0;
  const sandbox = new CodemodeSandbox({
    memoryLimitBytes: caps.memoryLimitBytes,
    acquireWorker: () => {
      if (workers >= caps.maxWorkers) throw new Error(`at most ${caps.maxWorkers} scripts may run at once`);
      workers += 1;
      return () => {
        workers -= 1;
      };
    },
  });

  const policy = defineExtension({
    name: "pal.policy",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          if (call.parent === undefined) {
            return call.name === CODEMODE_TOOL_NAME ? capScript(call.arguments.code, caps) : undefined;
          }
          // Code mode keys nested calls `c<VM call number>`, so the count survives replay without state.
          const number = /\/c(\d+)$/.exec(call.id)?.[1];
          if (number !== undefined && Number(number) > caps.maxCalls) {
            return { block: `script call limit of ${caps.maxCalls} reached` };
          }
          if (!(await options.allows(api.conversationId, call.name))) {
            return { block: `${call.name} is not granted to this conversation` };
          }
          return undefined;
        },
      }),
    ],
  });

  const codemode = createCodemodeExtension({
    sandbox,
    models: false,
    ...(options.namespaces === undefined ? {} : { namespaces: options.namespaces }),
  });
  return { extensions: [policy, codemode], sandbox };
}

/** Rewrite the script's options line within the caps; an invalid script is left for code mode to report. */
function capScript(source: unknown, caps: CodemodeCaps): { arguments: JsonObject } | undefined {
  if (typeof source !== "string") return undefined;
  let parsed;
  try {
    parsed = parseCodemodeSource(source);
  } catch {
    return undefined;
  }
  const line = `// @options: ${JSON.stringify({
    max_output_tokens: Math.min(parsed.options.maxOutputTokens ?? caps.maxOutputTokens, caps.maxOutputTokens),
    timeout_ms: Math.min(parsed.options.timeoutMs ?? caps.timeoutMs, caps.timeoutMs),
  })}`;
  // The parser blanks an options line, so a changed first line means there was one to replace.
  const hadOptions = source.split("\n", 1)[0] !== parsed.code.split("\n", 1)[0];
  const body = hadOptions ? parsed.code.slice(parsed.code.indexOf("\n") + 1) : parsed.code;
  // `code` is the code mode tool's only parameter.
  return { arguments: { code: `${line}\n${body}` } };
}
