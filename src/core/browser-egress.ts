import { chmod, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, request as httpRequest, type Server } from "node:http";
import { lookup as dnsLookup } from "node:dns";
import { connect, isIP, type LookupFunction, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isPublicAddress, policyLookup } from "../pi/network.ts";

const WEB_PORTS: ReadonlySet<number> = new Set([80, 443]);
const MAX_CONNECTIONS = 64;
const IDLE_MS = 120_000;

/**
 * The browser sandbox's only way out: an HTTP proxy on a Unix socket that resolves every destination itself and
 * connects only to public addresses on ports 80/443. Each redirect, subresource and WebSocket opens its own
 * connection here, so the check covers them all; page URLs are never trusted as a filter.
 */
export class EgressBroker {
  readonly #server: Server;
  readonly #path: string;
  readonly #sockets = new Set<Socket | Duplex>();

  private constructor(server: Server, path: string) {
    this.#server = server;
    this.#path = path;
  }

  /** The defaults are the production policy; tests admit a loopback fixture's address and port. */
  static async listen(
    path: string,
    options: { allowPrivate?: boolean; ports?: ReadonlySet<number> } = {},
  ): Promise<EgressBroker> {
    const allowPrivate = options.allowPrivate === true;
    const lookup: LookupFunction = allowPrivate ? dnsLookup : policyLookup({ allowPrivate: false });
    const ports = options.ports ?? WEB_PORTS;
    const destination = (authority: string) => {
      const target = parse(authority);
      if (target === undefined || !ports.has(target.port)) return undefined;
      // Node skips `lookup` for an address literal, so literals are checked here.
      if (!allowPrivate && isIP(target.host) !== 0 && !isPublicAddress(target.host)) return undefined;
      return target;
    };
    let active = 0;
    const server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 30_000 });
    server.maxConnections = MAX_CONNECTIONS;
    const broker = new EgressBroker(server, path);
    const track = (socket: Socket | Duplex) => {
      if (broker.#sockets.has(socket)) return;
      broker.#sockets.add(socket);
      socket.once("close", () => broker.#sockets.delete(socket));
    };
    server.on("connection", (socket) => {
      track(socket);
      socket.setTimeout(IDLE_MS, () => socket.destroy());
      socket.on("error", () => socket.destroy());
    });
    server.on("connect", (request: IncomingMessage, client: Duplex, head: Buffer) => {
      const target = destination(request.url ?? "");
      if (target === undefined || active >= MAX_CONNECTIONS) {
        client.end(`HTTP/1.1 ${target === undefined ? 403 : 503} Refused\r\nconnection: close\r\n\r\n`);
        return;
      }
      active += 1;
      const upstream = connect({ host: target.host, port: target.port, lookup });
      track(upstream);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.setTimeout(IDLE_MS, close);
      client.once("close", () => {
        active -= 1;
        upstream.destroy();
      });
      upstream.once("error", () => client.end("HTTP/1.1 502 Refused\r\nconnection: close\r\n\r\n"));
      client.once("error", close);
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    });
    // Plain HTTP arrives in absolute form; it is forwarded under the same destination checks.
    server.on("request", (incoming, outgoing) => {
      let url: URL;
      try {
        url = new URL(incoming.url ?? "");
      } catch {
        outgoing.writeHead(400).end();
        return;
      }
      const target = url.protocol === "http:" ? destination(`${url.hostname}:${url.port || "80"}`) : undefined;
      if (target === undefined) {
        outgoing.writeHead(403).end();
        return;
      }
      if (active >= MAX_CONNECTIONS) {
        outgoing.writeHead(503).end();
        return;
      }
      active += 1;
      const headers = Object.fromEntries(
        Object.entries(incoming.headers).filter(
          ([name]) => name !== "proxy-connection" && name !== "proxy-authorization",
        ),
      );
      headers.host = url.host;
      const forwarded = httpRequest(
        {
          host: target.host,
          port: target.port,
          method: incoming.method,
          agent: false,
          path: `${url.pathname}${url.search}`,
          headers,
          lookup,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.once("error", () => outgoing.destroy());
          response.pipe(outgoing);
        },
      );
      forwarded.on("socket", track);
      forwarded.setTimeout(IDLE_MS, () => forwarded.destroy());
      outgoing.once("close", () => {
        active -= 1;
        forwarded.destroy();
      });
      incoming.once("aborted", () => forwarded.destroy());
      forwarded.once("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(forwarded);
    });
    await rm(path, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    await chmod(path, 0o600);
    return broker;
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await rm(this.#path, { force: true });
  }
}

/** `host:port` of a CONNECT or forward target; brackets are removed from IPv6 literals. */
function parse(authority: string): { host: string; port: number } | undefined {
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(authority);
  if (match === null) return undefined;
  const host = (match[1] ?? "").replace(/^\[(.*)\]$/, "$1");
  return host === "" ? undefined : { host, port: Number(match[2]) };
}
