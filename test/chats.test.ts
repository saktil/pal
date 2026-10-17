import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionStopped,
  type Barrier,
  ChatNotFound,
  ChatService,
  MAX_INPUT_CHARS,
  ProjectUnavailable,
} from "../src/core/chats.ts";
import { InvalidRequest, RequestConflict } from "../src/core/requests.ts";
import { openStore } from "../src/storage/store.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pal-chats-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function open(dataRoot: string, barrier?: (point: Barrier) => void | Promise<void>) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage(fauxText("ok"))));
  const model = faux.getModel();
  const store = await openStore(dataRoot);
  const harness = await Harness.open(store.storage, { models, registry: createRegistry() }, context);
  cleanups.push(() => harness.close(context).catch(() => {}));
  const chats = await ChatService.open(
    {
      database: store.database,
      harness,
      agentFor: async (projectId: string) =>
        projectId === "project-1" ? { model: { provider: model.provider, modelId: model.id } } : undefined,
      ...(barrier === undefined ? {} : { barrier }),
    },
    context,
  );
  const userMessages = async (conversationId: Parameters<typeof harness.conversation>[0]) => {
    await harness.waitForIdle(context);
    const { messages } = (await (await harness.conversation(conversationId, context))?.context(context)) ?? {
      messages: [],
    };
    return messages.filter((message) => message.role === "user").length;
  };
  return { store, harness, chats, userMessages };
}

/** Make the next write that needs a new database page fail with SQLITE_FULL. */
async function fillDisk(database: Awaited<ReturnType<typeof openStore>>["database"]): Promise<void> {
  const pages = await database.get<{ page_count: number }>("PRAGMA page_count");
  await database.exec(`PRAGMA max_page_count = ${pages?.page_count}`);
}

describe("chats", () => {
  it("creates one chat per request ID and rejects that ID with another body", async () => {
    const { store, chats } = await open(await tempDir());
    const chat = await chats.createChat("chat-request-1", { projectId: "project-1", title: "A" }, context);
    expect(await chats.createChat("chat-request-1", { projectId: "project-1", title: "A" }, context)).toEqual(chat);
    await expect(
      chats.createChat("chat-request-1", { projectId: "project-1", title: "B" }, context),
    ).rejects.toBeInstanceOf(RequestConflict);
    expect((await chats.createChat("chat-request-2", { projectId: "project-1" }, context)).id).not.toBe(chat.id);

    await expect(chats.createChat("short", { projectId: "project-1" }, context)).rejects.toBeInstanceOf(InvalidRequest);
    await expect(chats.createChat("chat-request-3", { title: "" }, context)).rejects.toBeInstanceOf(InvalidRequest);
    await expect(
      chats.createChat("chat-request-3", { projectId: "project-1", other: 1 }, context),
    ).rejects.toBeInstanceOf(InvalidRequest);
    await expect(chats.createChat("chat-request-3", { projectId: "elsewhere" }, context)).rejects.toBeInstanceOf(
      ProjectUnavailable,
    );
    expect((await store.storage.scanConversations({}, 100, undefined, context)).items).toHaveLength(2);
  });

  it("admits an input once per request ID and body, whatever the key order or defaults", async () => {
    const { harness, chats, userMessages } = await open(await tempDir());
    const chat = await chats.createChat("chat-request-1", { projectId: "project-1" }, context);
    const admission = await chats.submit(chat.id, "input-request-1", { text: "hi" }, context);
    // Acknowledged only once Pi has admitted it.
    expect(await harness.submission(admission.submissionId, context)).toBeDefined();
    expect(await chats.submit(chat.id, "input-request-1", { whenBusy: "followUp", text: "hi" }, context)).toEqual(
      admission,
    );
    for (const body of [{ text: "hi", whenBusy: "steer" }, { text: "hi!" }]) {
      await expect(chats.submit(chat.id, "input-request-1", body, context)).rejects.toBeInstanceOf(RequestConflict);
    }
    expect(await userMessages(chat.conversationId)).toBe(1);
    // The first input names an untitled chat; listing shows it.
    expect(await chats.list("project-1")).toEqual([
      expect.objectContaining({ id: chat.id, title: "hi", conversationId: chat.conversationId }),
    ]);

    await expect(chats.submit("no-such-chat", "input-request-2", { text: "hi" }, context)).rejects.toBeInstanceOf(
      ChatNotFound,
    );
    const tooLong = { text: "x".repeat(MAX_INPUT_CHARS + 1) };
    await expect(chats.submit(chat.id, "input-request-2", tooLong, context)).rejects.toBeInstanceOf(InvalidRequest);
  });

  it("stops admission when Pal's write fails, before anything reaches Pi", async () => {
    const { store, chats, userMessages } = await open(await tempDir());
    const chat = await chats.createChat("chat-request-1", { projectId: "project-1" }, context);
    await fillDisk(store.database);
    const failed = chats.submit(chat.id, "input-request-1", { text: "x".repeat(50_000) }, context);
    await expect(failed).rejects.toBeInstanceOf(AdmissionStopped);
    // SQLite rolls back a transaction that hits SQLITE_FULL itself, so the facade reports its own rollback failing too.
    const cause = await failed.catch((error: AdmissionStopped) => error.cause);
    expect(cause instanceof AggregateError ? cause.errors[0] : cause).toHaveProperty("errcode", 13);
    expect(await userMessages(chat.conversationId)).toBe(0);

    // Space returning does not resume admission: the process must restart and reconcile first.
    await store.database.exec("PRAGMA max_page_count = 1073741823");
    expect(chats.stopped).toBe(true);
    await expect(chats.submit(chat.id, "input-request-2", { text: "hi" }, context)).rejects.toBeInstanceOf(
      AdmissionStopped,
    );
  });

  it("stops admission when Pi's commit fails, and completes the input after a restart", async () => {
    const dataRoot = await tempDir();
    let failPi = false;
    const first = await open(dataRoot, async (point) => {
      if (failPi && point === "input-recorded") await fillDisk(first.store.database);
    });
    const chat = await first.chats.createChat("chat-request-1", { projectId: "project-1" }, context);
    failPi = true;
    const body = { text: "x".repeat(50_000) };
    await expect(first.chats.submit(chat.id, "input-request-1", body, context)).rejects.toBeInstanceOf(
      AdmissionStopped,
    );
    expect(await first.harness.closed).toMatchObject({ reason: "failed" });

    const second = await open(dataRoot);
    expect(await second.userMessages(chat.conversationId)).toBe(1);
    expect(await second.store.database.all("SELECT state FROM pal_admissions")).toEqual([{ state: "admitted" }]);
    const admission = await second.chats.submit(chat.id, "input-request-1", body, context);
    expect(await second.harness.submission(admission.submissionId, context)).toBeDefined();
    expect(await second.userMessages(chat.conversationId)).toBe(1);
  });
});
