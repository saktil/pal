import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, request } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EgressBroker } from "../src/core/browser-egress.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function site(observe?: (request: IncomingMessage) => void) {
  const server = createServer((incoming, response) => {
    observe?.(incoming);
    if (incoming.url === "/hang") response.write("still open");
    else response.end(`site ${incoming.url}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return (server.address() as AddressInfo).port;
}

async function broker(options?: Parameters<typeof EgressBroker.listen>[1]) {
  const dir = await mkdtemp(join(tmpdir(), "pal-egress-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "egress.sock");
  const opened = await EgressBroker.listen(path, options);
  cleanups.push(() => opened.close());
  return path;
}

/** Send a raw CONNECT and return the status line, plus the tunnel's echo of one HTTP request when it opened. */
async function tunnel(path: string, authority: string): Promise<{ status: string; body?: string }> {
  const socket = connect(path);
  cleanups.push(() => socket.destroy());
  let text = "";
  socket.on("data", (chunk) => (text += String(chunk)));
  const ended = once(socket, "close");
  await once(socket, "connect");
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n\r\n`);
  while (!text.includes("\r\n\r\n") && !socket.destroyed) await once(socket, "data").catch(() => undefined);
  const [head = "", ...rest] = text.split("\r\n\r\n");
  const status = head.split("\r\n")[0] ?? "";
  if (!status.includes(" 200 ")) return { status };
  text = rest.join("\r\n\r\n");
  socket.write(`GET /through HTTP/1.1\r\nhost: ${authority}\r\nconnection: close\r\n\r\n`);
  await ended;
  return { status, body: text };
}

describe("browser egress broker", () => {
  it("owns each upstream instead of retaining shared keep-alive sockets", async () => {
    const connections = new Set<number | undefined>();
    const port = await site((incoming) => connections.add(incoming.socket.remotePort));
    const path = await broker({ allowPrivate: true, ports: new Set([port]) });
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve, reject) => {
        const sent = request({ socketPath: path, path: `http://127.0.0.1:${port}/plain` }, (response) => {
          response.resume();
          response.once("end", resolve);
          response.once("error", reject);
        });
        sent.once("error", reject);
        sent.end();
      });
    }
    expect(connections.size).toBe(20);
  });

  it("closes active plain HTTP connections without waiting for a site to finish", async () => {
    const port = await site();
    const dir = await mkdtemp(join(tmpdir(), "pal-egress-close-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "egress.sock");
    const opened = await EgressBroker.listen(path, { allowPrivate: true, ports: new Set([port]) });
    cleanups.push(() => opened.close());
    const sent = request({ socketPath: path, path: `http://127.0.0.1:${port}/hang` });
    sent.on("error", () => {});
    cleanups.push(() => sent.destroy());
    const received = once(sent, "response");
    sent.end();
    const [response] = await received;
    response.on("error", () => {});
    response.resume();
    await once(response, "data");
    const closing = opened.close();
    const stopped = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!stopped) sent.destroy();
    await closing;
    expect(stopped).toBe(true);
  });

  it("refuses loopback, private and metadata destinations by default, and non-web ports", async () => {
    const port = await site();
    const path = await broker({ ports: new Set([port, 80, 443]) });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // Literals are refused before connecting; names are refused when they resolve to a non-public address.
    expect((await tunnel(path, `127.0.0.1:${port}`)).status).toMatch(/ 403 /);
    expect((await tunnel(path, "169.254.169.254:80")).status).toMatch(/ 403 /);
    expect((await tunnel(path, "[::1]:443")).status).toMatch(/ 403 /);
    expect((await tunnel(path, `localhost:${port}`)).status).toMatch(/ 502 /);
    expect((await tunnel(await broker(), "example.com:22")).status).toMatch(/ 403 /);
    // Node's parser rejects a malformed request line before the broker sees it.
    expect((await tunnel(await broker(), "not an authority")).status).toMatch(/ 400 /);
    expect((await tunnel(await broker(), "user@example.com:443")).status).toMatch(/ 403 /);
  });

  it("tunnels and forwards to an admitted destination", async () => {
    const port = await site();
    const path = await broker({ allowPrivate: true, ports: new Set([port]) });
    expect(await tunnel(path, `127.0.0.1:${port}`)).toMatchObject({ status: expect.stringMatching(/ 200 /) });
    expect((await tunnel(path, `127.0.0.1:${port}`)).body).toContain("site /through");
    const forwarded = await new Promise<string>((resolve, reject) => {
      const sent = request(
        { socketPath: path, path: `http://127.0.0.1:${port}/plain?x=1`, headers: { "proxy-authorization": "nope" } },
        async (response) => {
          let body = "";
          for await (const chunk of response) body += String(chunk);
          resolve(body);
        },
      );
      sent.once("error", reject);
      sent.end();
    });
    expect(forwarded).toBe("site /plain?x=1");
    expect((await tunnel(path, `127.0.0.1:${port + 1 === 65536 ? 1 : port + 1}`)).status).toMatch(/ 403 /);
  });
});
