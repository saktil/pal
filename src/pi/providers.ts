import {
  type Api,
  type ApiKeyAuth,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SqliteCredentialStore } from "../storage/credentials.ts";

/**
 * Optional API-key providers beside the ChatGPT subscription. Each is off until the owner saves a key and enables it;
 * none is ever chosen for a chat, or substituted after a failure, without an explicit owner choice.
 */
export const API_PROVIDERS = {
  openrouter: {
    name: "OpenRouter",
    billing: "Pay per token from your OpenRouter credits.",
    keys: "https://openrouter.ai/settings/keys",
    create: openrouterProvider,
  },
  opencode: {
    name: "OpenCode Zen",
    billing: "Pay as you go from your OpenCode balance.",
    keys: "https://opencode.ai/auth",
    create: opencodeProvider,
  },
  "opencode-go": {
    name: "OpenCode Go",
    billing:
      "Counts against your OpenCode Go subscription limits, and your OpenCode balance only if you turned on Use balance there.",
    keys: "https://opencode.ai/auth",
    create: opencodeGoProvider,
  },
} as const satisfies Record<string, { name: string; billing: string; keys: string; create: () => Provider }>;
export type ApiProviderId = keyof typeof API_PROVIDERS;
export const API_PROVIDER_IDS = Object.keys(API_PROVIDERS) as ApiProviderId[];

export type ProviderModel = {
  readonly id: string;
  readonly name: string;
  readonly efforts: readonly ModelThinkingLevel[];
  readonly images: boolean;
};
export type ProviderView = {
  readonly id: ApiProviderId;
  readonly name: string;
  readonly billing: string;
  readonly keys: string;
  readonly hasKey: boolean;
  readonly enabled: boolean;
  /** Chat models Pi knows for this provider; listed only while enabled. */
  readonly models: readonly ProviderModel[];
};
export type KeyCheck = { readonly ok: true; readonly detail: string } | { readonly ok: false; readonly detail: string };

export class ProviderConfigError extends Error {}

const KEY = /^[\x21-\x7e]{8,4096}$/;
const SETTING = (id: ApiProviderId) => `provider:${id}`;
const CHECK_TIMEOUT_MS = 10_000;
const OPENROUTER_ORIGIN = "https://openrouter.ai";
/** The fields Pal shows from OpenRouter's `GET /api/v1/key`; `limit` is null for an unlimited key. */
const KeyUsage = Type.Object({
  data: Type.Object({
    usage: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  }),
});

export function isApiProvider(id: string): id is ApiProviderId {
  return Object.hasOwn(API_PROVIDERS, id);
}

/** Only the key the owner saved in Pal: never a process environment variable, so nothing ambient is picked up. */
function storedKeyOnly(name: string): ApiKeyAuth {
  return {
    name,
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted();
      return credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined;
    },
  };
}

/**
 * Pi's provider with stored-key auth only (no OAuth or environment). `origin` replaces each model's scheme and host,
 * so tests reach a loopback fixture through the provider's real request code.
 */
export function apiKeyProvider(id: ApiProviderId, origin?: string): Provider {
  const base = API_PROVIDERS[id].create() as Provider<Api>;
  const rebase = <T extends { baseUrl?: string }>(model: T): T =>
    origin === undefined || model.baseUrl === undefined
      ? model
      : { ...model, baseUrl: model.baseUrl.replace(/^https:\/\/[^/]+/, origin) };
  return {
    ...base,
    auth: { apiKey: storedKeyOnly(`${API_PROVIDERS[id].name} API key`) },
    getModels: () => base.getModels().map(rebase),
    stream: (model, context, options) => scrub(base.stream(model, context, options), options?.apiKey),
    streamSimple: (model, context, options) => scrub(base.streamSimple(model, context, options), options?.apiKey),
    ...(base.getAllModels === undefined ? {} : { getAllModels: () => (base.getAllModels?.() ?? []).map(rebase) }),
  };
}

/** A service that echoes the key in an error body must not get it into the transcript, retry notice or UI. */
function scrub(source: AssistantMessageEventStream, key: string | undefined): AssistantMessageEventStream {
  if (key === undefined || key === "") return source;
  const clean = (message: AssistantMessage): AssistantMessage =>
    message.errorMessage?.includes(key) === true
      ? { ...message, errorMessage: message.errorMessage.replaceAll(key, "[redacted key]") }
      : message;
  const scrubbed = createAssistantMessageEventStream();
  void (async () => {
    let terminal = false;
    for await (const event of source) {
      terminal ||= event.type === "done" || event.type === "error";
      scrubbed.push(event.type === "error" ? { ...event, error: clean(event.error) } : event);
    }
    scrubbed.end(terminal ? undefined : clean(await source.result()));
  })();
  return scrubbed;
}

