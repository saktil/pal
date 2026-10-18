// Loopback stand-in for OpenRouter's and OpenCode's OpenAI-style chat routes and OpenRouter's key check.
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export type ProviderRequest = { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };

const ROUTES = ["/api/v1/chat/completions", "/inference/v1/chat/completions", "/inference/go/v1/chat/completions"];

export async function startProviderFixture() {
  const behavior = { reply: "Hello from the provider fixture", reject: false };
  const requests: ProviderRequest[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    requests.push({ path, headers: request.headers, body: text === "" ? {} : JSON.parse(text) });
    if (path === "/api/v1/key") {
      const ok = request.headers.authorization === "Bearer sk-or-fixture-good";
      response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(ok ? { data: { usage: 1.5, limit: 10 } } : { error: { message: "No auth" } }));
      return;
    }
    if (!ROUTES.includes(path)) {
      response.writeHead(404).end();
      return;
    }
    if (behavior.reject) {
      // A misbehaving service that echoes the credential must not get it into Pal's transcript or logs.
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `invalid key ${request.headers.authorization ?? ""}` } }));
      return;
    }
    const chunk = (delta: object, finish: string | null, usage?: object) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage === undefined ? {} : { usage }),
      })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      chunk({ role: "assistant", content: behavior.reply }, null) +
        chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }) +
        "data: [DONE]\n\n",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    behavior,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
