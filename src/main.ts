import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };
import { parseCommand, USAGE, UsageError } from "./core/config.ts";
import { startServer } from "./core/server.ts";

// The build puts the frontend in dist/public next to this bundle; running from src has none.
const webRoot = fileURLToPath(new URL("public", import.meta.url));
const installRoot = fileURLToPath(new URL("..", import.meta.url));

async function main(argv: readonly string[]): Promise<number> {
  let command;
  try {
    command = parseCommand(argv, { env: process.env, platform: process.platform, home: homedir(), installRoot });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`pal: ${error.message}\nRun 'pal --help' for usage.\n`);
    return 2;
  }

  switch (command.kind) {
    case "help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case "version":
      process.stdout.write(`pal ${pkg.version}\n`);
      return 0;
    case "probe": {
      const { runProbes } = await import("./probe.ts");
      const results = await runProbes();
      for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
      return results.every((result) => result.ok) ? 0 : 1;
    }
    case "serve": {
      const { host, port, dataRoot } = command.config;
      await mkdir(dataRoot, { recursive: true, mode: 0o700 });
      const server = await startServer({
        host,
        port,
        version: pkg.version,
        webRoot: existsSync(join(webRoot, "index.html")) ? webRoot : undefined,
      });
      const address = server.address() as AddressInfo;
      const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
      process.stdout.write(`pal ${pkg.version} listening on http://${shown}:${address.port} (data: ${dataRoot})\n`);

      const stop = () => {
        server.close();
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 5_000).unref();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return await new Promise((done) => server.once("close", () => done(0)));
    }
  }
}

process.exitCode = await main(process.argv.slice(2));
