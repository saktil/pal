import { isIP } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7337;

export type ServeConfig = { host: string; port: number; dataRoot: string };

export type Command =
  { kind: "help" } | { kind: "version" } | { kind: "probe" } | { kind: "serve"; config: ServeConfig };

/** Process facts that decide defaults, passed in so tests do not depend on the machine. */
export type HostFacts = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  /** Directory the running application was loaded from; data must live elsewhere. */
  installRoot: string;
};

export class UsageError extends Error {}

export const USAGE = `Usage: pal [serve] [--host <address>] [--port <number>] [--data-dir <path>]
       pal probe

Commands:
  serve              Run the Pal server (default)
  probe              Check SQLite FTS5, fff and Code Mode support on this host, then exit

Options:
  --host <address>   Loopback address to listen on (default ${DEFAULT_HOST})
  --port <number>    TCP port (default ${DEFAULT_PORT}; 0 picks a free port)
  --data-dir <path>  Absolute path for Pal's writable data
                     (default: $XDG_DATA_HOME/pal or ~/.local/share/pal on Linux,
                     ~/Library/Application Support/pal on macOS)
  -h, --help         Show this help
  -v, --version      Show the version`;

export function parseCommand(argv: readonly string[], host: HostFacts): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        host: { type: "string" },
        port: { type: "string" },
        "data-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };

  const [name = "serve", extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument '${extra}'`);
  if (name === "probe") {
    const options = ["host", "port", "data-dir"] as const;
    const given = options.find((option) => values[option] !== undefined);
    if (given !== undefined) throw new UsageError(`'probe' does not accept --${given}`);
    return { kind: "probe" };
  }
  if (name !== "serve") throw new UsageError(`unknown command '${name}'`);

  return {
    kind: "serve",
    config: {
      host: parseHost(values.host ?? DEFAULT_HOST),
      port: parsePort(values.port ?? String(DEFAULT_PORT)),
      dataRoot: resolveDataRoot(values["data-dir"], host),
    },
  };
}

function parseHost(value: string): string {
  const loopback = value === "localhost" || value === "::1" || (isIP(value) === 4 && value.startsWith("127."));
  // Remote binding needs owner authentication and Origin/CSRF checks, which do not exist yet.
  if (!loopback) throw new UsageError(`--host must be a loopback address until owner sign-in exists; got '${value}'`);
  return value;
}

function parsePort(value: string): number {
  const port = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  if (!(port >= 0 && port <= 65_535)) throw new UsageError(`--port must be an integer from 0 to 65535; got '${value}'`);
  return port;
}

function resolveDataRoot(explicit: string | undefined, host: HostFacts): string {
  const candidate = explicit ?? defaultDataRoot(host);
  if (!isAbsolute(candidate)) throw new UsageError(`--data-dir must be an absolute path; got '${candidate}'`);
  const dataRoot = resolve(candidate);
  if (isWithin(dataRoot, "/nix/store")) throw new UsageError("--data-dir must not be inside /nix/store");
  if (isWithin(dataRoot, host.installRoot) || isWithin(host.installRoot, dataRoot)) {
    throw new UsageError(`--data-dir must be outside the application directory ${host.installRoot}`);
  }
  return dataRoot;
}

function defaultDataRoot({ env, platform, home }: HostFacts): string {
  if (!isAbsolute(home)) throw new UsageError("cannot find the home directory; pass --data-dir");
  if (platform === "darwin") return join(home, "Library", "Application Support", "pal");
  if (platform === "linux") {
    // The XDG spec says relative values are invalid and must be ignored.
    const xdg = env.XDG_DATA_HOME;
    return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "pal");
  }
  throw new UsageError(`no default data directory on ${platform}; pass --data-dir`);
}

function isWithin(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
