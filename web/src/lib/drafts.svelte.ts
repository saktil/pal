import { untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import type { Admission, Upload } from "./api.ts";

export const MAX_DRAFT_CHARS = 100_000;
export const MAX_DRAFT_FILES = 10;
export const MAX_DRAFT_CHATS = 32;
type BusyMode = "followUp" | "steer";
export type DraftSnapshot = Readonly<{
  revision: number;
  text: string;
  attachments: readonly string[];
  whenBusy: BusyMode;
}>;
export type PendingInput = Readonly<{
  chatId: string;
  requestId: string;
  revision: number;
  body: Readonly<{
    text: string;
    attachments: readonly string[];
    whenBusy: BusyMode;
    configuration: string;
  }>;
}>;

export class ChatDraft {
  readonly chatId: string;
  readonly blocked: boolean;
  readonly #controller = new AbortController();
  #active = $state(true);
  #text = $state("");
  #attachments = $state.raw<readonly Readonly<Upload>[]>([]);
  #revision = 0;
  whenBusy = $state<BusyMode>("followUp");
  sending = $state(false);
  uploading = $state(0);
  pending = $state.raw<PendingInput | undefined>();
  error = $state<string | undefined>();
  notice = $state<string | undefined>();

  constructor(chatId: string, problem?: string) {
    this.chatId = chatId;
    this.blocked = problem !== undefined;
    this.error = problem;
  }

  get active() {
    return this.#active;
  }
  get signal() {
    return this.#controller.signal;
  }
  get text() {
    return this.#text;
  }
  set text(value: string) {
    if (!this.active || this.blocked) return;
    if (value.length > MAX_DRAFT_CHARS) {
      this.error = `A draft can contain at most ${MAX_DRAFT_CHARS.toLocaleString()} characters; nothing was added.`;
      return;
    }
    this.#text = value;
    this.#revision++;
    if (this.pending === undefined) this.error = undefined;
  }
  get attachments() {
    return this.#attachments;
  }
  set attachments(value: readonly Readonly<Upload>[]) {
    if (!this.active || this.blocked) return;
    if (value.length > MAX_DRAFT_FILES) {
      this.error = `A draft can attach at most ${MAX_DRAFT_FILES} files; nothing was added.`;
      return;
    }
    this.#attachments = Object.freeze(value.map((file) => Object.freeze({ ...file })));
    this.#revision++;
  }
  get empty() {
    return (
      this.text === "" &&
      this.attachments.length === 0 &&
      this.pending === undefined &&
      !this.sending &&
      this.uploading === 0
    );
  }
  append(text: string): boolean {
    if (!this.active || this.blocked) return false;
    const value = `${this.text}${this.text ? "\n\n" : ""}${text}`;
    if (value.length > MAX_DRAFT_CHARS) {
      this.error = `This would exceed ${MAX_DRAFT_CHARS.toLocaleString()} characters; nothing was added.`;
      return false;
    }
    this.text = value;
    return true;
  }
  touch() {
    this.#revision++;
  }
  snapshot(running: boolean): DraftSnapshot {
    if (!this.active || this.blocked || this.text.trim() === "") throw new Error("This draft cannot be sent.");
    return Object.freeze({
      revision: this.#revision,
      text: this.text.trim(),
      attachments: Object.freeze(this.attachments.map((file) => file.id)),
      whenBusy: running ? this.whenBusy : "followUp",
    });
  }
  stage(requestId: string, snapshot: DraftSnapshot, configuration: string): PendingInput {
    if (!this.active || this.blocked || this.pending !== undefined) throw new Error("Resolve the saved send first.");
    const envelope = Object.freeze({
      chatId: this.chatId,
      requestId,
      revision: snapshot.revision,
      body: Object.freeze({
        text: snapshot.text,
        attachments: Object.freeze([...snapshot.attachments]),
        whenBusy: snapshot.whenBusy,
        configuration,
      }),
    });
    this.pending = envelope;
    return envelope;
  }
  confirm(envelope: PendingInput, admission: Admission) {
    if (!this.active || this.pending !== envelope) return;
    if (admission.chatId !== envelope.chatId || admission.requestId !== envelope.requestId)
      throw new Error("Pal acknowledged a different input; the saved send is kept.");
    if (this.#revision === envelope.revision) {
      this.#text = "";
      this.#attachments = [];
      this.#revision++;
      this.notice = undefined;
    } else this.notice = "The earlier message was admitted. Your newer draft is kept.";
    this.pending = undefined;
    this.error = undefined;
  }
  reject(envelope: PendingInput) {
    if (this.pending === envelope) this.pending = undefined;
  }
  dispose() {
    this.#active = false;
    this.#controller.abort();
    this.#text = "";
    this.#attachments = [];
    this.pending = undefined;
    this.error = undefined;
    this.notice = undefined;
  }
}

export class ChatDrafts {
  readonly #drafts = new SvelteMap<string, ChatDraft>();
  open(chatId: string): ChatDraft {
    return untrack(() => {
      const known = this.#drafts.get(chatId);
      if (known !== undefined) return known;
      for (const [id, draft] of this.#drafts) {
        if (draft.empty) {
          draft.dispose();
          this.#drafts.delete(id);
        }
      }
      const problem =
        this.#drafts.size >= MAX_DRAFT_CHATS
          ? `This tab holds ${MAX_DRAFT_CHATS} drafts. Confirm a saved send, or clear another chat's unsent text and files, before drafting here.`
          : undefined;
      const draft = new ChatDraft(chatId, problem);
      if (!draft.blocked) this.#drafts.set(chatId, draft);
      return draft;
    });
  }
  clear() {
    for (const draft of this.#drafts.values()) draft.dispose();
    this.#drafts.clear();
  }
}

export const drafts = new ChatDrafts();
