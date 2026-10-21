import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  ToolTask,
  hook,
  type AgentChange,
  type ConversationId,
  type Extension,
  type Harness,
  type Registry,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { type Static, Type } from "typebox";
import { HttpError } from "./http.ts";
import { validate } from "./requests.ts";
import { unfinishedWork } from "./release-state.ts";

/** Only compiled, exercised contributions. A manifest is not a sandbox or permission to load code. */
export const BUILTINS = [
  {
    id: "files",
    version: 1,
    name: "Files and changes",
    native: "pal.files",
    panels: ["Files", "Changes"],
    description: "Project file tools and revision-bound review. Folder grants still apply.",
  },
  {
    id: "shell",
    version: 1,
    name: "Host commands and Terminal",
    native: "pal.shell",
    panels: ["Terminal"],
    description: "Agent commands and the separate human terminal. Not sandboxed; command approvals still apply.",
  },
  {
    id: "memory",
    version: 1,
    name: "Context and memory",
    native: "pal.memory",
    panels: ["Context"],
    description: "Source-linked memory adapter and Context panel. Core instruction/preparation hooks always stay on.",
  },
  {
    id: "browser",
    version: 1,
    name: "Project browser",
    native: "pal.browser",
    panels: ["Browser"],
    description:
      "Sandboxed project browser. Agent access still needs an explicit, expiring handoff and action approvals.",
  },
  {
    id: "compact",
    version: 1,
    name: "Compact command output",
    native: "pal.compact",
    panels: [],
    // Off until chosen: it changes which command runs, not only what the model reads.
    optIn: true,
    description:
      "In Full access, agent commands with an rtk equivalent run as it, so the model reads condensed output. Approved commands, pipes and redirects run unchanged. Needs rtk on PATH; receipts show what ran.",
  },
] as const;
export type BuiltinId = (typeof BUILTINS)[number]["id"];
export type PanelId = (typeof BUILTINS)[number]["panels"][number];
const Choice = Type.Object(
  { id: Type.Enum(["files", "shell", "memory", "browser", "compact"]), version: Type.Literal(1) },
  { additionalProperties: false },
);
const Choices = Type.Array(Choice, { maxItems: BUILTINS.length, uniqueItems: true });
const Scope = Type.Object({ selected: Choices }, { additionalProperties: false });
const RequestPin = Type.Object(
  { task: Type.Integer({ minimum: 1 }), release: Type.String({ maxLength: 64 }), selected: Choices },
  { additionalProperties: false },
);
export type ExtensionRequestPin = Static<typeof RequestPin>;
export type ExtensionScope = Static<typeof Scope>;
export type ExtensionView = {
  release: string;
  digest: string;
  selected: ExtensionScope["selected"];
  catalog: typeof BUILTINS;
};
export const ExtensionSelection = Type.Object(
  { selected: Choices, digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false },
);
const RunPin = defineDoc({
  kind: "pal.extensionRun",
  version: 1,
  scope: "task",
  initial: () => ({ release: "", selected: [] as ExtensionScope["selected"] }),
});

export function extensionScope(intent: string): string | undefined {
  let body: { extensions?: unknown };
  try {
    body = JSON.parse(intent);
  } catch {
    throw new Error("the chat's extension scope is corrupt");
  }
  if (body.extensions === undefined) return undefined;
  if (typeof body.extensions !== "string") throw new Error("the chat's extension scope is corrupt");
  selectedExtensions(body.extensions);
  return body.extensions;
}
export function selectedExtensions(scope: string | undefined): ExtensionScope["selected"] {
  if (scope === undefined)
    return BUILTINS.flatMap((item) => ("optIn" in item ? [] : [{ id: item.id, version: item.version }]));
  let value: unknown;
  try {
    value = JSON.parse(scope);
  } catch {
    throw new Error("the chat's extension scope is corrupt");
  }
  return validate(Scope, value).selected;
}

/** Pin immutable outputs directly; verify mutable runtime bytes before any unfinished work can resume. */
export async function releaseIdentity(installRoot: string, dataRoot?: string): Promise<string> {
  const root = await realpath(installRoot).catch(() => installRoot);
  const output = /^\/nix\/store\/[a-z0-9]{32}-[^/]+/.exec(root)?.[0];
  if (output !== undefined) return createHash("sha256").update(output).digest("hex");
  const { mutableIdentity } = await import("./implementation.ts");
  return mutableIdentity(root, dataRoot);
}

