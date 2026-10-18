import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { Type } from "typebox";
import { HttpError } from "./http.ts";
import { validate } from "./requests.ts";

const Operation = Type.Enum([
  "view",
  "review",
  "approve",
  "activate",
  "rollback",
  "online",
  "prepare",
  "resume",
  "promote",
]);
export type ReleaseOperation = import("typebox").Static<typeof Operation>;
const Id = Type.String({ pattern: "^[a-f0-9-]{36}$" });
const Message = Type.Union([
  Type.Object(
    { kind: Type.Literal("pal.release.call"), id: Id, op: Operation, args: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("pal.release.result"), id: Id, value: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("pal.release.error"),
      id: Id,
      status: Type.Integer({ minimum: 400, maximum: 599 }),
      message: Type.String({ maxLength: 1000 }),
    },
    { additionalProperties: false },
  ),
]);
type WireMessage = import("typebox").Static<typeof Message>;
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

/** Only the inherited Node IPC channel, never a listener, tool or second database connection. */
export class ReleaseRpc {
  readonly #events: EventEmitter;
  readonly #send: (message: WireMessage) => void;
  readonly #handle: (op: ReleaseOperation, args: unknown) => Promise<unknown>;
  readonly #pending = new Map<string, Pending>();
  readonly #receiving = new Set<string>();
  #closed = false;

  constructor(
    events: EventEmitter,
    send: (message: WireMessage) => void,
    handle: (op: ReleaseOperation, args: unknown) => Promise<unknown>,
  ) {
    this.#events = events;
    this.#send = send;
    this.#handle = handle;
    events.on("message", this.#receive);
    events.once("disconnect", this.close);
    events.once("exit", this.close);
  }

  call(op: ReleaseOperation, args: unknown = {}, timeoutMs = 20 * 60_000): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new HttpError(503, "release_disconnected", "Release supervisor disconnected."));
    if (this.#pending.size >= 8)
      return Promise.reject(new HttpError(429, "release_limit", "Too many release requests."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HttpError(504, "release_timeout", "Release supervisor did not answer in time."));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#post({ kind: "pal.release.call", id, op, args });
      } catch {
        this.close();
      }
    });
  }

  close = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.#events.off("message", this.#receive);
    this.#events.off("disconnect", this.close);
    this.#events.off("exit", this.close);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HttpError(503, "release_disconnected", "Release supervisor disconnected."));
    }
    this.#pending.clear();
  };

  #post(message: WireMessage): void {
    if (this.#closed || Buffer.byteLength(JSON.stringify(message)) > 1024 * 1024)
      throw new Error("release IPC is closed or exceeds its bounds");
    this.#send(message);
  }

  #receive = (raw: unknown): void => {
    let message;
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > 1024 * 1024) throw new Error("oversize IPC");
      message = validate(Message, raw);
    } catch {
      this.close();
      return;
    }
    if (message.kind !== "pal.release.call") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.kind === "pal.release.error")
        pending.reject(new HttpError(message.status, "release_refused", message.message));
      else pending.resolve(message.value);
      return;
    }
    if (this.#receiving.size >= 8 || this.#receiving.has(message.id)) {
      this.close();
      return;
    }
    this.#receiving.add(message.id);
    void Promise.resolve()
      .then(() => this.#handle(message.op, message.args))
      .then(
        (value) => this.#post({ kind: "pal.release.result", id: message.id, value }),
        (error: unknown) =>
          this.#post({
            kind: "pal.release.error",
            id: message.id,
            status: error instanceof HttpError ? error.status : 409,
            message: (error instanceof Error ? error.message : "Release refused.").slice(0, 1000),
          }),
      )
      .finally(() => this.#receiving.delete(message.id))
      .catch(() => this.close());
  };
}
