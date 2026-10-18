<script lang="ts">
  import { onMount } from "svelte";
  import type { Terminal } from "@xterm/xterm";
  import { api, type Project, type TerminalInfo, type Workspace } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";

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
      if (cancelled) return;
      const term = new Terminal({
        cols: 80,
        rows: 24,
        scrollback: 1000,
        fontFamily: '"Atkinson Hyperlegible Mono Variable", monospace',
        fontSize: 12,
        theme: { background: "#0d0d0e", foreground: "#e8e8ea", cursor: "#8ea4ff", selectionBackground: "#46519a" },
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
  <div class="sessions" aria-label="Terminal sessions">
    {#each terminals as terminal, index (terminal.id)}
      <button class="tab" aria-pressed={selected === terminal.id} onclick={() => (selected = terminal.id)}
        ><span class="dot" class:ended={terminal.ended}></span>Shell {index + 1}</button
      >
      <button
        class="b i q sm"
        aria-label={`Close terminal ${index + 1}`}
        disabled={busy}
        onclick={() => close(terminal.id)}><Icon name="x" /></button
      >
    {/each}
    <button
      class="b sm q"
      disabled={busy || !trust || (workspace != null && workspace.state !== "ready")}
      onclick={create}><Icon name="plus" />New host terminal</button
    >
  </div>
  <div class="trust">
    <span
      >Host shell, not a sandbox. New sessions start in <span class="mono">{workspace?.root ?? project.root}</span>.
      Existing sessions keep their own directories.</span
    >
    <label
      ><input type="checkbox" bind:checked={trust} /> I understand this shell has the Pal host user's authority.</label
    >
  </div>
  {#if error}<div class="callout er" role="alert">{error}</div>{/if}
  {#if active}
    <div class="status" role="status">
      <span
        >{active.ended
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
      <button class="b sm q" onclick={() => runtime?.terminal.selectAll()}>Select output</button>
      <button
        class="b sm q"
        disabled={!selection || bytes(selection) > 16 * 1024}
        onclick={() => onSelection(selection)}>Send selection to composer</button
      >
    </div>
  {:else}<p class="empty">No terminal sessions. A new shell starts only when you request it.</p>{/if}
  <div class="surface" class:inactive={!active} bind:this={surface}></div>
  {#if active}
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
  <div class="foot">
    {#if active}<label
        ><input
          type="checkbox"
          checked={screenReader}
          onchange={(event) => {
            screenReader = event.currentTarget.checked;
            if (runtime) runtime.terminal.options.screenReaderMode = screenReader;
          }}
        />Screen reader mode</label
      >{/if}
    The agent never types here. Only your selected text enters the composer.
    <details>
      <summary>Session limits</summary>Four sessions, three observers each. 200 server scrollback lines; slow views
      disconnect. 16 KiB paste, 1 MiB lifetime input and 16 MiB lifetime output per shell; output floods stop it.
      Closing sends HUP, then kills an unresponsive shell. Deliberately detached host processes can outlive it.
    </details>
  </div>
</div>

<style>
  .terminal {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    background: #0d0d0e;
  }
  .sessions {
    display: flex;
    align-items: center;
    padding: 2px 6px;
    min-height: 38px;
    gap: 2px;
    overflow-x: auto;
    flex-shrink: 0;
    border-bottom: 1px solid var(--line);
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 7px;
    background: transparent;
    border: 0;
    color: var(--tx3);
    padding: 8px;
    font: 12px var(--mono);
    white-space: nowrap;
  }
  .tab[aria-pressed="true"] {
    color: var(--tx);
    background: var(--bg2);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
  }
  .dot.ended {
    background: var(--tx3);
  }
  .trust {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 6px 12px;
    font-size: 11.5px;
    color: var(--tx3);
    border-bottom: 1px solid var(--line);
  }
  .trust span {
    overflow-wrap: anywhere;
  }
  label {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--tx2);
  }
  .status {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 12px;
    color: var(--tx2);
    font-size: 12px;
  }
  .status > span {
    flex: 1;
  }
  .surface {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: 6px 12px;
  }
  .surface.inactive {
    display: none;
  }
  .surface :global(.xterm) {
    height: 100%;
  }
  .empty {
    flex: 1;
    padding: 20px 16px;
    margin: 0;
    color: var(--tx2);
    font-size: 13px;
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
    min-width: 36px;
    min-height: 34px;
  }
  .foot {
    padding: 4px 12px 6px;
    color: var(--tx3);
    font-size: 11.5px;
  }
  details {
    max-height: 120px;
    overflow: auto;
  }
</style>
