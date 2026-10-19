# Development

## Setup

Node.js 24.21+, pnpm 11 (`corepack enable`) and Git. Nix is optional but gives the exact toolchain and the full
test suite.

```sh
pnpm install
pnpm check     # typecheck, lint, format check
pnpm test      # unit and integration tests
pnpm start     # build, then serve on http://127.0.0.1:7337
```

With Nix, `nix develop --no-pure-eval` opens a devenv shell with Node, pnpm, Git, coreutils and the native
libraries. direnv users can rely on `.envrc`.

## Scripts

| Script             | What it does                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `pnpm start`       | Builds, then runs `dist/main.js`. Extra arguments go to the server.                           |
| `pnpm serve`       | Runs an existing build.                                                                       |
| `pnpm dev`         | Watches the server on `127.0.0.1:7338` and runs Vite's UI server, which forwards `/api` to it. |
| `pnpm build`       | Vite builds `web/` into `dist/public`; esbuild bundles `src/main.ts` into `dist/`.            |
| `pnpm check`       | `tsc`, `svelte-check --fail-on-warnings`, ESLint and Prettier.                                |
| `pnpm test`        | Vitest unit and integration tests (`test/*.test.ts`).                                         |
| `pnpm test:e2e`    | Playwright tests of the built UI (`test/e2e`). Needs `pnpm build`, and Chromium through `PLAYWRIGHT_BROWSERS_PATH`. |
| `pnpm test:feasibility` | Checks that the pinned Playwright drives the matching Chromium with a persistent profile. |

`pnpm dev` uses your default data directory. Its UI proxy forwards plain HTTP only, so the Terminal and Browser
panels, which use WebSockets, need the built app (`pnpm start`).

## Tests

Tests use real temporary SQLite databases, Git repositories and folders, with loopback fixture services standing
in for OpenAI's sign-in and model APIs, the other model providers and MCP servers (`test/fixtures`). They never use
real accounts or keys. Crash recovery is tested by killing child Pal processes with SIGKILL at fixed points and
reopening their data.

A few tests assume Linux (`/proc`, PTY behavior) or Nix-store programs (local MCP programs, the browser runtime).
The complete, reproducible run is the flake's checks on Linux:

```sh
nix build .#checks.x86_64-linux.package   # the installable package
nix build .#checks.x86_64-linux.smoke     # starts the packaged server and probes native features
nix build .#checks.x86_64-linux.tests     # pnpm check + pnpm test + build
nix build .#checks.x86_64-linux.browser   # Playwright/Chromium feasibility
nix build .#checks.x86_64-linux.e2e       # UI and browser-runtime tests; keeps screenshots in the output
```

The e2e output contains screenshots at 1440, 768 and 390 px widths for review. Any change to `package.json` or
`pnpm-lock.yaml` may change the pnpm dependency hash in `nix/package.nix`; the build reports the new value.

## Project layout

```
src/
  main.ts          command line: serve, probe, supervise, check-release
  core/            HTTP API, owner auth and the application services
  pi/              model providers, Code Mode policy, MCP clients and browser tools
  storage/         SQLite store, migrations, encrypted credentials
web/src/
  components/      Svelte 5 views and panels
  lib/             API client, chat event stream, shared state, icons
test/              Vitest suites and fixture services; e2e/ for Playwright
nix/               package, checks and test derivations
```

See [architecture](architecture.md) for how the pieces connect.

## Adding capabilities

Prefer extensions and reusable packages over adding more responsibilities to core. The aim is for people to build
and share their own tools, integrations and customizations, not just use the bundled features. See
[extension architecture](architecture.md#extensions-and-releases) for the current scope and trust boundaries.

- **Custom tools today:** implement an MCP server and connect it through [Settings → MCP servers](configuration.md#internet-tools-mcp).
- **Built-in contributions today:** use `src/core/extensions.ts` and the existing native-tool and UI boundaries.
  Interface-only extras do not need a model tool or new permissions.
- **Shared guarantees:** keep owner consent, Code Mode-only model calls, durable receipts, version pins and resource
  limits intact. New defaults must not change active chats or runs.

## Conventions

- TypeScript in strict mode, ES modules and Node 24 APIs. Svelte 5 runes in the UI.
- Prettier formatting and ESLint, both enforced by `pnpm check`.
- **Migrations are append-only.** Add a new entry to `src/storage/migrations.ts`; never edit an applied one.
- **Durable operations.** Anything with an external effect is an unsafe-replay tool or records its intent first,
  so a crash never repeats it blindly. Tests cover the crash points.
- **Commits.** One-line Conventional Commits of at most 72 characters, such as `feat(web): add light theme`.
