import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { clampThinkingLevel, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { type AgentEvent, watchEvents } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  CHATGPT_PROVIDER,
  type ChatGPTAccount,
  ChatGPTAuthError,
  type ChatGPTModel,
  listChatGPTModels,
} from "../pi/chatgpt.ts";
import { McpConfigError } from "../pi/mcp.ts";
import type { Pal } from "./app.ts";
import { AdmissionStopped, ChatNotFound, ProjectUnavailable } from "./chats.ts";
import { cookie, HttpError, isOwnOrigin, readJson, sendJson } from "./http.ts";
import { OwnerError, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "./owner.ts";
import { FileAccessError } from "./files.ts";
import { FolderError } from "./projects.ts";
import { InvalidRequest, RequestConflict, validate } from "./requests.ts";
import { UploadBody, UploadError } from "./uploads.ts";
import { TerminalSize } from "./terminals.ts";

const NewTerminal = Type.Object(
  { ...TerminalSize.properties, trust: Type.Literal(true) },
  { additionalProperties: false },
);
const HEARTBEAT_MS = 25_000;

const Passphrase = Type.Object({ passphrase: Type.String({ maxLength: 1024 }) }, { additionalProperties: false });
const Setup = Type.Object(
  { token: Type.String({ maxLength: 256 }), passphrase: Type.String({ maxLength: 1024 }) },
  { additionalProperties: false },
);
const Paste = Type.Object({ url: Type.String({ maxLength: 8192 }) }, { additionalProperties: false });
const ModelChoice = Type.Object(
  { model: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);
const ChatModelChoice = Type.Object(
  { ...ModelChoice.properties, effort: Type.Optional(Type.Enum(["off", "low", "medium", "high"])) },
  { additionalProperties: false },
);
const Keyed = Type.Object({ requestId: Type.Unknown() }, { additionalProperties: true });
const McpServerBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    auth: Type.Union([
      Type.Object({ kind: Type.Literal("none") }, { additionalProperties: false }),
      Type.Object(
        { kind: Type.Literal("header"), header: Type.String({ maxLength: 64 }) },
        { additionalProperties: false },
      ),
      Type.Object({ kind: Type.Literal("bearer") }, { additionalProperties: false }),
    ]),
    private: Type.Boolean(),
  },
  { additionalProperties: false },
);
const KeyBody = Type.Object({ key: Type.String({ maxLength: 4096 }) }, { additionalProperties: false });
const Toggle = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
const ToolChoice = Type.Object(
  { tools: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 128 }) },
  { additionalProperties: false },
);
const Review = Type.Object({ enable: Type.Boolean() }, { additionalProperties: false });
const FileReview = Type.Object(
  {
    path: Type.String({ maxLength: 4096 }),
    revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    reviewed: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** A sign-in in progress, bridging Pi's prompt/notify interaction to HTTP polling and a paste endpoint. */
class SignInAttempt {
  state: "waiting" | "verifying" | "connected" | "failed" | "cancelled" = "waiting";
  authUrl: string | undefined;
  error: { code: string; message: string } | undefined;
  readonly #controller = new AbortController();
  #paste: ((url: string) => void) | undefined;
  readonly #announced = Promise.withResolvers<undefined>();

  readonly interaction: ProviderAuthInteraction = {
    signal: this.#controller.signal,
    notify: (event) => {
      if (event.type === "auth_url") {
        this.authUrl = event.url;
        this.#announced.resolve(undefined);
      } else if (event.type === "progress") {
        this.state = "verifying";
      }
    },
    prompt: (prompt) =>
      new Promise((resolve, reject) => {
        this.#paste = resolve;
        prompt.signal?.addEventListener("abort", () => reject(new Error("prompt closed")), { once: true });
      }),
  };

  get active(): boolean {
    return this.state === "waiting" || this.state === "verifying";
  }

  /** Resolves once the browser link exists, or the attempt has already ended. */
  announced(): Promise<void> {
    return this.#announced.promise;
  }

  paste(url: string): void {
    if (this.#paste === undefined)
      throw new HttpError(409, "not_waiting", "this sign-in is not waiting for an address");
    this.#paste(url);
  }

  cancel(): void {
    this.#controller.abort();
  }

  settle(outcome: { account: ChatGPTAccount } | { error: unknown }): void {
    if ("account" in outcome) {
      this.state = "connected";
    } else {
      const error = outcome.error;
      const code = error instanceof ChatGPTAuthError ? error.code : "failed";
      this.state = code === "cancelled" ? "cancelled" : "failed";
      this.error = { code, message: error instanceof Error ? error.message : String(error) };
    }
    this.#announced.resolve(undefined);
  }
}

/**
 * Pal's JSON API. Everything except health, session state, setup and sign-in requires the owner's session; every
 * state-changing request must come from Pal's own origin.
 */
export function createApi(pal: Pal, publicOrigin?: string) {
  const external = publicOrigin === undefined ? undefined : new URL(publicOrigin);
  let attempt: SignInAttempt | undefined;
  let listing: { models: ChatGPTModel[] } | { error: string } | undefined;

  async function refreshListing(): Promise<void> {
    try {
      const models = await listChatGPTModels(pal.models);
      listing = { models };
      const first = models.find((model) => model.supported);
      if ((await pal.settings.model()) === undefined && first !== undefined) await pal.settings.setModel(first.slug);
    } catch (error) {
      listing = { error: (error as Error).message };
    }
  }

  async function chatgptState() {
    const account = await pal.chatgpt.account();
    if (account !== undefined && listing === undefined) await refreshListing();
    return {
      account: account ?? null,
      attempt:
        attempt === undefined
          ? null
          : { state: attempt.state, authUrl: attempt.authUrl ?? null, error: attempt.error ?? null },
      models: account === undefined ? [] : listing !== undefined && "models" in listing ? listing.models : [],
      modelsError: account !== undefined && listing !== undefined && "error" in listing ? listing.error : null,
      model: (await pal.settings.model()) ?? null,
    };
  }

  async function signedIn(request: IncomingMessage): Promise<boolean> {
    return await pal.owner.authenticate(cookie(request, SESSION_COOKIE));
  }

  function setSession(response: ServerResponse, token: string, request: IncomingMessage): void {
    response.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${external?.protocol === "https:" && request.headers.host === external.host ? "; Secure" : ""}`,
    );
  }

  async function route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    const path = url.pathname.split("/").filter(Boolean).slice(1);
    const [resource, id, action] = path;
    const send = (status: number, body: unknown) => sendJson(request, response, status, body);
    if (method !== "GET" && method !== "HEAD" && !isOwnOrigin(request, external)) {
      throw new HttpError(403, "cross_origin", "requests must come from Pal's own page");
    }

    if (resource === "session" && path.length === 1 && method === "GET") {
      const exists = await pal.owner.exists();
      return send(200, { owner: exists, signedIn: exists && (await signedIn(request)) });
    }
    if (resource === "setup" && path.length === 1 && method === "POST") {
      const body = validate(Setup, await readJson(request));
      setSession(response, await pal.owner.setup(body.token, body.passphrase), request);
      return send(200, { signedIn: true });
    }
    if (resource === "sign-in" && path.length === 1 && method === "POST") {
      const body = validate(Passphrase, await readJson(request));
      setSession(response, await pal.owner.signIn(body.passphrase), request);
      return send(200, { signedIn: true });
    }
    if (!(await signedIn(request))) throw new HttpError(401, "signed_out", "sign in to Pal first");

    if (resource === "sign-out" && path.length === 1 && method === "POST") {
      pal.terminals.revoke(cookie(request, SESSION_COOKIE));
      await pal.owner.signOut(cookie(request, SESSION_COOKIE));
      response.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return send(200, { signedIn: false });
    }

    if (resource === "chatgpt") {
      if (path.length === 1 && method === "GET") return send(200, await chatgptState());
      if (id === "sign-in" && action === undefined && method === "POST") {
        if (attempt?.active) throw new HttpError(409, "busy", "a ChatGPT sign-in is already in progress");
        const started = new SignInAttempt();
        attempt = started;
        pal.chatgpt.signIn(started.interaction).then(
          async (account) => {
            started.settle({ account });
            listing = undefined;
            await refreshListing();
          },
          (error: unknown) => started.settle({ error }),
        );
        await started.announced();
        return send(200, await chatgptState());
      }
      if (id === "sign-in" && action === "paste" && method === "POST") {
        if (!attempt?.active) throw new HttpError(409, "not_waiting", "no ChatGPT sign-in is waiting");
        attempt.paste(validate(Paste, await readJson(request)).url);
        return send(200, await chatgptState());
      }
      if (id === "sign-in" && action === undefined && method === "DELETE") {
        attempt?.cancel();
        return send(200, await chatgptState());
      }
      if (id === "sign-out" && method === "POST") {
        await pal.chatgpt.signOut();
        listing = undefined;
        return send(200, await chatgptState());
      }
      if (id === "model" && method === "PUT") {
        const { model } = validate(ModelChoice, await readJson(request));
        await pal.settings.setModel(model);
        return send(200, await chatgptState());
      }
    }

    if (resource === "mcp") {
      const [, , serverId, part] = path;
      const listing = async () => ({ review: await pal.mcp.reviewPending(), servers: await pal.mcp.list() });
      if (path.length === 1 && method === "GET") return send(200, await listing());
      if (id === "review" && method === "POST") {
        await pal.mcp.finishReview(validate(Review, await readJson(request)).enable);
        return send(200, await listing());
      }
      if (id === "servers" && serverId === undefined && method === "POST") {
        return send(200, { server: await pal.mcp.add(validate(McpServerBody, await readJson(request))) });
      }
      if (id === "servers" && serverId !== undefined) {
        if (part === undefined && method === "PUT") {
          return send(200, {
            server: await pal.mcp.update(serverId, validate(McpServerBody, await readJson(request))),
          });
        }
        if (part === undefined && method === "DELETE") {
          await pal.mcp.remove(serverId);
          return send(200, await listing());
        }
        if (part === "key" && method === "PUT") {
          return send(200, { server: await pal.mcp.setKey(serverId, validate(KeyBody, await readJson(request)).key) });
        }
        if (part === "key" && method === "DELETE") return send(200, { server: await pal.mcp.setKey(serverId, null) });
        if (part === "fake-ip" && method === "PUT") {
          return send(200, {
            server: await pal.mcp.setFakeIp(serverId, validate(Toggle, await readJson(request)).enabled),
          });
        }
        if (part === "enabled" && method === "PUT") {
          const { enabled } = validate(Toggle, await readJson(request));
          return send(200, { server: await pal.mcp.setEnabled(serverId, enabled) });
        }
        if (part === "test" && method === "POST") return send(200, { server: await pal.mcp.test(serverId) });
        if (part === "tools" && method === "PUT") {
          return send(200, {
            server: await pal.mcp.approve(serverId, validate(ToolChoice, await readJson(request)).tools),
          });
        }
      }
    }

    if (resource === "projects" && path.length === 1) {
      if (method === "GET") {
        const projects = await pal.projects.list();
        return send(200, {
          projects: await Promise.all(
            projects.map(async (project) => ({ ...project, chats: await pal.chats.list(project.id) })),
          ),
        });
      }
      if (method === "POST") {
        const { requestId, ...body } = validate(Keyed, await readJson(request));
        return send(200, { project: await pal.projects.create(requestId, body) });
      }
    }
    if (resource === "projects" && id !== undefined && action === "mcp") {
      if (path.length === 3 && method === "GET") return send(200, await pal.mcp.grants.view(id));
      if (path.length === 4 && path[3] !== undefined && method === "PUT")
        return send(200, await pal.mcp.grants.set(id, path[3], await readJson(request)));
    }
    if (resource === "projects" && id !== undefined && action === "terminals") {
      if (path.length === 3 && method === "GET") return send(200, { terminals: await pal.terminals.list(id) });
      if (path.length === 3 && method === "POST") {
        const { cols, rows } = validate(NewTerminal, await readJson(request));
        return send(200, { terminal: await pal.terminals.create(id, { cols, rows }) });
      }
      if (path.length === 4 && path[3] !== undefined && method === "DELETE") {
        await pal.terminals.remove(id, path[3]);
        return send(200, { closed: true });
      }
    }
    if (resource === "projects" && id !== undefined && (action === "files" || action === "file") && path.length === 3) {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "the Files panel is read-only");
      const relative = url.searchParams.get("path") ?? "";
      if (relative.length > 4096) throw new HttpError(400, "invalid_request", "path is too long");
      try {
        return send(
          200,
          action === "files" ? await pal.files.list(id, relative) : await pal.files.preview(id, relative),
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM")
          throw new FileAccessError(`Pal cannot read ${relative || "this folder"}`);
        throw error;
      }
    }
    if (resource === "projects" && id !== undefined && action === "changes" && path.length === 3 && method === "GET") {
      return send(200, await pal.changes.list(id));
    }
    if (resource === "projects" && id !== undefined && action === "review" && path.length === 3 && method === "PUT") {
      const body = validate(FileReview, await readJson(request));
      await pal.changes.review(id, body.path, body.revision, body.reviewed);
      return send(200, { reviewed: body.reviewed });
    }
    if (resource === "projects" && id !== undefined && action === undefined && method === "DELETE") {
      await pal.projects.remove(id);
      pal.mcp.revokeProject(id);
      await Promise.all([pal.terminals.removeProject(id), pal.chats.abortDeleted(context)]);
      return send(200, { removed: true });
    }
    if (resource === "projects" && id !== undefined && action === "uploads" && method === "POST") {
      const project = await pal.projects.get(id);
      if (project?.state !== "ready") throw new HttpError(404, "not_found", "no such ready project");
      return send(200, { upload: await pal.uploads.admit(id, validate(UploadBody, await readJson(request))) });
    }
    if (resource === "uploads" && id !== undefined && action === undefined && method === "PUT") {
      return send(200, { upload: await pal.uploads.receive(id, request) });
    }

    if (resource === "folders" && path.length === 1 && method === "GET") {
      return send(200, await pal.projects.browse(url.searchParams.get("path") ?? undefined));
    }

    if (resource === "chats") {
      if (path.length === 1 && method === "POST") {
        const { requestId, ...body } = validate(Keyed, await readJson(request));
        const chat = await pal.chats.createChat(requestId, body, context);
        return send(200, { chat: await pal.chats.get(chat.id) });
      }
      if (id !== undefined && action === undefined && method === "DELETE") {
        await pal.chats.remove(id, context);
        return send(200, { removed: true });
      }
      const chat = id === undefined ? undefined : await pal.chats.get(id);
      if (chat === undefined) throw new HttpError(404, "not_found", "no such chat");
      const conversation = await pal.harness.conversation(chat.conversationId, context);
      if (conversation === undefined) throw new HttpError(404, "not_found", "the chat's conversation is missing");
      if (action === undefined && method === "GET") {
        const agent = await conversation.agent(context);
        const model =
          agent.model === undefined ? undefined : pal.models.getModel(CHATGPT_PROVIDER, agent.model.modelId);
        return send(200, {
          chat,
          model: agent.model?.modelId ?? null,
          effort: model === undefined ? "off" : clampThinkingLevel(model, agent.thinkingLevel),
        });
      }
      if (action === "inputs" && method === "POST") {
        const { requestId, ...body } = validate(Keyed, await readJson(request));
        return send(200, { admission: await pal.chats.submit(chat.id, requestId, body, context) });
      }
      if (action === "stop" && method === "POST") {
        await conversation.abort(context);
        return send(200, { stopped: true });
      }
      if (action === "model" && method === "PUT") {
        const { model, effort: requested } = validate(ChatModelChoice, await readJson(request));
        const known = pal.models.getModel(CHATGPT_PROVIDER, model);
        if (known === undefined)
          throw new HttpError(400, "unknown_model", "Pal does not know this model’s capabilities");
        const effort = clampThinkingLevel(known, requested ?? (await conversation.agent(context)).thinkingLevel);
        await conversation.configure(
          { model: { provider: CHATGPT_PROVIDER, modelId: model }, thinkingLevel: effort },
          context,
        );
        return send(200, { chat, model, effort });
      }
      if (action === "events" && method === "GET") return await observe(request, response, chat.conversationId);
    }
    throw new HttpError(404, "not_found", "no such API route");
  }

  /** Server-sent events: the conversation's snapshot, then one event batch per commit until the client leaves. */
  async function observe(
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: Parameters<typeof watchEvents>[1],
  ): Promise<void> {
    const stream = await watchEvents(pal.harness, conversationId, context);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    const write = async (event: string, data: unknown) => {
      if (!response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
        await new Promise((resolve) => response.once("drain", resolve));
      }
    };
    await write("snapshot", stream.snapshot);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), HEARTBEAT_MS);
    stream.start(async (events: readonly AgentEvent[]) => {
      // An overflowed watch replaces its undelivered batches with a snapshot, which the client applies as a reset.
      for (const event of events) await write(event.type === "snapshot" ? "snapshot" : "event", event);
    });
    const end = () => {
      clearInterval(heartbeat);
      void stream.stop();
    };
    request.once("close", end);
    void stream.closed.then(() => {
      end();
      response.end();
    });
  }

  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    try {
      await route(request, response, url);
    } catch (error) {
      const [status, code] = classify(error);
      if (status >= 500) console.error(error);
      if (!response.headersSent) {
        sendJson(request, response, status, { error: code, message: (error as Error).message });
      } else {
        response.end();
      }
    }
  };
}

function classify(error: unknown): [number, string] {
  if (error instanceof HttpError) return [error.status, error.code];
  if (error instanceof InvalidRequest) return [400, "invalid_request"];
  if (error instanceof RequestConflict) return [409, "request_conflict"];
  if (error instanceof ChatNotFound) return [404, "not_found"];
  if (error instanceof ProjectUnavailable) return [409, "project_unavailable"];
  if (error instanceof FolderError) return [422, `folder_${error.code}`];
  if (error instanceof AdmissionStopped) return [503, "admission_stopped"];
  if (error instanceof McpConfigError) return [400, "mcp_config"];
  if (error instanceof FileAccessError) return [403, "file_access"];
  if (error instanceof UploadError) {
    const status = { not_found: 404, too_large: 413, size_mismatch: 400, not_receiving: 409, not_ready: 409 };
    return [status[error.code], `upload_${error.code}`];
  }
  if (error instanceof ChatGPTAuthError) return [400, `chatgpt_${error.code}`];
  if (error instanceof OwnerError) {
    const status = { exists: 409, invalid_setup: 403, weak_passphrase: 400, wrong_passphrase: 401, throttled: 429 };
    return [status[error.code], error.code];
  }
  return [500, "internal"];
}