export class BuiltinExtensions {
  readonly extension: Extension;
  readonly release: string;
  readonly #database: SqliteDatabase;
  readonly #registry: Registry;

  private constructor(database: SqliteDatabase, registry: Registry, harness: () => Harness, release: string) {
    this.#database = database;
    this.#registry = registry;
    this.release = release;
    this.extension = defineExtension({
      name: "pal.extensions",
      hooks: [
        hook(ToolTask, {
          beforeTool: async (_call, api, context) => {
            const pinned = await api.memo("pal.extensionRelease", release, context);
            return pinned === release
              ? undefined
              : { block: "This tool needs its retained Pal release; its implementation pin changed." };
          },
        }),
        // Request hooks are metadata; the startup check and blocking tool hook enforce implementation pins.
        hook(GenerationTask, {
          beforeRequest: async (_request, api, context) => {
            const running = harness();
            const conversation = await running.conversation(api.conversationId, context);
            if (conversation === undefined) throw new Error("the pinned conversation is missing");
            const agent = await conversation.agent(context);
            const names = new Set(agent.extensions.map((extension) => extension.name));
            const selected = BUILTINS.flatMap(({ id, version, native }) =>
              names.has(native) ? [{ id, version }] : [],
            );
            await running.commit(async (tx) => {
              const pin = await tx.doc(RunPin, api.taskId);
              if (
                pin.release !== "" &&
                (pin.release !== release || JSON.stringify(pin.selected) !== JSON.stringify(selected))
              )
                throw new Error("the active extension pin changed; resume with the retained release instead");
              if (pin.release === "") {
                pin.release = release;
                pin.selected = selected;
                await tx.appendEntry(api.conversationId, {
                  kind: "pal.extensions",
                  data: { task: api.taskId, release, selected },
                });
              }
            }, context);
          },
        }),
      ],
    });
  }

  static async open(database: SqliteDatabase, registry: Registry, harness: () => Harness, release: string) {
    const previous = await database.get<{ value: string }>(
      "SELECT value FROM pal_settings WHERE key = 'extensions:release'",
    );
    if (previous?.value !== release) {
      if ((await unfinishedWork(database)) > 0)
        throw new Error("unfinished work needs its retained Pal release; refusing to change extension implementations");
      await database.run(
        "INSERT INTO pal_settings (key, value) VALUES ('extensions:release', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        release,
      );
    }
    return new BuiltinExtensions(database, registry, harness, release);
  }

  async view(): Promise<ExtensionView> {
    const row = await this.#database.get<{ value: string }>(
      "SELECT value FROM pal_settings WHERE key = 'extensions:selection'",
    );
    const selected = selectedExtensions(row?.value);
    return { release: this.release, selected, digest: digest(selected), catalog: BUILTINS };
  }
  async select(input: unknown): Promise<ExtensionView> {
    const body = validate(ExtensionSelection, input);
    await this.#database.transaction(async (tx) => {
      const row = await tx.get<{ value: string }>("SELECT value FROM pal_settings WHERE key = 'extensions:selection'");
      if (digest(selectedExtensions(row?.value)) !== body.digest)
        throw new HttpError(409, "extensions_stale", "Extension defaults changed; reload before saving.");
      await tx.run(
        "INSERT INTO pal_settings (key, value) VALUES ('extensions:selection', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        JSON.stringify({ selected: body.selected }),
      );
    });
    return this.view();
  }
  async capture(): Promise<string> {
    return JSON.stringify({ selected: (await this.view()).selected });
  }
  agent(scope: string | undefined): AgentChange {
    const selected = new Set(selectedExtensions(scope).map((item) => item.id));
    const excluded = new Set<string>(BUILTINS.flatMap((item) => (selected.has(item.id) ? [] : [item.native])));
    return {
      extensions: this.#registry
        .snapshot()
        .installed()
        .filter((extension) => !excluded.has(extension.name)),
    };
  }
  async pins(conversation: ConversationId, harness: Harness, context: Context): Promise<ExtensionRequestPin[]> {
    const page = await (await harness.conversation(conversation, context))?.entries({}, 100, undefined, context);
    return (
      page?.items.flatMap((entry) => (entry.kind === "pal.extensions" ? [validate(RequestPin, entry.data)] : [])) ?? []
    );
  }
}
function digest(selected: ExtensionScope["selected"]): string {
  return createHash("sha256").update(JSON.stringify(selected)).digest("hex");
}
