import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpFixture } from "./fixtures/mcp-server.ts";
import { createApi } from "../src/core/api.ts";
import { openPal } from "../src/core/app.ts";
import { startServer } from "../src/core/server.ts";
import { browse, startOpenAIFixture } from "./fixtures/openai-server.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(publicOrigin?: string) {
  const fixture = await startOpenAIFixture();
  cleanups.push(fixture.close);
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-api-test-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install", endpoints: fixture.endpoints }, context);
  cleanups.push(() => pal.close());
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    version: "test",
    publicOrigin,
    api: createApi(pal, publicOrigin),
  });
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let session = "";
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}/api/${path}`, {
      method,
      headers: {
        origin: base,
        cookie: session,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie !== null) session = cookie.split(";")[0] ?? "";
    // Responses are checked by the assertions; typing every shape here would only repeat them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { fixture, dataRoot, pal, base, api, cookie: () => session };
}

/** A raw request, for headers fetch will not let a test forge. */
function raw(
  base: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}${path}`,
      { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers } },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, cookies: response.headers["set-cookie"] ?? [] });
      },
    );
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not reached");
}

async function signedIn(publicOrigin?: string) {
  const app = await start(publicOrigin);
  await app.api("POST", "setup", { token: app.pal.owner.setupToken, passphrase: "correct horse battery" });
  return app;
}

