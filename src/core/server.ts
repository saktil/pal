import { once } from "node:events";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import sirv from "sirv";

export type ServerOptions = {
  version: string;
  /** Built frontend directory; absent in development, where Vite serves the UI. */
  webRoot?: string | undefined;
};

const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

export function createRequestListener({ version, webRoot }: ServerOptions): RequestListener {
  const assets = webRoot === undefined ? undefined : sirv(webRoot, { single: true });

  return (request, response) => {
    for (const [name, value] of Object.entries(BASE_HEADERS)) response.setHeader(name, value);
    // A throw here would crash the process, so malformed request targets get a 400 instead.
    const url = URL.parse(request.url ?? "/", "http://pal.invalid");
    if (url === null) return sendJson(request, response, 400, { error: "bad_request" });
    const { pathname } = url;
    const readOnly = request.method === "GET" || request.method === "HEAD";

    if (pathname === "/api/health") {
      if (!readOnly) return methodNotAllowed(response);
      return sendJson(request, response, 200, { status: "ok", name: "pal", version });
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return sendJson(request, response, 404, { error: "not_found" });
    }
    if (!readOnly) return methodNotAllowed(response);
    if (assets === undefined) {
      return sendJson(request, response, 404, { error: "web_not_built" });
    }
    assets(request, response, () => sendJson(request, response, 404, { error: "not_found" }));
  };
}

/** Listen on one port; resolves once bound so callers can read the actual address. */
export async function startServer(options: ServerOptions & { host: string; port: number }): Promise<Server> {
  const server = createServer(createRequestListener(options));
  server.listen(options.port, options.host);
  await once(server, "listening");
  return server;
}

function sendJson(request: IncomingMessage, response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(request.method === "HEAD" ? undefined : payload);
}

function methodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
  response.end("Method Not Allowed\n");
}
