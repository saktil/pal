// One chat's live state from its server-sent events: a snapshot, then Pi's agent event batches.
// Every snapshot, including the one after a reconnect, replaces the state; nothing is replayed from an offset.
import type { McpReceipt } from "../../../src/pi/mcp-source.ts";
export type { McpReceipt };

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "image" };

export type Message = {
  role: "user" | "assistant" | "toolResult";
  content: string | Block[];
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** A `codemode` result's record of the tool calls its script made. */
  details?: { calls?: NestedCall[] };
};

export type NestedCall = {
  id: number;
  name: string;
  args: string;
  status: string;
  durationMs?: number;
  error?: string;
};

export type Attachment = { id: string; name: string; size: number; mediaType: string };

/** `pal.user` entries are user inputs with attachments; their `data` holds the labels. */
export type ShellReceipt = {
  callId: string;
  command: string;
  cwd: string;
  status: string;
  output?: string;
  exitCode?: number;
  truncated?: boolean;
  timedOut?: boolean;
};
export type Entry = {
  id: number;
  kind: string;
  model?: Message[];
  data?: { attachments?: Attachment[]; shell?: ShellReceipt; mcp?: McpReceipt };
};

type Change =
  | { type: "text_start" | "thinking_start" | "toolcall_start" | "block"; contentIndex: number; block: Block }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_delta"; contentIndex: number }
  | { type: "message"; message: Message };

type Snapshot = {
  entries: Entry[];
  run?: unknown;
  generation?: { message?: Message; retry?: { at: number; error: string } };
  inbox: { id: number; mode: "steer" | "followUp" }[];
};

type AgentEvent =
  | { type: "run_start" | "run_end" }
  | { type: "entry_appended"; entry: Entry }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; changes: Change[] }
  | { type: "message_end"; entry: Entry }
  | { type: "inbox_update"; items: { id: number; mode: "steer" | "followUp" }[] }
  | { type: "auto_retry_start"; at: number; errorMessage: string }
  | { type: "auto_retry_end" }
  | { type: string };

export class ChatStream {
  entries: Entry[] = $state([]);
  /** The assistant message being generated, if any. */
  partial: Message | undefined = $state();
  running = $state(false);
  inbox: { id: number; mode: "steer" | "followUp" }[] = $state([]);
  retry: { at: number; error: string } | undefined = $state();
  connected = $state(false);
  loaded = $state(false);
  #source: EventSource | undefined;

  constructor(chatId: string) {
    const source = new EventSource(`/api/chats/${chatId}/events`);
    this.#source = source;
    source.addEventListener("snapshot", (event) => this.#reset(JSON.parse((event as MessageEvent).data)));
    source.addEventListener("event", (event) => this.#apply(JSON.parse((event as MessageEvent).data)));
    source.addEventListener("open", () => (this.connected = true));
    source.addEventListener("error", () => (this.connected = false));
  }

  close(): void {
    this.#source?.close();
  }

  #reset(snapshot: Snapshot): void {
    this.entries = snapshot.entries;
    this.running = snapshot.run !== undefined;
    this.partial = snapshot.generation?.message;
    this.retry = snapshot.generation?.retry;
    this.inbox = snapshot.inbox;
    this.loaded = true;
    this.connected = true;
  }

  #append(entry: Entry): void {
    if (!this.entries.some((known) => known.id === entry.id)) this.entries.push(entry);
  }

  #apply(event: AgentEvent): void {
    if (event.type === "run_start") this.running = true;
    else if (event.type === "run_end") {
      this.running = false;
      this.partial = undefined;
    } else if ("entry" in event && (event.type === "entry_appended" || event.type === "message_end")) {
      this.#append(event.entry);
      if (event.type === "message_end") this.partial = undefined;
    } else if (event.type === "message_start" && "message" in event) {
      if (event.message.role === "assistant") this.partial = event.message;
    } else if (event.type === "message_update" && "changes" in event) {
      for (const change of event.changes) this.#change(change);
    } else if (event.type === "inbox_update" && "items" in event) {
      this.inbox = event.items;
    } else if (event.type === "auto_retry_start" && "errorMessage" in event) {
      this.retry = { at: event.at, error: event.errorMessage };
    } else if (event.type === "auto_retry_end") {
      this.retry = undefined;
    }
  }

  #change(change: Change): void {
    if (change.type === "message") {
      this.partial = change.message;
      return;
    }
    const partial = this.partial;
    if (partial === undefined || typeof partial.content === "string") return;
    if (
      change.type === "text_start" ||
      change.type === "thinking_start" ||
      change.type === "toolcall_start" ||
      change.type === "block"
    ) {
      partial.content[change.contentIndex] = change.block;
    } else if (change.type === "text_delta" || change.type === "thinking_delta") {
      const block = partial.content[change.contentIndex];
      if (block?.type === "text") block.text += change.delta;
      else if (block?.type === "thinking") block.thinking += change.delta;
    }
  }
}

/** Text of a user or tool message, whatever its content shape. */
export function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}
