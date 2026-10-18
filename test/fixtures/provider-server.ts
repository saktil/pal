// Loopback stand-in for the API-key providers' chat routes (OpenAI chat completions and Responses, Anthropic
// Messages) and their free key checks.
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type ProviderRequest = { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };

const COMPLETIONS = [
  "/api/v1/chat/completions",
  "/inference/v1/chat/completions",
  "/inference/go/v1/chat/completions",
  "/compat/v1/chat/completions",
];
export const GOOD_KEY = "sk-fixture-good";

const sse = (events: object[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const named = (events: object[]) =>
  events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

function completions(response: ServerResponse, reply: string) {
  const chunk = (delta: object, finish: string | null, usage?: object) => ({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage === undefined ? {} : { usage }),
  });
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    sse([
      chunk({ role: "assistant", content: reply }, null),
      chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
    ]) + "data: [DONE]\n\n",
  );
}

function responses(response: ServerResponse, reply: string) {
  const done = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: reply, annotations: [] }],
  };
  const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5 };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    named([
      { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...done, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: reply },
      { type: "response.output_item.done", output_index: 0, item: done },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [done], usage } },
    ]),
  );
}

function messages(response: ServerResponse, reply: string) {
  const usage = { input_tokens: 3, output_tokens: 2 };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    named([
      {
        type: "message_start",
        message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "fixture", usage },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]),
  );
}

export async function startProviderFixture() {
  const behavior = { reply: "Hello from the provider fixture", reject: false, hold: false };
  const requests: ProviderRequest[] = [];
  const holding = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    requests.push({ path, headers: request.headers, body: text === "" ? {} : JSON.parse(text) });
    const key = request.headers["x-api-key"] ?? request.headers.authorization?.replace(/^Bearer /, "");
    if (path === "/api/v1/key" || path === "/v1/models" || path === "/compat/v1/models") {
      const ok = key === GOOD_KEY || (path === "/compat/v1/models" && key === undefined);
      response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(ok ? { data: path === "/api/v1/key" ? { usage: 1.5, limit: 10 } : [] } : {}));
      return;
    }
    if (behavior.reject) {
      // A misbehaving service that echoes the credential must not get it into Pal's transcript or logs.
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `invalid key ${request.headers.authorization ?? ""}` } }));
      return;
    }
    if (COMPLETIONS.includes(path) && behavior.hold) {
      holding.add(response);
      response.once("close", () => holding.delete(response));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "held-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Held fixture request" }, finish_reason: null }] })}\n\n`,
      );
      return;
    }
    if (COMPLETIONS.includes(path)) completions(response, behavior.reply);
    else if (path === "/v1/responses") responses(response, behavior.reply);
    else if (path === "/v1/messages") messages(response, behavior.reply);
    else response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    behavior,
    requests,
    get holding() {
      return holding.size;
    },
    close: () => {
      for (const response of holding) response.destroy();
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
