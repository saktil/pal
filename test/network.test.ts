import type { LookupAddress, LookupOptions, lookup } from "node:dns";
import { describe, expect, it } from "vitest";
import { isPublicAddress, NetworkPolicyError, policyFetch, policyLookup } from "../src/pi/network.ts";

function resolve(addresses: string[], allowFakeIp: boolean, all = true) {
  const records: LookupAddress[] = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  const dns = ((_host: string, _options: LookupOptions, done: (error: null, records: LookupAddress[]) => void) =>
    done(null, records)) as typeof lookup;
  return new Promise<string | LookupAddress[]>((resolve, reject) => {
    policyLookup({ allowPrivate: false, allowFakeIp }, dns)("mcp.exa.ai", { all }, (error, result) =>
      error === null ? resolve(result) : reject(error),
    );
  });
}

describe("MCP endpoint routing", () => {
  it("permits fake-IP DNS only after opt-in and still refuses private/rebinding answers", async () => {
    await expect(resolve(["198.18.0.1"], false)).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(resolve(["198.18.0.1", "198.19.255.254"], true)).resolves.toHaveLength(2);
    await expect(resolve(["198.18.0.1"], true, false)).resolves.toBe("198.18.0.1");
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fc00::1",
      "::ffff:7f00:1",
      "198.20.0.1.invalid",
    ]) {
      await expect(resolve(["198.18.0.1", address], true)).rejects.toBeInstanceOf(NetworkPolicyError);
    }
    await expect(resolve(["104.18.6.160"], false)).resolves.toHaveLength(1);
  });

  it("keeps the exception endpoint-bound, HTTPS-only, and unavailable to IP literals", async () => {
    for (const endpoint of ["http://mcp.example/mcp", "https://198.18.0.1/mcp"]) {
      const fetch = policyFetch({ endpoint, allowPrivate: false, allowFakeIp: true });
      try {
        await expect(fetch(endpoint)).rejects.toBeInstanceOf(NetworkPolicyError);
      } finally {
        await fetch.close();
      }
    }
    const fetch = policyFetch({ endpoint: "https://mcp.example/mcp", allowPrivate: false, allowFakeIp: true });
    try {
      for (const url of ["https://other.example/mcp", "https://mcp.example/other", "http://mcp.example/mcp"]) {
        await expect(fetch(url)).rejects.toThrow("does not match");
      }
    } finally {
      await fetch.close();
    }
  });

  it.each(["not-an-ip", "127.0.0.1", "::ffff:7f00:1", "198.18.0.1"])(
    "does not label %s a public address",
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );
});
