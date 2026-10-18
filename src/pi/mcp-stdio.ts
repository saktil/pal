import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { StdioTransport, type JsonRpcMessage, type StdioTransportOptions } from "@earendil-works/pi-mcp";
import { Type, type Static } from "typebox";
import { validate } from "../core/requests.ts";
import { directoryIdentity } from "../core/workspace-root.ts";

const NIX_EXECUTABLE = /^\/nix\/store\/[0-9a-df-np-sv-z]{32}-[^/]+\/.+/;

export const StdioAuth = Type.Union([
  Type.Object({ kind: Type.Literal("none") }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("env"), variable: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" }) },
    { additionalProperties: false },
  ),
]);
export type StdioAuth = Static<typeof StdioAuth>;
const Program = Type.Object(
  {
    command: Type.String({ minLength: 1, maxLength: 4096 }),
    args: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 32 }),
    cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { additionalProperties: false },
);
export const StdioServerBody = Type.Object(
  {
    ...Program.properties,
    transport: Type.Literal("stdio"),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    auth: StdioAuth,
  },
  { additionalProperties: false },
);
export type StdioServerInput = Static<typeof StdioServerBody>;
const Record = Type.Object(
  {
    ...Program.properties,
    identity: Type.String(),
    approval: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type StdioProgram = Static<typeof Record>;
export class StdioConfigError extends Error {}

export function decodeStdio(raw: string): StdioProgram {
  try {
    return validate(Record, JSON.parse(raw));
  } catch {
    throw new StdioConfigError("the saved local program is corrupt; nothing was started");
  }
}

export function stdioDigest(program: StdioProgram, auth: StdioAuth): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "pal-stdio-1",
        program.command,
        program.args,
        program.cwd,
        program.identity,
        auth,
        "private HOME/TMPDIR; PATH=executable directory; LANG=C.UTF-8; no inherited environment; 90s lifetime",
      ]),
    )
    .digest("hex");
}

