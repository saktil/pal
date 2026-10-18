import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import pkg from "../package.json" with { type: "json" };
import { createApi } from "./core/api.ts";
import { openPal } from "./core/app.ts";
import { parseCommand, USAGE, UsageError } from "./core/config.ts";
import { startServer } from "./core/server.ts";
import { DatabaseOwnedError } from "./storage/sqlite.ts";

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
      const { host, port, dataRoot, publicOrigin } = command.config;
      let pal;
      try {
        pal = await openPal({ dataRoot, installRoot }, BACKGROUND_CONTEXT);
      } catch (error) {
        if (!(error instanceof DatabaseOwnedError)) throw error;
        process.stderr.write(`pal: ${dataRoot} is in use by another Pal process\n`);
        return 1;
      }
      let server;
      try {
        server = await startServer({
          host,
          port,
          version: pkg.version,
          publicOrigin,
          webRoot: existsSync(join(webRoot, "index.html")) ? webRoot : undefined,
          api: createApi(pal, publicOrigin),
          upgrade: (request, socket, head) => pal.upgrade(request, socket, head, publicOrigin),
        });
      } catch (error) {
        await pal.close();
        throw error;
      }
      const address = server.address() as AddressInfo;
      const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
      const origin = publicOrigin ?? `http://${shown}:${address.port}`;
      process.stdout.write(`pal ${pkg.version} listening on ${origin} (data: ${dataRoot})\n`);
      if (!(await pal.owner.exists())) {
        // Only someone who can read this terminal can claim the installation.
        process.stdout.write(`Set up Pal by opening ${origin}/#setup=${pal.owner.setupToken}\n`);
      }

      const stop = () => {
        void pal.terminals.close();
        server.close();
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 5_000).unref();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await new Promise((done) => server.once("close", done));
      await pal.close();
      return 0;
    }
  }
}

process.exitCode = await main(process.argv.slice(2));