/** The owner's API-key providers: encrypted keys, explicit enablement and the Pi registration that follows it. */
export class ModelProviders {
  readonly #database: SqliteDatabase;
  readonly #credentials: SqliteCredentialStore;
  readonly #models: MutableModels;
  readonly #origin: string | undefined;

  private constructor(
    database: SqliteDatabase,
    credentials: SqliteCredentialStore,
    models: MutableModels,
    origin: string | undefined,
  ) {
    this.#database = database;
    this.#credentials = credentials;
    this.#models = models;
    this.#origin = origin;
  }

  /** Register the providers the owner left enabled with a saved key. */
  static async open(options: {
    database: SqliteDatabase;
    credentials: SqliteCredentialStore;
    models: MutableModels;
    /** Tests point every provider at a loopback origin. */
    origin?: string;
  }): Promise<ModelProviders> {
    const providers = new ModelProviders(options.database, options.credentials, options.models, options.origin);
    for (const id of API_PROVIDER_IDS) if (await providers.usable(id)) providers.#register(id);
    return providers;
  }

  async list(): Promise<ProviderView[]> {
    return Promise.all(
      API_PROVIDER_IDS.map(async (id) => {
        const { name, billing, keys } = API_PROVIDERS[id];
        const hasKey = (await this.#credentials.read(id))?.type === "api_key";
        const enabled = hasKey && (await this.#enabled(id));
        return { id, name, billing, keys, hasKey, enabled, models: enabled ? this.#catalog(id) : [] };
      }),
    );
  }

  /** Whether chats may send to this provider now: a saved key and the owner's enablement. */
  async usable(id: ApiProviderId): Promise<boolean> {
    return (await this.#credentials.read(id))?.type === "api_key" && (await this.#enabled(id));
  }

  /** Save or replace a key (the next request uses it), or remove it, which also disables the provider. */
  async setKey(id: ApiProviderId, key: string | null): Promise<void> {
    if (key === null) {
      await this.setEnabled(id, false);
      await this.#credentials.forget(id);
      return;
    }
    const trimmed = key.trim();
    if (!KEY.test(trimmed)) throw new ProviderConfigError("the key must be 8–4096 printable characters, no spaces");
    await this.#credentials.modify(id, async () => ({ type: "api_key", key: trimmed }));
  }

  async setEnabled(id: ApiProviderId, enabled: boolean): Promise<void> {
    if (enabled && (await this.#credentials.read(id))?.type !== "api_key")
      throw new ProviderConfigError(`save a ${API_PROVIDERS[id].name} key before enabling it`);
    await this.#database.run(
      "INSERT INTO pal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      SETTING(id),
      enabled ? "enabled" : "disabled",
    );
    if (enabled) this.#register(id);
    else this.#models.deleteProvider(id);
  }

  /**
   * Ask the provider about the saved key without a model request. Only OpenRouter documents such a check
   * (`GET /api/v1/key`); OpenCode keys are checked by their first real request.
   */
  async check(id: ApiProviderId): Promise<KeyCheck> {
    const credential = await this.#credentials.read(id);
    if (credential?.type !== "api_key") throw new ProviderConfigError(`no ${API_PROVIDERS[id].name} key is saved`);
    if (id !== "openrouter") return { ok: false, detail: "OpenCode has no key check; the first message tests it." };
    let response: Response;
    try {
      response = await fetch(`${this.#origin ?? OPENROUTER_ORIGIN}/api/v1/key`, {
        headers: { authorization: `Bearer ${credential.key}` },
        redirect: "error",
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, detail: "Pal couldn't reach OpenRouter to check this key." };
    }
    if (response.status === 401 || response.status === 403)
      return { ok: false, detail: "OpenRouter rejected this key." };
    if (!response.ok) return { ok: false, detail: `OpenRouter answered HTTP ${response.status}.` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const usage = Value.Check(KeyUsage, body) ? body.data : {};
    let detail = "OpenRouter accepted this key.";
    if (usage.usage !== undefined) detail += ` Reported usage: ${usage.usage} credits`;
    if (usage.usage !== undefined && usage.limit != null) detail += ` of a ${usage.limit} credit limit.`;
    else if (usage.usage !== undefined) detail += ".";
    return { ok: true, detail };
  }

  #register(id: ApiProviderId): void {
    this.#models.setProvider(apiKeyProvider(id, this.#origin));
  }

  async #enabled(id: ApiProviderId): Promise<boolean> {
    const row = await this.#database.get<{ value: string }>(
      "SELECT value FROM pal_settings WHERE key = ?",
      SETTING(id),
    );
    return row?.value === "enabled";
  }

  #catalog(id: ApiProviderId): ProviderModel[] {
    return this.#models.getModels(id).map((model: Model<Api>) => ({
      id: model.id,
      name: model.name,
      efforts: getSupportedThinkingLevels(model),
      images: model.input.includes("image"),
    }));
  }
}