async function putBytes(base: string, cookie: string, id: string, bytes: Uint8Array) {
  const response = await fetch(`${base}/api/uploads/${id}`, {
    method: "PUT",
    headers: { origin: base, cookie, "content-type": "application/octet-stream" },
    body: new Uint8Array(bytes),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("API", () => {
  it("persists per-project MCP narrowing and rejects stale or widening permission changes", async () => {
    const { api } = await signedIn();
    const a = (await api("POST", "projects", { requestId: "grant-project-a", name: "A" })).body.project;
    const b = (await api("POST", "projects", { requestId: "grant-project-b", name: "B" })).body.project;
    const first = await api("GET", `projects/${a.id}/mcp`);
    expect(first.status).toBe(200);
    const exa = first.body.servers.find((server: { id: string }) => server.id === "exa");
    expect(exa.mode).toBe("inherit");
    expect(
      (await api("PUT", `projects/${a.id}/mcp/exa`, { revision: exa.revision, mode: "subset", tools: [] })).status,
    ).toBe(200);
    expect(
      (await api("PUT", `projects/${a.id}/mcp/exa`, { revision: exa.revision, mode: "inherit", tools: [] })).status,
    ).toBe(409);
    expect(
      (await api("GET", `projects/${a.id}/mcp`)).body.servers.find((server: { id: string }) => server.id === "exa")
        .mode,
    ).toBe("subset");
    const other = (await api("GET", `projects/${b.id}/mcp`)).body.servers.find(
      (server: { id: string }) => server.id === "exa",
    );
    expect(other.mode).toBe("inherit");
    expect(
      (await api("PUT", `projects/${b.id}/mcp/exa`, { revision: other.revision, mode: "subset", tools: ["agent_run"] }))
        .status,
    ).toBe(400);
    await api("DELETE", `projects/${a.id}`);
    expect((await api("GET", `projects/${a.id}/mcp`)).status).toBe(404);
    await api("POST", "sign-out");
    expect((await api("GET", `projects/${b.id}/mcp`)).status).toBe(401);
  });
  it("answers only its own host and accepts writes only from its own origin", async () => {
    const { base, api } = await start();
    const port = new URL(base).port;
    expect((await raw(base, "/api/health", { host: `attacker.example:${port}` })).status).toBe(421);
    expect((await raw(base, "/api/health", { host: `localhost:${port}` })).status).toBe(200);
    const response = await fetch(`${base}/api/sign-in`, {
      method: "POST",
      headers: { origin: "http://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "x" }),
    });
    expect(response.status).toBe(403);
    expect((await api("GET", "projects")).status).toBe(401);
  });

  it("keeps MCP discovery and execution scoped to actual durable conversations", async () => {
    const { pal, api, fixture: openai } = await signedIn();
    const started = await api("POST", "chatgpt/sign-in");
    await browse(started.body.attempt.authUrl);
    await eventually(
      () => api("GET", "chatgpt"),
      (state) => state.body.model !== null,
    );
    const fixture = await startMcpFixture();
    cleanups.push(fixture.close);
    const server = await pal.mcp.add({ name: "Scoped", url: fixture.url, auth: { kind: "none" }, private: true });
    await pal.mcp.test(server.id);
    await pal.mcp.approve(server.id, ["search", "fetch"]);
    await pal.mcp.setEnabled(server.id, true);
    const a = (await api("POST", "projects", { requestId: "scoped-project-a", name: "A" })).body.project;
    const b = (await api("POST", "projects", { requestId: "scoped-project-b", name: "B" })).body.project;
    const grant = (await pal.mcp.grants.view(a.id)).servers.find((candidate) => candidate.id === server.id);
    if (grant === undefined) throw new Error("missing grant");
    await pal.mcp.grants.set(a.id, server.id, { revision: grant.revision, mode: "subset", tools: ["search"] });
    async function conversation(projectId: string, key: string) {
      const chat = await pal.chats.createChat(key, { projectId }, context);
      const handle = await pal.harness.conversation(chat.conversationId, context);
      if (handle === undefined) throw new Error("missing conversation");
      return handle;
    }
    async function run(handle: Awaited<ReturnType<typeof conversation>>, code: string) {
      openai.behavior.responses = "script";
      openai.behavior.script = code;
      await (await handle.submit({ type: "input", content: "go" }, context)).wait(context);
      const result = (await handle.context(context)).messages.findLast((message) => message.role === "toolResult");
      return result?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
    }
    const one = await conversation(a.id, "scoped-chat-one"),
      two = await conversation(b.id, "scoped-chat-two");
    const catalog = await run(one, "return ALL_TOOLS.map(tool => tool.name);");
    expect(catalog).toContain(`mcp__${server.id}__search`);
    expect(catalog).not.toContain(`mcp__${server.id}__fetch`);
    expect(
      await run(
        one,
        `try { await tools.mcp__${server.id}__fetch({ url: "https://fixture.invalid/durable" }); return "leaked"; } catch { return "blocked"; }`,
      ),
    ).toContain("blocked");
    expect(fixture.calls).toEqual([]);
    expect(
      await run(two, `return await tools.mcp__${server.id}__fetch({ url: "https://fixture.invalid/durable" });`),
    ).toContain("Durable agents");
    expect(fixture.calls.map((call) => call.name)).toEqual(["fetch"]);
  });

  it.each(["https://pal.example", "http://100.64.0.10:7337"])(
    "accepts only the exact configured public Host/Origin %s, retaining loopback access",
    async (origin) => {
      const { base, api } = await signedIn(origin);
      const host = new URL(origin).host;
      expect((await raw(base, "/api/health", { host })).status).toBe(200);
      expect((await raw(base, "/api/health", { host: `${host}.evil`, "x-forwarded-host": host })).status).toBe(421);
      const body = { passphrase: "correct horse battery" };
      for (const wrong of [
        "null",
        `${origin}/`,
        "https://attacker.example",
        origin.replace(/^https?:/, origin.startsWith("https:") ? "http:" : "https:"),
      ]) {
        expect(
          (await raw(base, "/api/sign-in", { host, origin: wrong, "x-forwarded-proto": "https" }, body)).status,
        ).toBe(403);
      }
      expect((await raw(base, "/api/sign-in", { host, origin: base }, body)).status).toBe(403);
      expect((await raw(base, "/api/sign-in", { host: new URL(base).host, origin }, body)).status).toBe(403);
      const accepted = await raw(base, "/api/sign-in", { host, origin }, body);
      expect(accepted.status).toBe(200);
      expect(accepted.cookies[0]?.includes("; Secure")).toBe(origin.startsWith("https:"));
      expect((await api("GET", "projects")).status).toBe(200);
    },
  );

  it("sets up the owner once with the terminal's token, then signs in with the passphrase", async () => {
    const { pal, api, cookie } = await start();
    expect((await api("GET", "session")).body).toEqual({ owner: false, signedIn: false });
    expect((await api("POST", "setup", { token: "guess", passphrase: "correct horse battery" })).status).toBe(403);
    expect((await api("POST", "setup", { token: pal.owner.setupToken, passphrase: "short" })).body.error).toBe(
      "weak_passphrase",
    );
    expect(
      (await api("POST", "setup", { token: pal.owner.setupToken, passphrase: "correct horse battery" })).status,
    ).toBe(200);
    expect(cookie()).toMatch(/^pal_session=/);
    expect((await api("GET", "session")).body).toEqual({ owner: true, signedIn: true });
    expect((await api("POST", "setup", { token: pal.owner.setupToken, passphrase: "another passphrase" })).status).toBe(
      409,
    );

    await api("POST", "sign-out");
    expect((await api("GET", "projects")).status).toBe(401);
    expect((await api("POST", "sign-in", { passphrase: "wrong passphrase!" })).status).toBe(401);
    expect((await api("POST", "sign-in", { passphrase: "correct horse battery" })).status).toBe(200);
    expect((await api("GET", "projects")).status).toBe(200);
  });

  it("creates managed and existing-folder projects, refusing unusable folders", async () => {
    const { dataRoot, api } = await signedIn();
    const managed = await api("POST", "projects", { requestId: "project-request-1", name: "Notes" });
    expect(managed.body.project).toMatchObject({ name: "Notes", mode: "managed", state: "ready" });
    expect(managed.body.project.root).toBe(join(dataRoot, "projects", managed.body.project.id, "workspace"));
    expect((await stat(managed.body.project.root)).isDirectory()).toBe(true);
    expect((await api("POST", "projects", { requestId: "project-request-1", name: "Notes" })).body).toEqual(
      managed.body,
    );
    expect((await api("POST", "projects", { requestId: "project-request-1", name: "Other" })).status).toBe(409);

    const folder = await realpath(await mkdtemp(join(tmpdir(), "pal-api-folder-")));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    await mkdir(join(folder, "repo", ".git"), { recursive: true });
    const existing = await api("POST", "projects", { requestId: "project-request-2", name: "Repo", folder });
    expect(existing.body.project).toMatchObject({ mode: "existing", state: "ready", root: folder });

    for (const [path, error] of [
      [join(folder, "missing"), "folder_missing"],
      [join(dataRoot, "projects"), "folder_forbidden"],
      ["relative/path", "invalid_request"],
    ]) {
      expect(
        (await api("POST", "projects", { requestId: `bad-${error}-1`, name: "Bad", folder: path })).body.error,
      ).toBe(error);
    }
    const listing = await api("GET", `folders?path=${encodeURIComponent(folder)}`);
    expect(listing.body.entries).toEqual([{ name: "repo", path: join(folder, "repo"), git: true }]);
    expect((await api("GET", `folders?path=${encodeURIComponent(join(folder, "nope"))}`)).body.problem).toBe("missing");
  });

  it("signs in to ChatGPT, then chats in a project with a live event stream", async () => {
    const { base, api, cookie } = await signedIn();
    const started = await api("POST", "chatgpt/sign-in");
    expect(started.body.attempt.state).toBe("waiting");
    await browse(started.body.attempt.authUrl);
    const connected = await eventually(
      () => api("GET", "chatgpt"),
      (state) => state.body.attempt.state === "connected" && state.body.models.length > 0,
    );
    expect(connected.body).toMatchObject({ account: { accountId: "user-1" }, model: "gpt-5.5" });
    // No token ever reaches the browser.
    expect(JSON.stringify(connected.body)).not.toMatch(/access-|refresh-|eyJ/);

    const project = (await api("POST", "projects", { requestId: "project-request-1", name: "Notes" })).body.project;
    const chat = (await api("POST", "chats", { requestId: "chat-request-1", projectId: project.id })).body.chat;
    expect((await api("GET", `chats/${chat.id}`)).body.model).toBe("gpt-5.5");

    const events = await fetch(`${base}/api/chats/${chat.id}/events`, { headers: { cookie: cookie() } });
    expect(events.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = events.body?.getReader();
    if (reader === undefined) throw new Error("no event stream");
    let text = "";
    const first = await reader.read();
    text += new TextDecoder().decode(first.value);
    expect(text).toMatch(/^event: snapshot/);

    const admitted = await api("POST", `chats/${chat.id}/inputs`, { requestId: "input-request-1", text: "hi" });
    expect(admitted.status).toBe(200);
    while (!text.includes('"type":"run_end"')) {
      const { value, done } = await reader.read();
      if (done) throw new Error("event stream ended early");
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain('"text":"Hello"');
    await reader.cancel();

    const projects = (await api("GET", "projects")).body.projects;
    expect(projects[0].chats).toEqual([expect.objectContaining({ id: chat.id, title: "hi" })]);
  });

  it("persists per-chat reasoning effort, clamps model switches, and rejects invalid choices", async () => {
    const { api, pal, dataRoot, fixture } = await signedIn();
    const project = (await api("POST", "projects", { requestId: "effort-project", name: "Notes" })).body.project;
    const chat = (await api("POST", "chats", { requestId: "effort-chat", projectId: project.id })).body.chat;
    expect((await api("PUT", `chats/${chat.id}/model`, { model: "gpt-5.5", effort: "high" })).body).toMatchObject({
      model: "gpt-5.5",
      effort: "high",
    });
    expect((await api("GET", `chats/${chat.id}`)).body.effort).toBe("high");
    expect((await api("PUT", `chats/${chat.id}/model`, { model: "gpt-4.1" })).body.effort).toBe("off");
    expect((await api("PUT", `chats/${chat.id}/model`, { model: "gpt-4.1", effort: "high" })).body.effort).toBe("off");
    for (const body of [
      { model: "missing", effort: "high" },
      { model: "gpt-5.5", effort: "unbounded" },
    ]) {
      expect((await api("PUT", `chats/${chat.id}/model`, body)).status).toBe(400);
    }
    await api("PUT", `chats/${chat.id}/model`, { model: "gpt-5.5", effort: "medium" });
    await pal.close();
    const reopened = await openPal(
      { dataRoot, installRoot: "/nonexistent-install", endpoints: fixture.endpoints },
      context,
    );
    cleanups.push(() => reopened.close());
    const agent = await (await reopened.harness.conversation(chat.conversationId, context))?.agent(context);
    expect(agent).toMatchObject({ model: { modelId: "gpt-5.5" }, thinkingLevel: "medium" });
  });

  it("deletes chats and removes projects without deleting files or Pi history", async () => {
    const { api, pal, fixture, dataRoot } = await signedIn();
    const started = await api("POST", "chatgpt/sign-in");
    await browse(started.body.attempt.authUrl);
    await eventually(
      () => api("GET", "chatgpt"),
      (state) => state.body.model !== null,
    );
    const folder = await realpath(await mkdtemp(join(tmpdir(), "pal-keep-files-")));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    await writeFile(join(folder, "keep.txt"), "owner work");
    const external = (await api("POST", "projects", { requestId: "remove-external", name: "External", folder })).body
      .project;
    const managed = (await api("POST", "projects", { requestId: "remove-managed", name: "Managed" })).body.project;
    await writeFile(join(managed.root, "keep.txt"), "managed work");
    const chat = (await api("POST", "chats", { requestId: "remove-chat-1", projectId: external.id })).body.chat;
    const other = (await api("POST", "chats", { requestId: "remove-chat-2", projectId: external.id })).body.chat;
    fixture.behavior.responses = "script";
    fixture.behavior.script = "while (true) {}";
    await api("POST", `chats/${chat.id}/inputs`, { requestId: "remove-input-1", text: "start" });
    await eventually(
      async () => fixture.apiRequests,
      (calls) => calls.some((call) => call.path === "/v1/responses"),
    );
    expect((await api("DELETE", `chats/${chat.id}`)).status).toBe(200);
    await pal.harness.waitForIdle(context);
    expect((await api("GET", `chats/${chat.id}`)).status).toBe(404);
    expect((await api("POST", `chats/${chat.id}/inputs`, { requestId: "remove-input-2", text: "again" })).status).toBe(
      404,
    );
    expect(await pal.chats.projectOf(chat.conversationId)).toBeUndefined();
    expect((await pal.chats.list(external.id)).map((row) => row.id)).toEqual([other.id]);
    const history = await (await pal.harness.conversation(chat.conversationId, context))?.context(context);
    expect(history?.messages.some((message) => message.role === "user")).toBe(true);
    expect((await api("DELETE", `projects/${external.id}`)).status).toBe(200);
    expect((await api("GET", `chats/${other.id}`)).status).toBe(404);
    expect((await api("POST", "chats", { requestId: "removed-project-chat", projectId: external.id })).status).toBe(
      409,
    );
    expect((await api("POST", "projects", { requestId: "remove-external", name: "External", folder })).status).toBe(
      409,
    );
    expect((await api("DELETE", `projects/${managed.id}`)).status).toBe(200);
    expect((await api("GET", "projects")).body.projects).toEqual([]);
    expect(await readFile(join(folder, "keep.txt"), "utf8")).toBe("owner work");
    expect(await readFile(join(managed.root, "keep.txt"), "utf8")).toBe("managed work");
    await pal.close();
    const reopened = await openPal(
      { dataRoot, installRoot: "/nonexistent-install", endpoints: fixture.endpoints },
      context,
    );
    cleanups.push(() => reopened.close());
    expect(await reopened.projects.list()).toEqual([]);
    expect(await reopened.chats.get(chat.id)).toBeUndefined();
    expect(await reopened.chats.get(other.id)).toBeUndefined();
    expect(await reopened.harness.conversation(chat.conversationId, context)).toBeDefined();
  });

  it("receives device uploads exactly, then attaches them to a message", async () => {
    const { base, api, cookie, fixture, pal } = await signedIn();
    const started = await api("POST", "chatgpt/sign-in");
    await browse(started.body.attempt.authUrl);
    await eventually(
      () => api("GET", "chatgpt"),
      (state) => state.body.model !== null,
    );
    const project = (await api("POST", "projects", { requestId: "project-request-1", name: "Notes" })).body.project;
    const other = (await api("POST", "projects", { requestId: "project-request-2", name: "Other" })).body.project;
    const text = new TextEncoder().encode("The launch is on Tuesday.");

    const tooBig = await api("POST", `projects/${project.id}/uploads`, { name: "x", size: 26 * 1024 * 1024, type: "" });
    expect(tooBig.body.error).toBe("invalid_request");
    const short = (await api("POST", `projects/${project.id}/uploads`, { name: "a.txt", size: 3, type: "text/plain" }))
      .body.upload;
    expect((await putBytes(base, cookie(), short.id, text)).body.error).toBe("upload_size_mismatch");

    const admitted = (
      await api("POST", `projects/${project.id}/uploads`, { name: "plan.txt", size: text.length, type: "text/plain" })
    ).body.upload;
    const received = await putBytes(base, cookie(), admitted.id, text);
    expect(received.body.upload).toMatchObject({
      state: "ready",
      size: text.length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect((await putBytes(base, cookie(), admitted.id, text)).body.error).toBe("upload_not_receiving");

    const chat = (await api("POST", "chats", { requestId: "chat-request-1", projectId: project.id })).body.chat;
    const foreign = (await api("POST", "chats", { requestId: "chat-request-2", projectId: other.id })).body.chat;
    expect(
      (
        await api("POST", `chats/${foreign.id}/inputs`, {
          requestId: "input-foreign",
          text: "x",
          attachments: [admitted.id],
        })
      ).body.error,
    ).toBe("upload_not_found");
    const sent = await api("POST", `chats/${chat.id}/inputs`, {
      requestId: "input-request-1",
      text: "When is the launch?",
      attachments: [admitted.id],
    });
    expect(sent.status).toBe(200);
    const request = await eventually(
      async () => fixture.apiRequests.filter((call) => call.path === "/v1/responses").at(-1),
      (call) => call !== undefined,
    );
    expect(JSON.stringify(request?.body.input)).toContain("The launch is on Tuesday.");
    expect(JSON.stringify(request?.body.input)).toContain('name=\\"plan.txt\\"');

    // An upload left unfinished is dropped when Pal next opens.
    const pending = (
      await api("POST", `projects/${project.id}/uploads`, { name: "b.txt", size: 5, type: "text/plain" })
    ).body.upload;
    await pal.close();
    const reopened = await openPal(
      {
        dataRoot: pal.store.path.replace(/\/pal\.sqlite$/, ""),
        installRoot: "/nonexistent-install",
        endpoints: fixture.endpoints,
      },
      context,
    );
    cleanups.push(() => reopened.close());
    expect(await reopened.uploads.get(pending.id)).toBeUndefined();
    expect(await reopened.uploads.get(admitted.id)).toMatchObject({ state: "ready" });
  });
});
