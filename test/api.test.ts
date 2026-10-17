import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../src/core/api.ts";
import { openPal } from "../src/core/app.ts";
import { startServer } from "../src/core/server.ts";
import { browse, startOpenAIFixture } from "./fixtures/openai-server.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start() {
  const fixture = await startOpenAIFixture();
  cleanups.push(fixture.close);
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "pal-api-test-")));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const pal = await openPal({ dataRoot, installRoot: "/nonexistent-install", endpoints: fixture.endpoints }, context);
  cleanups.push(() => pal.close());
  const server = await startServer({ host: "127.0.0.1", port: 0, version: "test", api: createApi(pal) });
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
function raw(base: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}${path}`, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
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

async function signedIn() {
  const app = await start();
  await app.api("POST", "setup", { token: app.pal.owner.setupToken, passphrase: "correct horse battery" });
  return app;
}

describe("API", () => {
  it("answers only its own host and accepts writes only from its own origin", async () => {
    const { base, api } = await start();
    const port = new URL(base).port;
    expect(await raw(base, "/api/health", { host: `attacker.example:${port}` })).toBe(421);
    expect(await raw(base, "/api/health", { host: `localhost:${port}` })).toBe(200);
    const response = await fetch(`${base}/api/sign-in`, {
      method: "POST",
      headers: { origin: "http://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "x" }),
    });
    expect(response.status).toBe(403);
    expect((await api("GET", "projects")).status).toBe(401);
  });

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
});
