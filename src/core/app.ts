import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { type AgentChange, createRegistry, Harness } from "@earendil-works/pi-durable";
import {
  CHATGPT_PROVIDER,
  ChatGPTConnection,
  type ChatGPTEndpoints,
  chatGPTProvider,
  OPENAI_CHATGPT,
} from "../pi/chatgpt.ts";
import { createPalCodemode } from "../pi/codemode.ts";
import { McpManager } from "../pi/mcp.ts";
import { loadMasterKey, SqliteCredentialStore } from "../storage/credentials.ts";
import { openStore, type Store } from "../storage/store.ts";
import { ChatService } from "./chats.ts";
import { Owner } from "./owner.ts";
import { type Project, Projects } from "./projects.ts";

export type PalOptions = {
  readonly dataRoot: string;
  readonly installRoot: string;
  /** OpenAI's by default; tests point these at a loopback fixture. */
  readonly endpoints?: ChatGPTEndpoints;
};

/** One running installation: the store's single owner and every service built on it. */
export type Pal = {
  readonly store: Store;
  readonly owner: Owner;
  readonly projects: Projects;
  readonly chats: ChatService;
  readonly chatgpt: ChatGPTConnection;
  readonly models: Models;
  readonly harness: Harness;
  readonly settings: Settings;
  readonly mcp: McpManager;
  close(): Promise<void>;
};

export type Settings = {
  /** The ChatGPT model new chats start with. */
  model(): Promise<string | undefined>;
  setModel(slug: string): Promise<void>;
};

// Subscription mode never reads the process environment, so an ambient OPENAI_API_KEY cannot be picked up.
const NO_AMBIENT_AUTH = { env: async () => undefined, fileExists: async () => false };

export async function openPal(options: PalOptions, context: Context): Promise<Pal> {
  const store = await openStore(options.dataRoot);
  let harness: Harness | undefined;
  let sandbox: { close(): Promise<void> } | undefined;
  let mcp: McpManager | undefined;
  // The Harness, once open, owns the storage and closes it; scripts stop before their sandbox and connections do.
  const close = async () => {
    await (harness === undefined ? store.close() : harness.close(context));
    await sandbox?.close();
    await mcp?.close();
  };
  try {
    const { database } = store;
    const credentials = new SqliteCredentialStore(
      database,
      await loadMasterKey(join(options.dataRoot, "credentials.key")),
      store.installationId,
    );
    const endpoints = options.endpoints ?? OPENAI_CHATGPT;
    const models = createModels({ credentials, authContext: NO_AMBIENT_AUTH });
    models.setProvider(chatGPTProvider(endpoints));

    // Code Mode is always on; scripts may call only tools the MCP manager grants at the moment of each call.
    const codemode = createPalCodemode({ allows: (_conversation, name) => mcp?.allows(name) === true });
    sandbox = codemode.sandbox;
    const registry = createRegistry();
    for (const extension of codemode.extensions) registry.install(extension);
    const connections = await McpManager.open({
      database: store.database,
      credentials,
      registry,
      codemode: codemode.withNamespaces,
    });
    mcp = connections;
    const running = await Harness.open(store.storage, { models, registry }, context);
    harness = running;

    const settings: Settings = {
      model: async () =>
        (await database.get<{ value: string }>("SELECT value FROM pal_settings WHERE key = 'model'"))?.value,
      setModel: async (slug) => {
        await database.run(
          "INSERT INTO pal_settings (key, value) VALUES ('model', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          slug,
        );
      },
    };
    const projects = await Projects.open({ database, dataRoot: options.dataRoot, installRoot: options.installRoot });
    const chats = await ChatService.open(
      {
        database,
        harness: running,
        agentFor: async (projectId) => {
          const project = await projects.get(projectId);
          if (project?.state !== "ready") return undefined;
          const model = await settings.model();
          return agentFor(project, model);
        },
      },
      context,
    );
    running.resume();
    return {
      store,
      owner: new Owner(database),
      projects,
      chats,
      chatgpt: new ChatGPTConnection(credentials, {
        endpoints,
        installationId: store.installationId,
        agentName: "Pal",
      }),
      models,
      harness: running,
      settings,
      mcp: connections,
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

function agentFor(project: Project, model: string | undefined): AgentChange {
  return {
    ...(model === undefined ? {} : { model: { provider: CHATGPT_PROVIDER, modelId: model } }),
    cwd: project.root,
    instructions: [
      `You are Pal, the owner's personal assistant, working in the project "${project.name}".`,
      `The project's folder on the server is ${project.root}${project.mode === "managed" ? " (a workspace Pal manages)" : ""}.`,
      "Say plainly what you did and did not verify. Never claim a lookup, file read or action that did not happen.",
    ].join("\n"),
  };
}
