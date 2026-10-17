import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  type AgentChange,
  type ConversationId,
  defineDocFamily,
  type Harness,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

export const MAX_INPUT_CHARS = 100_000;

const RequestId = Type.String({ pattern: "^[A-Za-z0-9_-]{8,128}$" });
export const ChatBody = Type.Object(
  { title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) },
  {
    additionalProperties: false,
  },
);
export const InputBody = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: MAX_INPUT_CHARS }),
    whenBusy: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")])),
  },
  { additionalProperties: false },
);
export type ChatBody = Static<typeof ChatBody>;
export type InputBody = Static<typeof InputBody>;

/** A body that fails its schema, or a malformed request ID. */
export class InvalidRequest extends Error {}
/** A request ID already admitted with a different body. */
export class RequestConflict extends Error {}
export class ChatNotFound extends Error {}
/** Admission stopped after a storage failure; the process must restart and reconcile before admitting again. */
export class AdmissionStopped extends Error {}

/** Crash points between Pal's and Pi's commits, for deterministic recovery tests. */
export type Barrier = "chat-recorded" | "chat-created" | "input-recorded" | "input-submitted";

export type Chat = { readonly id: string; readonly conversationId: ConversationId };
export type Admission = { readonly chatId: string; readonly requestId: string; readonly submissionId: SubmissionId };

/**
 * The Pal chat each Pi conversation was created for, written in the commit that creates the conversation: Pi has no
 * caller-chosen conversation IDs, so this is how a crash before Pal records the mapping is found again.
 */
const ChatDoc = defineDocFamily({
  kind: "pal.chat",
  version: 1,
  scope: "session",
  family: true,
  initial: (conversationId: ConversationId) => ({ conversationId }),
});

class AlreadyProvisioned extends Error {}

export type ChatServiceOptions = {
  readonly database: SqliteDatabase;
  readonly harness: Harness;
  /** Agent settings for new conversations. */
  readonly agent: AgentChange;
  readonly barrier?: (point: Barrier) => void | Promise<void>;
};

/**
 * Chats and input admission across Pal's tables and Pi's store, which commit separately. Every request is first
 * recorded with its normalized body, then completed in Pi with stable keys, so a crash between the two commits is
 * finished by `open()` instead of duplicated or lost. A request is acknowledged only once Pi has admitted it.
 */
export class ChatService {
  readonly #options: ChatServiceOptions;
  #failure: unknown;

  private constructor(options: ChatServiceOptions) {
    this.#options = options;
  }

