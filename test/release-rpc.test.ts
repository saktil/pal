import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/core/http.ts";
import { ReleaseRpc, type ReleaseOperation } from "../src/core/release-rpc.ts";

const links: ReleaseRpc[] = [];
afterEach(() => {
  for (const link of links.splice(0)) link.close();
});
function pair(handle: (op: ReleaseOperation, args: unknown) => Promise<unknown>) {
  const a = new EventEmitter(),
    b = new EventEmitter();
  const client = new ReleaseRpc(
    a,
    (message) => queueMicrotask(() => b.emit("message", message)),
    async () => ({ prepared: true }),
  );
  const server = new ReleaseRpc(b, (message) => queueMicrotask(() => a.emit("message", message)), handle);
  links.push(client, server);
  return { client, server, a, b };
}

describe("private release IPC", () => {
  it("correlates concurrent directions and preserves bounded refusal status, without stacks", async () => {
    const { client, server } = pair(async (op, args) => {
      if (op === "activate") throw new HttpError(409, "busy", "Finish the current task first.");
      return { op, args };
    });
    expect(await client.call("view", { scope: "owner" })).toEqual({ op: "view", args: { scope: "owner" } });
    expect(await server.call("prepare")).toEqual({ prepared: true });
    await expect(client.call("activate")).rejects.toMatchObject({
      status: 409,
      message: "Finish the current task first.",
    });
  });

  it("bounds outstanding calls and recovers slots after results", async () => {
    const gate = Promise.withResolvers<unknown>();
    const { client } = pair(async () => gate.promise);
    const pending = Promise.allSettled(Array.from({ length: 8 }, () => client.call("view")));
    await expect(client.call("view")).rejects.toMatchObject({ status: 429 });
    gate.resolve({ done: true });
    expect((await pending).every((result) => result.status === "fulfilled")).toBe(true);
    expect(await client.call("view")).toEqual({ done: true });
  });

  it("clears pending operations on disconnect and never silently reconnects", async () => {
    const gate = Promise.withResolvers<unknown>();
    const { client, a } = pair(async () => gate.promise);
    const pending = expect(client.call("approve")).rejects.toMatchObject({ status: 503 });
    a.emit("disconnect");
    await pending;
    await expect(client.call("activate")).rejects.toMatchObject({ status: 503 });
    gate.resolve({ ignored: true });
  });

  it("times out observation without inventing a successful decision", async () => {
    const gate = Promise.withResolvers<unknown>();
    const { client } = pair(async () => gate.promise);
    await expect(client.call("approve", {}, 10)).rejects.toMatchObject({ status: 504 });
    gate.resolve({ late: true });
  });

  it.each([
    { kind: "pal.release.call", id: "0".repeat(36), op: "edit-policy", args: {} },
    { kind: "pal.release.call", id: "0".repeat(36), op: "view", args: {}, trust: true },
    { kind: "pal.release.result", id: "0".repeat(36), value: "x".repeat(1024 * 1024) },
  ])("fails closed on malformed or oversized private messages", async (raw) => {
    const handle = vi.fn(async () => ({ unexpected: true }));
    const { server, b } = pair(handle);
    b.emit("message", raw);
    await expect(server.call("view")).rejects.toMatchObject({ status: 503 });
    expect(handle).not.toHaveBeenCalled();
  });
});
