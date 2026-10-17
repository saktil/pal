import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { type AgentChange, type ConversationId, createRegistry, Harness } from "@earendil-works/pi-durable";
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
import { Changes } from "./changes.ts";
import { FILES_NAMESPACE, fileTools, projectFiles } from "./files.ts";
import { HostCommands, SHELL_NAMESPACE, shellTools, WorkspaceLocks } from "./execution.ts";
import { Owner } from "./owner.ts";
import { type Project, Projects } from "./projects.ts";
import { ProjectSearch } from "./search.ts";
import { Uploads } from "./uploads.ts";
import { Terminals } from "./terminals.ts";

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
  readonly uploads: Uploads;
  readonly changes: Changes;
  /** The owner's read-only view of project folders for the Files panel. */
  readonly files: ReturnType<typeof projectFiles>;
  /** Shared lazy fff indexes for project folders. */
  readonly search: ProjectSearch;
  readonly terminals: Terminals;
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
  const commands = new HostCommands();
  const search = new ProjectSearch([options.dataRoot]);
  let changes: Changes | undefined;
  const locks = new WorkspaceLocks(async (root) => {
    await changes?.capture(root);
  });
  let harness: Harness | undefined;
  let sandbox: { close(): Promise<void> } | undefined;
  let mcp: McpManager | undefined;
  let terminals: Terminals | undefined;
  // The Harness, once open, owns the storage and closes it; scripts stop before their sandbox and connections do.
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await (harness === undefined ? store.close() : harness.close(context));
      } finally {
        search.close();
        await Promise.all([commands.close(), terminals?.close()]);
        await Promise.all([sandbox?.close(), mcp?.close()]);
      }
    })());
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

    // Host writes/commands are the owner's explicit high-trust mode; every nested call rechecks the live project grant.
    const projectFor = async (conversation: ConversationId) =>
      await database.get<{ id: string; root: string }>(
        "SELECT p.id, p.root FROM pal_chats c JOIN pal_projects p ON p.id = c.project_id WHERE c.conversation_id = ? AND c.deleted_at IS NULL AND p.removed_at IS NULL AND p.state = 'ready'",
        conversation,
      );
    const projectRoot = async (conversation: ConversationId) => (await projectFor(conversation))?.root;
    const codemode = createPalCodemode({
      allows: async (conversation, name) =>
        (await projectRoot(conversation)) !== undefined &&
        (name.startsWith(FILES_NAMESPACE.prefix) ||
          name === "shell_run" ||
          (await mcp?.allowsInConversation(conversation, name)) === true),
      namespaces: [FILES_NAMESPACE, SHELL_NAMESPACE],
    });
    sandbox = codemode.sandbox;
    const registry = createRegistry();
    for (const extension of codemode.extensions) registry.install(extension);
    registry.install(fileTools({ root: projectRoot, deny: [options.dataRoot], locks, search }));
    registry.install(shellTools({ root: projectRoot, commands, locks }));
    const connections = await McpManager.open({
      database: store.database,
      credentials,
      registry,
      projectId: async (conversation) => (await projectFor(conversation))?.id,
      codemode: (namespaces) => codemode.withNamespaces([FILES_NAMESPACE, SHELL_NAMESPACE, ...namespaces]),
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
    const openedProjects = await Projects.open({
      database,
      dataRoot: options.dataRoot,
      installRoot: options.installRoot,
    });
    changes = new Changes(database, openedProjects, options.dataRoot);
    const owner = new Owner(database);
    const reviews = changes;
    terminals = new Terminals(openedProjects, owner, (root) => reviews.capture(root));
    const uploads = await Uploads.open(database, options.dataRoot);
    const openedChats = await ChatService.open(
      {
        database,
        harness: running,
        attachments: uploads,
        agentFor: async (projectId) => {
          const project = await openedProjects.get(projectId);
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
      owner,
      projects: openedProjects,
      chats: openedChats,
      chatgpt: new ChatGPTConnection(credentials, {
        endpoints,
        installationId: store.installationId,
        agentName: "Pal",
      }),
      models,
      harness: running,
      settings,
      mcp: connections,
      uploads,
      changes,
      files: projectFiles({
        root: async (id) => {
          const project = await openedProjects.get(id);
          return project?.state === "ready" ? project.root : undefined;
        },
        deny: [options.dataRoot],
      }),
      terminals,
      search,
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
      "File writes and shell commands are available through Code Mode. Commands run as the host user, not in a sandbox. Never access Pal data or credentials. Inspect interrupted effects before retrying.",
      "Say plainly what you did and did not verify. Never claim a lookup, file read or action that did not happen.",
    ].join("\n"),
  };
}