  /** Complete every chat and input recorded before a crash, in recorded order, before admitting anything new. */
  static async open(options: ChatServiceOptions, context: Context): Promise<ChatService> {
    const service = new ChatService(options);
    const chats = await service.#guard((db) =>
      db.all<{ id: string }>("SELECT id FROM pal_chats WHERE state = 'provisioning' ORDER BY rowid"),
    );
    for (const { id } of chats) await service.#provision(id, context);
    const inputs = await service.#guard((db) =>
      db.all<{ chat_id: string; request_id: string; intent: string }>(
        "SELECT chat_id, request_id, intent FROM pal_admissions WHERE state = 'admitting' ORDER BY seq",
      ),
    );
    for (const row of inputs) await service.#admit(row.chat_id, row.request_id, JSON.parse(row.intent), context);
    return service;
  }

  get stopped(): boolean {
    return this.#failure !== undefined;
  }

  async createChat(requestId: unknown, body: unknown, context: Context): Promise<Chat> {
    const { key, intent, digest } = normalize(requestId, ChatBody, body, (value) => ({ title: value.title ?? null }));
    const row = await this.#guard((db) =>
      db.transaction(async (tx) => {
        const existing = await tx.get<ChatRow>(
          "SELECT id, digest, conversation_id FROM pal_chats WHERE request_id = ?",
          key,
        );
        if (existing !== undefined) return existing;
        const id = randomUUID();
        await tx.run(
          "INSERT INTO pal_chats (id, request_id, digest, intent, state, created_at) VALUES (?, ?, ?, ?, 'provisioning', ?)",
          id,
          key,
          digest,
          intent,
          Date.now(),
        );
        return { id, digest, conversation_id: null };
      }),
    );
    if (row.digest !== digest) throw new RequestConflict(`request ${key} created a different chat`);
    if (row.conversation_id !== null) return { id: row.id, conversationId: row.conversation_id };
    await this.#options.barrier?.("chat-recorded");
    return await this.#provision(row.id, context);
  }

  /** Admit one input; repeating a request ID with the same body returns the same submission. */
  async submit(chatId: string, requestId: unknown, body: unknown, context: Context): Promise<Admission> {
    const { key, intent, digest } = normalize(requestId, InputBody, body, (value) => ({
      text: value.text,
      whenBusy: value.whenBusy ?? "followUp",
    }));
    const row = await this.#guard((db) =>
      db.transaction(async (tx) => {
        const chat = await tx.get<{ state: string }>("SELECT state FROM pal_chats WHERE id = ?", chatId);
        if (chat?.state !== "ready") return undefined;
        const existing = await tx.get<AdmissionRow>(
          "SELECT digest, intent, submission_id FROM pal_admissions WHERE chat_id = ? AND request_id = ?",
          chatId,
          key,
        );
        if (existing !== undefined) return existing;
        await tx.run(
          "INSERT INTO pal_admissions (chat_id, request_id, digest, intent, state, created_at) VALUES (?, ?, ?, ?, 'admitting', ?)",
          chatId,
          key,
          digest,
          intent,
          Date.now(),
        );
        return { digest, intent, submission_id: null };
      }),
    );
    if (row === undefined) throw new ChatNotFound(`chat ${chatId} does not exist`);
    if (row.digest !== digest) throw new RequestConflict(`request ${key} was admitted with a different body`);
    if (row.submission_id !== null) return { chatId, requestId: key, submissionId: row.submission_id };
    await this.#options.barrier?.("input-recorded");
    return await this.#admit(chatId, key, JSON.parse(row.intent), context);
  }

  /** Create the chat's conversation unless an earlier attempt did, then record the mapping. */
  async #provision(chatId: string, context: Context): Promise<Chat> {
    const conversationId = await this.#guard(async () => {
      try {
        const conversation = await this.#options.harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: this.#options.agent,
            init: async (tx, id) => {
              // Pi serializes commits, so this check and the creation it rolls back are atomic.
              if ((await tx.doc(ChatDoc, chatId, id)).conversationId !== id) throw new AlreadyProvisioned();
            },
          },
          context,
        );
        return conversation.id;
      } catch (error) {
        if (!(error instanceof AlreadyProvisioned)) throw error;
        const existing = await this.#options.harness.snapshot(ChatDoc, chatId, context);
        if (existing === undefined) throw new Error(`chat ${chatId} lost its conversation`, { cause: error });
        return existing.conversationId;
      }
    });
    await this.#options.barrier?.("chat-created");
    await this.#guard((db) =>
      db.run("UPDATE pal_chats SET state = 'ready', conversation_id = ? WHERE id = ?", conversationId, chatId),
    );
    return { id: chatId, conversationId };
  }

  /** Submit under the same request ID, which Pi deduplicates per conversation, then record the acknowledgement. */
  async #admit(chatId: string, requestId: string, intent: Required<InputBody>, context: Context): Promise<Admission> {
    const submissionId = await this.#guard(async (db) => {
      const row = await db.get<{ conversation_id: ConversationId }>(
        "SELECT conversation_id FROM pal_chats WHERE id = ?",
        chatId,
      );
      const conversation =
        row === undefined ? undefined : await this.#options.harness.conversation(row.conversation_id, context);
      if (conversation === undefined) throw new Error(`chat ${chatId} has no conversation`);
      const submission = await conversation.submit(
        { type: "input", requestId, content: intent.text, whenBusy: intent.whenBusy },
        context,
      );
      return submission.id;
    });
    await this.#options.barrier?.("input-submitted");
    await this.#guard((db) =>
      db.run(
        "UPDATE pal_admissions SET state = 'admitted', submission_id = ? WHERE chat_id = ? AND request_id = ?",
        submissionId,
        chatId,
        requestId,
      ),
    );
    return { chatId, requestId, submissionId };
  }

  /**
   * Run storage work, Pal's or Pi's. The first failure stops admission: a failed commit's outcome is unknown, and Pi
   * closes its Session on one. Restarting reconciles, since every step is keyed and safe to complete again.
   */
  async #guard<T>(work: (db: SqliteDatabase) => Promise<T>): Promise<T> {
    if (this.#failure !== undefined) throw new AdmissionStopped("admission stopped after a storage failure");
    try {
      return await work(this.#options.database);
    } catch (error) {
      this.#failure ??= error;
      throw new AdmissionStopped("admission stopped after a storage failure", { cause: error });
    }
  }
}

type ChatRow = { id: string; digest: string; conversation_id: ConversationId | null };
type AdmissionRow = { digest: string; intent: string; submission_id: SubmissionId | null };

/** Validate, then serialize the fields in a fixed order with defaults applied, so equal requests digest equally. */
function normalize<S extends TSchema, N>(
  requestId: unknown,
  schema: S,
  body: unknown,
  fields: (value: Static<S>) => N,
): { key: string; intent: string; digest: string } {
  if (!Value.Check(RequestId, requestId)) throw new InvalidRequest("request ID must be 8-128 letters, digits, _ or -");
  if (!Value.Check(schema, body)) {
    throw new InvalidRequest(
      Value.Errors(schema, body)
        .map((error) => `${error.instancePath} ${error.message}`)
        .join("; "),
    );
  }
  const intent = JSON.stringify(fields(body));
  return { key: requestId, intent, digest: createHash("sha256").update(intent).digest("hex") };
}
