<script lang="ts">
  import { onMount } from "svelte";
  import type { Terminal } from "@xterm/xterm";
  import { api, type Project, type TerminalInfo, type Workspace } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import { shownTheme, viewport } from "../lib/state.svelte.ts";

  const FONT = "Geist Mono Variable";
  /** ANSI colors on Pal's graphite background: each normal color stays legible as text, bright ones step up. */
  const THEME = {
    background: "#08080a",
    foreground: "#e4e4e7",
    cursor: "#e4e4e7",
    cursorAccent: "#08080a",
    selectionBackground: "#3a3a41",
    selectionInactiveBackground: "#26262a",
    black: "#26262a",
    red: "#ff7b8a",
    green: "#7fd6a3",
    yellow: "#f1c46b",
    blue: "#6f94ff",
    magenta: "#d38cff",
    cyan: "#5fd7ef",
    white: "#c9cfdc",
    brightBlack: "#71717a",
    brightRed: "#ff9aa6",
    brightGreen: "#9de6b8",
    brightYellow: "#ffd88a",
    brightBlue: "#93b0ff",
    brightMagenta: "#e6a8ff",
    brightCyan: "#8be6f7",
    brightWhite: "#f4f6fb",
  };
  /** The daylight counterpart: dark inks on paper, each at least 4.5:1 against it. */
  const LIGHT_THEME = {
    background: "#ffffff",
    foreground: "#18181b",
    cursor: "#18181b",
    cursorAccent: "#ffffff",
    selectionBackground: "#dcdce0",
    selectionInactiveBackground: "#ececee",
    black: "#18181b",
    red: "#c22d3f",
    green: "#17773f",
    yellow: "#8a5b00",
    blue: "#2a4fd6",
    magenta: "#9535c4",
    cyan: "#08758f",
    white: "#6b7286",
    brightBlack: "#5b6377",
    brightRed: "#cf3346",
    brightGreen: "#18803f",
    brightYellow: "#9a6700",
    brightBlue: "#3b5ff0",
    brightMagenta: "#9b3fd0",
    brightCyan: "#08788f",
    brightWhite: "#4e566b",
  };

  let {
    project,
    workspace,
    onSelection,
  }: { project: Project; workspace?: Workspace | null | undefined; onSelection: (text: string) => void } = $props();
  let terminals: TerminalInfo[] = $state.raw([]);
  let selected: string | undefined = $state();
  let surface: HTMLDivElement | undefined = $state();
  let busy = $state(false);
  let trust = $state(false);
  let connection = $state("disconnected");
  let control = $state(false);
  let ctrl = $state(false);
  let screenReader = $state(false);
  let selection = $state("");
  let reconnect = $state(0);
  let error: string | undefined = $state();
  const active = $derived(terminals.find((terminal) => terminal.id === selected));
  const root = $derived(workspace?.root ?? project.root);
  const palette = $derived(shownTheme() === "light" ? LIGHT_THEME : THEME);
  // A theme change recolors the open shell in place; it is not a new session.
  $effect(() => {
    const theme = palette;
    if (runtime !== undefined) runtime.terminal.options.theme = theme;
  });
  /** On-screen keys only where a physical keyboard is unlikely; desktop shells take keys directly. */
  const touchKeys = $derived(viewport() !== "desktop" || matchMedia("(pointer: coarse)").matches);
  let runtime: { terminal: Terminal; ws: WebSocket; epoch: number } | undefined;
  const bytes = (text: string) => new TextEncoder().encode(text).length;

  async function refresh() {
    try {
      terminals = (await api.terminals(project.id)).terminals;
      if (!terminals.some((terminal) => terminal.id === selected)) selected = terminals[0]?.id;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  async function create() {
    if (!trust) return;
    busy = true;
    error = undefined;
    try {
      const { terminal } = await api.newTerminal(project.id, workspace?.id);
      terminals = [...terminals, terminal];
      selected = terminal.id;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
  async function close(id: string) {
    busy = true;
    try {
      await api.closeTerminal(project.id, id);
      await refresh();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
  function send(message: unknown) {
    if (runtime?.ws.readyState !== WebSocket.OPEN) return;
    if (runtime.ws.bufferedAmount > 32 * 1024) {
      error = "Input connection is busy; try again when it drains.";
      return;
    }
    runtime.ws.send(JSON.stringify(message));
  }
  function input(data: string) {
    if (!control || connection !== "connected") return;
    if (bytes(data) > 16 * 1024) {
      error = "Paste is limited to 16 KiB. Nothing was sent.";
      return;
    }
    if (ctrl && data.length === 1) data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
    ctrl = false;
    send({ type: "input", epoch: runtime?.epoch, data });
  }
  function key(data: string) {
    input(data);
    runtime?.terminal.focus();
  }
  onMount(() => {
    void refresh();
  });

  $effect(() => {
    const id = selected,
      host = surface,
      projectId = project.id;
    void reconnect;
    if (id === undefined || host === undefined) return;
    let cancelled = false;
    let terminal: Terminal | undefined;
    let ws: WebSocket | undefined;
    let resize: ResizeObserver | undefined;
    connection = "connecting";
    control = false;
    selection = "";
    ctrl = false;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      // xterm measures one glyph when it opens, so the font must be ready or the grid drifts.
      await document.fonts.load(`13px "${FONT}"`).catch(() => {});
      if (cancelled) return;
      const term = new Terminal({
        cols: 80,
        rows: 24,
        scrollback: 1000,
        fontFamily: `"${FONT}", ui-monospace, Menlo, monospace`,
        fontSize: 13,
        lineHeight: 1.2,
        fontWeightBold: 700,
        theme: palette,
        cursorStyle: "block",
        cursorInactiveStyle: "outline",
        cursorBlink: !matchMedia("(prefers-reduced-motion: reduce)").matches,
        minimumContrastRatio: 4.5,
        disableStdin: true,
        convertEol: false,
        screenReaderMode: screenReader,
      });
      terminal = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      term.textarea?.setAttribute("aria-label", "Terminal input");
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${scheme}//${location.host}/api/terminals/${id}/socket`);
      ws = socket;
      runtime = { terminal: term, ws: socket, epoch: 0 };
      let pending = 0;
      function fitController() {
        if (!control || connection !== "connected") return;
        const dimensions = fit.proposeDimensions();
        if (dimensions === undefined) return;
        const cols = Math.max(20, Math.min(240, dimensions.cols)),
          rows = Math.max(5, Math.min(80, dimensions.rows));
        if (cols !== term.cols || rows !== term.rows) send({ type: "resize", epoch: runtime?.epoch, cols, rows });
      }
      resize = new ResizeObserver(fitController);
      resize.observe(host);
      term.onData(input);
      term.onSelectionChange(() => {
        selection = term.getSelection();
      });
      socket.onmessage = (event: MessageEvent<string>) => {
        if (cancelled) return;
        try {
          if (typeof event.data !== "string" || event.data.length > 1024 * 1024)
            throw new Error("Terminal frame exceeds its limit");
          const message = JSON.parse(event.data) as {
            type: string;
            data?: string;
            epoch?: number;
            control?: boolean;
            cols?: number;
            rows?: number;
            ended?: boolean;
            reason?: string | null;
            message?: string;
            trimmed?: boolean;
          };
          if (message.type === "snapshot" || message.type === "resize") {
            if (
              typeof message.cols !== "number" ||
              typeof message.rows !== "number" ||
              !Number.isInteger(message.cols) ||
              !Number.isInteger(message.rows) ||
              (message.cols ?? 0) < 20 ||
              (message.cols ?? 0) > 240 ||
              (message.rows ?? 0) < 5 ||
              (message.rows ?? 0) > 80
            )
              throw new Error("Invalid terminal size");
            if (message.type === "snapshot") term.reset();
            term.resize(message.cols, message.rows);
          }
          if (message.type === "snapshot" || message.type === "output") {
            if (typeof message.data !== "string") throw new Error("Invalid terminal output");
            const size = bytes(message.data);
            pending += size;
            if (pending > 2 * 1024 * 1024)
              throw new Error("Terminal renderer is behind; reconnect for the live screen");
            term.write(message.data, () => {
              pending -= size;
              if (cancelled) return;
              if (message.type === "snapshot") {
                connection = "connected";
                fitController();
              }
            });
            if (message.trimmed)
              error = "Reconnect restored the live screen; older scrollback exceeded its byte limit.";
          } else if (message.type === "state") {
            control = message.control === true;
            if (!control) ctrl = false;
            if (runtime !== undefined && typeof message.epoch === "number") runtime.epoch = message.epoch;
            term.options.disableStdin = !control;
            terminals = terminals.map((entry) =>
              entry.id === id && entry.projectId === projectId
                ? { ...entry, ended: message.ended === true, reason: message.reason ?? null }
                : entry,
            );
            fitController();
          } else if (message.type === "error") error = message.message ?? "Terminal request refused";
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
          socket.close();
        }
      };
      socket.onclose = () => {
        if (!cancelled) {
          connection = "disconnected";
          control = false;
        }
      };
      socket.onerror = () => {
        if (!cancelled)
          error = "Terminal connection failed. Reconnect to the existing session; input is never replayed.";
      };
    })().catch((failure: unknown) => {
      if (!cancelled) {
        error = failure instanceof Error ? failure.message : String(failure);
        connection = "disconnected";
      }
    });
    return () => {
      cancelled = true;
      resize?.disconnect();
      ws?.close();
      terminal?.dispose();
      runtime = undefined;
    };
  });
</script>

<div class="terminal">
  <div class="sessions" role="group" aria-label="Terminal sessions">
    {#each terminals as terminal, index (terminal.id)}
      <span class="session" class:on={selected === terminal.id}>
        <button class="tab" aria-pressed={selected === terminal.id} onclick={() => (selected = terminal.id)}
          ><span class="dot" class:ended={terminal.ended}></span>Shell {index + 1}</button
        >
        <button
          class="b i q sm"
          aria-label={`Close terminal ${index + 1}`}
          disabled={busy}
          onclick={() => close(terminal.id)}><Icon name="x" size={14} /></button
        >
      </span>
    {/each}
    <button
      class="b sm q new"
      disabled={busy || !trust || (workspace != null && workspace.state !== "ready")}
      onclick={create}><Icon name="plus" />New host terminal</button
    >
  </div>
  <div class="trust" class:ok={trust || terminals.length > 0}>
    {#if trust || terminals.length > 0}
      <Icon name="warn" /><span class="grow ellipsis" title={root}
        >Host shell, not a sandbox · new sessions start in <span class="mono">{root}</span></span
      >
    {:else}
      <span
        >Host shell, not a sandbox. New sessions start in <span class="mono">{root}</span>. Existing sessions keep their
        own directories. The agent never types here; only text you select enters the composer.</span
      >
    {/if}
    <label
      ><input type="checkbox" bind:checked={trust} />I understand this shell has the Pal host user's authority.</label
    >
  </div>
  {#if error}<div class="callout er" role="alert">{error}</div>{/if}
  {#if !active}<p class="empty">No terminal sessions. A new shell starts only when you request it.</p>{/if}
  <div class="surface" class:inactive={!active} style:background={palette.background} bind:this={surface}></div>
  {#if active && touchKeys}
    <div class="keys" role="toolbar" aria-label="Terminal keys">
      <button class="b sm" disabled={!control} onclick={() => key("\x1b")}>Esc</button>
      <button class="b sm" disabled={!control} aria-pressed={ctrl} onclick={() => (ctrl = !ctrl)}>Ctrl</button>
      <button class="b sm" disabled={!control} onclick={() => key("\t")}>Tab</button>
      <button class="b sm" disabled={!control} onclick={() => key("\x03")}>Ctrl+C</button>
      <button class="b sm" disabled={!control} onclick={() => key("\x1b[A")} aria-label="Up arrow">↑</button>
      <button class="b sm" disabled={!control} onclick={() => key("\x1b[B")} aria-label="Down arrow">↓</button>
      <button class="b sm" disabled={!control} onclick={() => key("\x1b[D")} aria-label="Left arrow">←</button>
      <button class="b sm" disabled={!control} onclick={() => key("\x1b[C")} aria-label="Right arrow">→</button>
    </div>
  {/if}
  {#if active}
    <div class="status">
      <span
        class="state"
        class:live={connection === "connected" && control && !active.ended}
        class:watch={connection === "connected" && !control && !active.ended}
        role="status"
        ><span class="dot"></span>{active.ended
          ? `Session ended. ${active.reason ?? ""}`
          : connection === "connected"
            ? control
              ? "You control this shell"
              : "Observing; another view may control input"
            : `${connection}; displayed screen may be stale`}</span
      >
      {#if connection === "disconnected"}<button
          class="b sm"
          onclick={() => {
            error = undefined;
            reconnect++;
          }}>Reconnect</button
        >{/if}
      {#if connection === "connected" && !control && !active.ended}<button
          class="b sm"
          onclick={() => send({ type: "take" })}>Take control</button
        >{/if}
      <span class="grow"></span>
      <button class="b sm q" onclick={() => runtime?.terminal.selectAll()}>Select output</button>
      <button
        class="b sm q"
        disabled={!selection || bytes(selection) > 16 * 1024}
        onclick={() => onSelection(selection)}>Send selection to composer</button
      >
      <label class="sr-mode"
        ><input
          type="checkbox"
          checked={screenReader}
          onchange={(event) => {
            screenReader = event.currentTarget.checked;
            if (runtime) runtime.terminal.options.screenReaderMode = screenReader;
          }}
        />Screen reader mode</label
      >
      <details>
        <summary>Limits</summary>
        <p>
          Four sessions, three observers each. 200 server scrollback lines; slow views disconnect. 16 KiB paste, 1 MiB
          lifetime input and 16 MiB lifetime output per shell; output floods stop it. Closing sends HUP, then kills an
          unresponsive shell. Deliberately detached host processes can outlive it.
        </p>
      </details>
    </div>
  {/if}
</div>

<style>
  .terminal {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    background: var(--bg0);
  }
  .sessions {
    display: flex;
    align-items: center;
    padding: 4px 8px 0;
    min-height: 38px;
    gap: 2px;
    overflow-x: auto;
    flex-shrink: 0;
    border-bottom: 1px solid var(--line);
  }
  .session {
    display: inline-flex;
    align-items: center;
    padding-right: 2px;
    border-radius: 8px 8px 0 0;
    color: var(--tx3);
    transition:
      background-color var(--fast) var(--ease),
      color var(--fast) var(--ease);
  }
  .session.on {
    background: var(--bg2);
    color: var(--tx);
    box-shadow: inset 0 2px 0 var(--focus);
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 7px;
    background: transparent;
    border: 0;
    color: inherit;
    padding: 8px 4px 8px 10px;
    font: 500 12.5px var(--mono);
    white-space: nowrap;
  }
  .new {
    margin-left: 4px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ok);
    flex: 0 0 auto;
  }
  .dot.ended {
    background: var(--tx3);
  }
  .trust {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    padding: 8px 12px;
    font-size: 12.5px;
    color: var(--tx2);
    background: var(--wabg);
    border-bottom: 1px solid var(--line);
  }
  .trust.ok {
    padding: 5px 12px;
    color: var(--tx3);
    background: transparent;
  }
  .trust.ok :global(svg) {
    color: var(--wa);
    width: 14px;
    height: 14px;
  }
  .trust span {
    overflow-wrap: anywhere;
  }
  .trust .grow {
    flex-basis: 220px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  label {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--tx2);
  }
  .surface {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    padding: 10px 6px 6px 14px;
  }
  .surface.inactive {
    display: none;
  }
  .surface :global(.xterm) {
    height: 100%;
  }
  .surface :global(.xterm-viewport) {
    scrollbar-color: var(--line2) transparent;
  }
  .empty {
    flex: 1;
    padding: 24px 16px;
    margin: 0;
    color: var(--tx2);
    font-size: 13.5px;
  }
  .keys {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding: 6px 8px;
    border-top: 1px solid var(--line);
    flex-shrink: 0;
  }
  .keys .b {
    min-width: 38px;
    min-height: 36px;
    font-family: var(--mono);
  }
  .status {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 6px;
    padding: 4px 8px 4px 12px;
    min-height: 34px;
    border-top: 1px solid var(--line);
    background: var(--bg1);
    font-size: 12px;
    color: var(--tx3);
    flex-shrink: 0;
    padding-bottom: max(4px, env(safe-area-inset-bottom));
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--tx2);
  }
  .state .dot {
    background: var(--tx3);
  }
  .state.live .dot {
    background: var(--ok);
    box-shadow: 0 0 0 3px var(--okbg);
  }
  .state.watch .dot {
    background: var(--wa);
  }
  .sr-mode {
    font-size: 12px;
    margin: 0 4px;
  }
  details {
    position: relative;
  }
  summary {
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 6px;
  }
  summary:hover {
    color: var(--tx);
  }
  details p {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 5;
    width: min(360px, 80vw);
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--line2);
    border-radius: 10px;
    background: var(--bg2);
    box-shadow: var(--shadow);
    color: var(--tx2);
    line-height: 1.5;
    animation: pop-in var(--mid) var(--ease);
  }
</style>
