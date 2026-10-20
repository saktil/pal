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

### CI and coverage boundaries

`.github/workflows/checks.yml` checks pushes and pull requests targeting `development`, using the exact
pushed or PR-head commit, not an implicit merge commit. Dependencies come from the frozen lockfiles through
Nix. The native targets are Ubuntu 24.04 x86-64 and macOS 15 Apple Silicon; these are test targets, not a
full-feature support claim or established minimum OS versions. Intel macOS and ARM64 Linux support remain
undecided. Required branch-protection checks must be configured by the repository owner.

Both targets run static checks, a portable subset and the build:

```sh
nix build .#checks.x86_64-linux.portable
nix build .#checks.aarch64-darwin.portable
# With the pinned development tools already available:
pnpm exec vitest run --config vitest.portable.config.ts
```

The subset explicitly excludes `mcp-local`, `mcp-stdio`, `release-policy` and `release-state`: those suites
need immutable Nix programs or Linux release-lock/source-confinement primitives. It fails on zero tests,
skips or todos, and exports only test counts in `summary.json`. The full `tests` check is unchanged and
still runs these suites on Linux. A separate Ubuntu 22.04 job runs all five packaged checks above: its
user-namespace support lets Chromium keep its sandbox, unlike the restricted Ubuntu 24.04 hosted image.
No host policy is disabled. Nix may reuse an identical derivation; a successful build request is not
necessarily a fresh runtime execution. Both full and portable checks repeat the PTY suite with readline-enabled
Bash, testing bracketed paste on/off without assuming a newline immediately precedes command output.

The macOS job also runs the independent saved-settings UI fixture (loading, failure/retry, navigation and
cross-provider configuration conflicts). Its artifact is built by Nix, then run on the native host: Chromium's
macOS sandbox cannot nest inside Nix's build sandbox. Chromium's own sandbox stays enabled; production browser
confinement is not replaced by this fixture. The same runner can be exercised on a capable Linux host:

```sh
nix build .#ui-check
./result/bin/pal-ui-check "$(mktemp -d)"
```

It uses a private temporary copy, local fake providers and isolated Pal data. The results directory contains counts
and fixture screenshots; zero tests, skips and todos fail the gate. This is rendered settings coverage, not a full
macOS browser-runtime, onboarding or release-security gate.

This is an initial CI foundation for [#15](https://github.com/valdo766hi/pal/issues/15), not full platform
acceptance. Build logs distinguish prerequisite errors from assertions; a failure before a suite runs
leaves that coverage unexecuted, not passed. CI retains commit/tree/OS identity, bounded counts and macOS UI-fixture
screenshots; it does not upload credentials, full transcripts or live runtime data. Independent onboarding fixtures,
sanitized rendered failure artifacts and host-scope security/release gates remain
required work. The Nix e2e suite's user-systemd-scope skip is also unexecuted coverage.

### Platform acceptance matrix

[#30](https://github.com/valdo766hi/pal/issues/30) requires equivalent native behavior, not just a portable
job. No row below establishes parity without exact-artifact native evidence. Shared policy stays in core;
platform-specific isolation, locks and lifecycle belong behind narrow adapters.

| Surface | Linux implementation / test entry point | macOS gap or required native evidence |
| --- | --- | --- |
| Owner, providers, chat and responsive UI | `owner`, `providers`, `api`; `test/e2e/app.test.ts` | Native `ui-check` covers saved-settings regressions only; same full onboarding, revocation and immutable-submission flows still required |
| Projects, uploads, worktrees and review | `projects`, `uploads`, `workspaces`, `changes`; corresponding tests | Case/Unicode aliases, symlinks, permissions, long paths and revision rules |
| Durable runs, Code Mode, memory and search | Pi/SQLite/QuickJS/fff; recovery, context, search and probe tests | Native locks/WAL/fullfsync, watcher changes/gaps and crash recovery |
| Shell and human terminal | `execution`, `terminals`; process/PTY tests | Native descendant/deadline cleanup, Unicode, resize and reconnect |
| Remote and local MCP | `mcp`, `mcp-stdio`; consent, stdio and local recovery tests | Immutable programs, native liveness and parent-death cleanup; no `/proc` substitutes that falsely report death |
| Browser and private-login handoff | Bubblewrap, systemd scope and broker-only egress; `test/e2e/browser.test.ts` | Missing equivalent filesystem/network/resource isolation and protected native tests; proxy-only or disabled sandbox is not parity |
| Compiled capabilities | `extensions`; selection/pin tests | Same lifecycle, compatibility and replay checks as new package contracts arrive |
| Checked releases and supervision | Linux flock and `/proc` source confinement; release tests/host fixtures | Missing inherited-lock/confinement adapters and protected exact-artifact runtime evaluation |
| Installation and data operations | Nix package/probes; smoke and schema tests | Clean install, diagnostics, launchd, sleep/wake and stopped-state backup/restore rehearsal |
| Planned workflows | Roadmap #20/#22/#23/#28 | Both platforms need the same grants, budgets, durability and recovery tests |

Browser and release activation currently fail closed without their Linux protections. Keep those gates until
replacements pass adversarial tests; do not count unavailable capabilities or skipped tests as completed
macOS support. Service installation or host security changes require a separately approved host plan.

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