export function checkStdioAuth(input: unknown): StdioAuth {
  const auth = validate(StdioAuth, input);
  if (
    auth.kind === "env" &&
    (/^(?:PAL_|LD_|DYLD_)/.test(auth.variable) ||
      !/^(?:[A-Z][A-Z0-9_]*_)?(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(auth.variable))
  )
    throw new StdioConfigError(
      "use a dedicated key variable ending in KEY, TOKEN, SECRET or PASSWORD (for example SERVICE_API_KEY), not host startup or configuration variables",
    );
  return auth;
}

/** Trusted owner-approved programs, not a sandbox. The Nix executable is pinned; arguments may name mutable data/code. */
export class StdioPrograms {
  readonly #forbidden: readonly string[];
  readonly #active = new Set<PrivateStdio>();
  #reserved = 0;
  #closed = false;

  constructor(forbidden: readonly string[]) {
    this.#forbidden = forbidden;
  }

  async prepare(input: { command: string; args: readonly string[]; cwd: string }): Promise<StdioProgram> {
    validate(Program, input);
    if (
      !isAbsolute(input.cwd) ||
      Buffer.byteLength(JSON.stringify(input.args)) > 16_384 ||
      [input.command, input.cwd, ...input.args].some((value) => value.includes("\0"))
    )
      throw new StdioConfigError("local arguments must be bounded and contain no NUL bytes");
    let command: string, cwd: string, identity: string;
    try {
      // Keep Nix symlink entrypoints: multicall binaries select behavior from argv[0].
      command = resolve(input.command);
      if (
        !isAbsolute(input.command) ||
        !NIX_EXECUTABLE.test(command) ||
        !NIX_EXECUTABLE.test(await realpath(command)) ||
        !(await stat(command)).isFile()
      )
        throw new Error("not a pinned executable");
      await access(command, constants.X_OK);
      cwd = await realpath(input.cwd);
      if (this.#forbidden.some((path) => overlaps(cwd, path))) throw new Error("private working folder");
      identity = await directoryIdentity(cwd);
    } catch {
      throw new StdioConfigError(
        "choose an executable already in the Nix store and an existing working folder outside Pal's private data/installation and the Nix store; nothing was installed or started",
      );
    }
    return { command, args: [...input.args], cwd, identity, approval: null };
  }

  async check(program: StdioProgram): Promise<void> {
    const current = await this.prepare(programFields(program));
    if (current.command !== program.command || current.cwd !== program.cwd || current.identity !== program.identity)
      throw new StdioConfigError(
        "the approved local working folder or executable was replaced; approve a new configuration",
      );
  }

  async transport(
    program: StdioProgram,
    auth: StdioAuth,
    key: string | undefined,
    signal: AbortSignal,
    authorize: () => Promise<void> = async () => {},
  ): Promise<StdioTransport> {
    checkStdioAuth(auth);
    if (program.approval !== stdioDigest(program, auth))
      throw new StdioConfigError("approve this exact local program before starting it");
    if (auth.kind === "env" && key === undefined)
      throw new StdioConfigError("configure this local program's API key before starting it");
    if (this.#closed || this.#active.size + this.#reserved >= 4)
      throw new StdioConfigError("local MCP process limit reached (four); retry after a call finishes");
    this.#reserved++;
    let home: string | undefined;
    try {
      await this.check(program);
      const timeout = await timeoutExecutable();
      signal.throwIfAborted();
      home = await mkdtemp(join(tmpdir(), "pal-mcp-"));
      if (this.#closed) throw new StdioConfigError("Pal is closing");
      const transport = new PrivateStdio(
        {
          command: timeout,
          args: ["--kill-after=1s", "90s", program.command, ...program.args],
          cwd: program.cwd,
          inheritEnv: false,
          env: {
            PATH: dirname(program.command),
            HOME: home,
            TMPDIR: home,
            LANG: "C.UTF-8",
            ...(auth.kind === "env" && key !== undefined ? { [auth.variable]: key } : {}),
          },
          stderr: "pipe",
          maxMessageBytes: 2 * 1024 * 1024,
          maxStderrBytes: 4096,
          closeTimeoutMs: 1000,
        },
        async () => {
          try {
            await rm(transport.home, { recursive: true, force: true });
          } finally {
            this.#active.delete(transport);
          }
        },
        home,
        async () => {
          await this.check(program);
          await authorize();
          signal.throwIfAborted();
        },
      );
      this.#active.add(transport);
      return transport;
    } catch (error) {
      if (home !== undefined) await rm(home, { recursive: true, force: true });
      throw error;
    } finally {
      this.#reserved--;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#active].map((transport) => transport.close()));
  }
}

class PrivateStdio extends StdioTransport {
  readonly home: string;
  readonly #release: () => Promise<void>;
  readonly #check: () => Promise<void>;
  #group: number | undefined;
  #closing: Promise<void> | undefined;
  #bytes = 0;
  #messages = 0;

  constructor(options: StdioTransportOptions, release: () => Promise<void>, home: string, check: () => Promise<void>) {
    super({ ...options, onStderr: (chunk) => this.#budget(Buffer.byteLength(chunk)) });
    this.home = home;
    this.#release = release;
    this.#check = check;
    this.onError(() => {
      this.#kill();
      void this.close();
    });
    this.onClose(() => {
      void this.close();
    });
  }
  override async start(): Promise<void> {
    await this.#check();
    await super.start();
    this.#group = this.pid;
  }
  override onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    return super.onMessage((message) => {
      if (++this.#messages > 512 || !this.#budget(Buffer.byteLength(JSON.stringify(message)))) {
        this.#kill();
        void this.close();
        return;
      }
      listener(message);
    });
  }
  #budget(bytes: number): boolean {
    this.#bytes += bytes;
    if (this.#bytes <= 8 * 1024 * 1024 && this.#closing === undefined) return true;
    this.#kill();
    void this.close();
    return false;
  }
  #kill(): void {
    if (this.#group !== undefined)
      try {
        process.kill(-this.#group, "SIGKILL");
      } catch {
        /* already gone */
      }
  }
  override close(): Promise<void> {
    return (this.#closing ??= Promise.resolve().then(async () => {
      try {
        await super.close();
      } finally {
        this.#kill();
        await this.#release();
      }
    }));
  }
}

async function timeoutExecutable(): Promise<string> {
  // cross-spawn resolves its command against the child's deliberately narrow PATH, not Pal's PATH.
  const configured = process.env.PAL_TIMEOUT;
  const candidates =
    configured === undefined
      ? (process.env.PATH ?? "")
          .split(delimiter)
          .filter(isAbsolute)
          .slice(0, 64)
          .map((path) => join(path, "timeout"))
      : [configured];
  for (const candidate of candidates) {
    const path = await realpath(candidate).catch(() => undefined);
    if (path === undefined || !NIX_EXECUTABLE.test(path)) continue;
    const entry = join(dirname(path), "timeout");
    if ((await realpath(entry).catch(() => undefined)) !== path) continue;
    if (
      await access(entry, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return entry;
  }
  throw new StdioConfigError("Pal's pinned GNU timeout is unavailable; no local program was started");
}

function programFields(program: StdioProgram) {
  return { command: program.command, args: program.args, cwd: program.cwd };
}
function overlaps(a: string, b: string): boolean {
  const inside = (root: string, path: string) => {
    const part = relative(root, path);
    return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
  };
  return inside(a, b) || inside(b, a);
}
