import { lookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { McpFetch } from "@earendil-works/pi-mcp";
import { Agent, fetch } from "undici";

/** Addresses a public MCP server must never make Pal reach: loopback, private, link-local (cloud metadata), and more. */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** Aggregate decoded HTTP body, including chunked/compressed JSON, SSE notifications and error bodies. */
export const MAX_MCP_RESPONSE_BYTES = 2 * 1024 * 1024;

const FAKE_IP = new BlockList();
FAKE_IP.addSubnet("198.18.0.0", 15, "ipv4");

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 0) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return !NON_PUBLIC.check(mapped, "ipv4");
  return !NON_PUBLIC.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/** A request the network policy refuses before any byte is sent. */
export class NetworkPolicyError extends Error {}

type Routing = { readonly allowPrivate: boolean; readonly allowFakeIp?: boolean };

/** Check every resolved address at connection time, including mixed public/private DNS answers. */
export function policyLookup(options: Routing, resolve: typeof lookup = lookup): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    resolve(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error !== null) return callback(error, "", 0);
      const resolved = addresses as LookupAddress[];
      const refused = options.allowPrivate
        ? undefined
        : resolved.find(
            ({ address }) =>
              !isPublicAddress(address) &&
              !(options.allowFakeIp && FAKE_IP.check(address, isIP(address) === 6 ? "ipv6" : "ipv4")),
          );
      if (refused !== undefined) {
        return callback(new NetworkPolicyError(`${hostname} resolves to non-public ${refused.address}`), "", 0);
      }
      if (lookupOptions.all === true) return callback(null, resolved);
      const first = resolved[0];
      if (first === undefined) return callback(new Error(`${hostname} has no address`), "", 0);
      callback(null, first.address, first.family);
    });
  };
}

/** One exact endpoint; the fake-IP exception changes DNS routing, never HTTPS hostname verification. */
export function policyFetch(options: Routing & { readonly endpoint: string }): McpFetch & { close(): Promise<void> } {
  const endpoint = new URL(options.endpoint);
  const agent = new Agent({ connections: 2, maxOrigins: 1, connect: { lookup: policyLookup(options) } });
  const scoped: McpFetch = async (input, init) => {
    const url = new URL(input);
    if (url.href !== endpoint.href) throw new NetworkPolicyError("request does not match this MCP endpoint");
    if (url.protocol !== "https:" && !(options.allowPrivate && url.protocol === "http:")) {
      throw new NetworkPolicyError(`${url.origin} must use HTTPS`);
    }
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (!options.allowPrivate && isIP(host) !== 0 && !isPublicAddress(host)) {
      throw new NetworkPolicyError(`${url.origin} is not a public address`);
    }
    // SAFETY: undici and Node use the same WHATWG streams/Response; their TypeScript declarations differ.
    const response = (await fetch(url, {
      ...(init as object),
      redirect: "error",
      dispatcher: agent,
    })) as unknown as Response;
    if (response.body === null) return response;
    if (Number(response.headers.get("content-length")) > MAX_MCP_RESPONSE_BYTES) {
      await response.body.cancel();
      throw new Error("MCP response exceeds 2 MiB");
    }
    let bytes = 0;
    const limited = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP response exceeds 2 MiB");
          controller.enqueue(chunk);
        },
      }),
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(limited, { status: response.status, statusText: response.statusText, headers });
  };
  return Object.assign(scoped, { close: () => agent.destroy() });
}
