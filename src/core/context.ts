import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
import type { Pal } from "./app.ts";
import type { ChatSummary } from "./chats.ts";
import { HttpError } from "./http.ts";
import { entryText } from "./memory.ts";
import { validate } from "./requests.ts";

const Lookup = Type.Object(
  {
    query: Type.String({ maxLength: 200 }),
    candidates: Type.Array(
      Type.Object({ id: Type.String({ maxLength: 64 }), revision: Type.Integer({ minimum: 1 }) }),
      { maxItems: 10 },
    ),
    truncated: Type.Boolean(),
    at: Type.Number(),
  },
  { additionalProperties: false },
);

export async function inspectContext(pal: Pal, chat: ChatSummary, context: Context) {
  const conversation = await pal.harness.conversation(chat.conversationId, context);
  if (conversation === undefined) throw new HttpError(404, "not_found", "the conversation is missing");
  const [agent, history, head] = await Promise.all([
    conversation.agent(context),
    conversation.entries({}, 20, undefined, context),
    pal.store.storage.findLatestHeadMarker(chat.conversationId, undefined, context),
  ]);
  const sources = history.items.flatMap((entry) => {
    const text = entryText(entry);
    return text === "" ? [] : [{ entry: entry.id as number, kind: entry.kind, text }];
  });
  const lookups = history.items.flatMap((entry) =>
    entry.kind === "pal.memory" ? [{ entry: entry.id as number, ...validate(Lookup, entry.data) }] : [],
  );
  const live = await pal.store.database.get(
    "SELECT c.id FROM pal_chats c JOIN pal_projects p ON p.id = c.project_id WHERE c.id = ? AND c.deleted_at IS NULL AND p.removed_at IS NULL AND p.state = 'ready'",
    chat.id,
  );
  if (live === undefined) throw new HttpError(404, "not_found", "the chat or project was removed");
  return {
    instructions: agent.instructions ?? "",
    model: agent.model ?? null,
    head: (head?.id as number | undefined) ?? null,
    sources,
    lookups,
    moreHistory: history.next !== undefined,
  };
}
export type ContextInfo = Awaited<ReturnType<typeof inspectContext>>;
