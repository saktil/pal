import { lookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
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

export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return !NON_PUBLIC.check(mapped, "ipv4");
  return !NON_PUBLIC.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/** A request the network policy refuses before any byte is sent. */
export class NetworkPolicyError extends Error {}

/**
 * Fetch for one MCP endpoint. HTTPS unless the owner approved it as a private endpoint; a public endpoint may only reach
 * public addresses, checked on every address DNS returns when connecting (so a rebinding name cannot slip through);
 * redirects are refused, so credentials never follow one to another origin.
 */
export function policyFetch(options: { readonly allowPrivate: boolean }): McpFetch {
  const agent = new Agent({
    connect: {
      lookup: (hostname, lookupOptions, callback) => {
        lookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
          if (error !== null) return callback(error, "", 0);
          const resolved = addresses as LookupAddress[];
          const refused = options.allowPrivate ? undefined : resolved.find(({ address }) => !isPublicAddress(address));
          if (refused !== undefined) {
            return callback(new NetworkPolicyError(`${hostname} resolves to non-public ${refused.address}`), "", 0);
          }
          if ((lookupOptions as { all?: boolean }).all === true)
            return (callback as (e: null, a: LookupAddress[]) => void)(null, resolved);
          const first = resolved[0];
          if (first === undefined) return callback(new Error(`${hostname} has no address`), "", 0);
          callback(null, first.address, first.family);
        });
      },
    },
  });
  return async (input, init) => {
    const url = new URL(input);
    if (url.protocol !== "https:" && !(options.allowPrivate && url.protocol === "http:")) {
      throw new NetworkPolicyError(`${url.origin} must use HTTPS`);
    }
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (!options.allowPrivate && isIP(host) !== 0 && !isPublicAddress(host)) {
      throw new NetworkPolicyError(`${url.origin} is not a public address`);
    }
    // undici's fetch and the global one share the WHATWG shapes; their TypeScript declarations differ.
    return (await fetch(url, { ...(init as object), redirect: "error", dispatcher: agent })) as unknown as Response;
  };
}
