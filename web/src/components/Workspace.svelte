<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type ChatSummary, requestId, type WorkspaceMode } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import {
    app,
    navigate,
    refreshChatGPT,
    refreshProjects,
    refreshProviders,
    readSetting,
    refreshExtensions,
    type Route,
    saveSetting,
    viewport,
  } from "../lib/state.svelte.ts";
  import ChatView from "./ChatView.svelte";
  import CreateProject from "./CreateProject.svelte";
  import Onboarding from "./Onboarding.svelte";
  import ProjectMcpSettings from "./ProjectMcpSettings.svelte";
  import RenameChat from "./RenameChat.svelte";
  import Settings from "./Settings.svelte";
  import Sidebar from "./Sidebar.svelte";

  let { onSignOut }: { onSignOut: () => void } = $props();

  /** The route the drawer was opened on: navigating anywhere closes it. */
  let drawerRoute: Route | undefined = $state();
  const drawer = $derived(drawerRoute !== undefined && drawerRoute === app.route);
  let creating = $state(false);
  let renaming: ChatSummary | undefined = $state.raw();
  let error: string | undefined = $state();
  let loaded = $state(false);
  let panelRoute: Route | undefined = $state();
  const panel = $derived(panelRoute === app.route);
  const changesPanel = () => import("./ChangesPanel.svelte");
  const filesPanel = () => import("./FilesPanel.svelte");
  const terminalPanel = () => import("./TerminalPanel.svelte");
  const contextPanel = () => import("./ContextPanel.svelte");
  const browserPanel = () => import("./BrowserPanel.svelte");
  type PanelView = "Changes" | "Files" | "Terminal" | "Context" | "Browser";
  let panelView = $state<PanelView>("Changes");
  const panelButtons = [
    { id: "Changes", icon: "edit" },
    { id: "Files", icon: "folder" },
    { id: "Context", icon: "read" },
    { id: "Browser", icon: "globe" },
    { id: "Terminal", icon: "term" },
  ] as const;
  type Dock = "bottom" | "side";
  /** Where Terminal sits beside the chat on desktop, and the share of the work area it takes, per position. */
  let dock: Dock = $state(readSetting("pal.terminalDock") === "side" ? "side" : "bottom");
  const SHARE = { min: 20, max: 80, step: 5 };
  function storedShare(where: Dock): number {
    const value = Number(readSetting(`pal.terminalShare.${where}`));
    return Number.isFinite(value) && value >= SHARE.min && value <= SHARE.max ? value : where === "bottom" ? 45 : 50;
  }
  let shares = $state({ bottom: storedShare("bottom"), side: storedShare("side") });
  let workarea: HTMLDivElement | undefined = $state();
  function setDock(next: Dock) {
    dock = next;
    saveSetting("pal.terminalDock", next);
  }
  function setShare(value: number, save = true) {
    shares[dock] = Math.round(Math.min(SHARE.max, Math.max(SHARE.min, value)));
    if (save) saveSetting(`pal.terminalShare.${dock}`, String(shares[dock]));
  }
  function drag(event: PointerEvent) {
    if (workarea === undefined || event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const box = workarea.getBoundingClientRect();
    const move = (next: PointerEvent) =>
      setShare(
        dock === "bottom"
          ? ((box.bottom - next.clientY) / box.height) * 100
          : ((box.right - next.clientX) / box.width) * 100,
        false,
      );
    const end = () => {
      handle.removeEventListener("pointermove", move);
      setShare(shares[dock]);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", end, { once: true });
  }
  /** The divider is a slider over its own position: from the bottom when docked below, from the left beside. */
  const position = $derived(dock === "bottom" ? shares.bottom : 100 - shares.side);
  function nudge(event: KeyboardEvent) {
    const steps: Record<string, number> = {
      ArrowUp: position + SHARE.step,
      ArrowRight: position + SHARE.step,
      ArrowDown: position - SHARE.step,
      ArrowLeft: position - SHARE.step,
      Home: SHARE.min,
      End: SHARE.max,
    };
    const next = steps[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setShare(dock === "bottom" ? next : 100 - next);
  }
  function dockKeys(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    setDock(dock === "bottom" ? "side" : "bottom");
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }
  /** A file Files asked Changes to open. */
  let diffPath: string | undefined = $state();
  let chatView: { insertText(text: string): void } | undefined = $state();
  function togglePanel(view: PanelView) {
    diffPath = undefined;
    panelRoute = panel && panelView === view ? undefined : app.route;
    panelView = view;
  }
  const size = $derived(viewport());
  const docked = $derived(panel && panelView === "Terminal" && size === "desktop");
  const chatId = $derived(app.route.view === "chat" ? app.route.chatId : undefined);
  const located = $derived.by(() => {
    for (const project of app.projects) {
      const chat = project.chats.find((candidate) => candidate.id === chatId);
      if (chat !== undefined) return { project, chat };
    }
    return undefined;
  });

  const enabledPanels = $derived(
    new Set(
      (app.extensions?.catalog ?? [])
        .filter((item) =>
          located?.chat.extensions.some((choice) => choice.id === item.id && choice.version === item.version),
        )
        .flatMap((item) => [...item.panels]),
    ),
  );

  onMount(() => {
    void Promise.all([refreshProjects(), refreshChatGPT(), refreshProviders(), refreshExtensions()])
      .catch((failure: unknown) => (error = failure instanceof Error ? failure.message : String(failure)))
      .finally(() => (loaded = true));
  });

  let creatingChat = false;
  let pendingChat: { key: string; project: string; mode: WorkspaceMode } | undefined;
  async function newChat(projectId: string, mode: WorkspaceMode = "local") {
    if (creatingChat) return;
    creatingChat = true;
    if (pendingChat?.project !== projectId || pendingChat.mode !== mode)
      pendingChat = { key: requestId(), project: projectId, mode };
    error = undefined;
    try {
      const { chat } = await api.createChat(pendingChat.key, projectId, mode);
      await refreshProjects();
      navigate({ view: "chat", chatId: chat.id });
      pendingChat = undefined;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      creatingChat = false;
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    // Terminal and Browser pass Escape to the shell or page.
    if (
      event.key === "Escape" &&
      panelView !== "Terminal" &&
      panelView !== "Browser" &&
      document.querySelector("dialog[open]") === null
    )
      panelRoute = undefined;
  }}
/>

{#if !loaded}
  <div class="center" role="status">Loading Pal…</div>
{:else if error !== undefined && app.projects.length === 0}
  <div class="center">
    <div class="callout er" role="alert">Couldn't load Pal: {error}</div>
    <button class="b" onclick={() => location.reload()}>Try again</button>
  </div>
{:else if app.projects.length === 0}
  <Onboarding onCreateProject={() => (creating = true)} />
{:else}
  <div class="shell">
    {#if size === "phone" && app.route.view !== "settings"}
      <header class="phonehdr">
        <button class="b i q" aria-label="Projects and chats" onclick={() => (drawerRoute = app.route)}
          ><Icon name="menu" /></button
        >
        <div class="phonetitle">
          <div class="t">{located?.chat.title ?? (located ? "New chat" : "Pal")}</div>
          {#if located}<div class="s" title={located.chat.workspace?.root ?? located.project.root}>
              {located.project.name} · {located.chat.workspace?.root ?? located.project.root}
            </div>{/if}
        </div>
      </header>
    {/if}
    <div class="body">
      {#if size === "desktop" || drawer}
        <div
          class="side"
          class:drawer={size !== "desktop"}
          style:width={size === "desktop" ? "264px" : size === "phone" ? "86%" : "300px"}
        >
          <Sidebar
            currentChatId={chatId}
            onNewChat={newChat}
            onCreateProject={() => (creating = true)}
            onRenameChat={(chat) => (renaming = { ...chat })}
            {...size === "desktop" ? {} : { onClose: () => (drawerRoute = undefined) }}
          />
        </div>
      {/if}
      {#if size !== "desktop" && drawer}
        <button class="scrim" aria-label="Close projects" onclick={() => (drawerRoute = undefined)}></button>
      {/if}

      <main>
        {#if error !== undefined}<div class="callout er banner" role="alert">{error}</div>{/if}
        {#if app.route.view === "settings"}
          <Settings tab={app.route.tab} {onSignOut} />
        {:else if located !== undefined}
          {@const root = located.chat.workspace?.root ?? located.project.root}
          <header class="chathead" class:compact={size === "phone"}>
            {#if size === "tablet"}<button
                class="b i q"
                aria-label="Projects and chats"
                onclick={() => (drawerRoute = app.route)}><Icon name="menu" /></button
              >{/if}
            {#if size !== "phone"}
              <div class="titles">
                <h1>{located.chat.title ?? "New chat"}</h1>
                <div class="where" title={root}>
                  <span>{located.project.name}</span><span class="mono path">{root}</span>
                </div>
              </div>
            {/if}
            <div class="tools">
              {#key located.project.id}<ProjectMcpSettings project={located.project} />{/key}
              {#each panelButtons as item (item.id)}
                {#if enabledPanels.has(item.id)}
                  <button
                    class="b sm q"
                    class:i={size !== "desktop"}
                    aria-label={size === "desktop" ? undefined : item.id}
                    title={size === "desktop" ? undefined : item.id}
                    aria-expanded={panel && panelView === item.id}
                    onclick={() => togglePanel(item.id)}
                    ><Icon name={item.icon} />{#if size === "desktop"}{item.id}{/if}</button
                  >
                {/if}
              {/each}
            </div>
          </header>
          <div
            class="workarea"
            class:dock-bottom={docked && dock === "bottom"}
            class:dock-side={docked && dock === "side"}
            bind:this={workarea}
            style:--terminal-share={`${shares[dock]}%`}
          >
            <div class="chat-area">
              {#key located.chat.id}<ChatView
                  bind:this={chatView}
                  chat={located.chat}
                  project={located.project}
                  onNewChat={(mode) => newChat(located.project.id, mode)}
                />{/key}
            </div>
            {#if panel && enabledPanels.has(panelView)}
              {#if docked}<div
                  class="divider"
                  role="slider"
                  tabindex="0"
                  aria-label="Resize terminal"
                  aria-orientation={dock === "bottom" ? "vertical" : "horizontal"}
                  aria-valuemin={SHARE.min}
                  aria-valuemax={SHARE.max}
                  aria-valuenow={position}
                  aria-valuetext={`Terminal ${shares[dock]}% of the work area`}
                  onpointerdown={drag}
                  onkeydown={nudge}
                ></div>{/if}
              {#if size === "tablet"}<button
                  class="panel-scrim"
                  aria-label="Close workspace panel"
                  onclick={() => (panelRoute = undefined)}
                ></button>{/if}
              <aside
                class="workspace-panel"
                class:terminal-panel={panelView === "Terminal"}
                aria-label="Workspace panel"
              >
                <div class="panelhead">
                  <h2>{panelView}</h2>
                  {#if docked}
                    <div
                      class="seg"
                      role="radiogroup"
                      aria-label="Terminal position"
                      tabindex="-1"
                      onkeydown={dockKeys}
                    >
                      {#each [["bottom", "Bottom", "dockBottom"], ["side", "Side", "dockSide"]] as const as [where, label, icon] (where)}
                        <button
                          class="segb"
                          role="radio"
                          aria-checked={dock === where}
                          tabindex={dock === where ? 0 : -1}
                          onclick={() => setDock(where)}><Icon name={icon} size={14} />{label}</button
                        >
                      {/each}
                    </div>
                  {/if}
                  <button class="b i q" aria-label="Close panel" onclick={() => (panelRoute = undefined)}
                    ><Icon name="x" /></button
                  >
                </div>
                {#key located.chat.workspace?.id ?? located.project.id}
                  {#if panelView === "Terminal"}
                    {#await terminalPanel()}<p role="status">Loading terminal…</p>
                    {:then { default: TerminalPanel }}
                      <TerminalPanel
                        project={located.project}
                        workspace={located.chat.workspace}
                        onSelection={(text) => {
                          chatView?.insertText(`Terminal selection (human shell):\n\n${text}`);
                          panelRoute = undefined;
                        }}
                      />
                    {:catch failure}<p role="alert">Couldn’t load terminal: {String(failure)}</p>{/await}
                  {:else if panelView === "Browser"}
                    {#await browserPanel()}<p role="status">Loading browser…</p>
                    {:then { default: BrowserPanel }}
                      {#key located.chat.id}<BrowserPanel project={located.project} chatId={located.chat.id} />{/key}
                    {:catch failure}<p role="alert">Couldn't load the browser: {String(failure)}</p>{/await}
                  {:else if panelView === "Context"}
                    {#await contextPanel()}<p role="status">Loading context…</p>
                    {:then { default: ContextPanel }}
                      <ContextPanel project={located.project} chat={located.chat} workspace={located.chat.workspace} />
                    {:catch failure}<p role="alert">Couldn't load context: {String(failure)}</p>{/await}
                  {:else if panelView === "Files"}
                    {#await filesPanel()}<p role="status">Loading files…</p>
                    {:then { default: FilesPanel }}
                      <FilesPanel
                        project={located.project}
                        workspace={located.chat.workspace}
                        onAttach={(text) => {
                          chatView?.insertText(text);
                          // Overlay panels give the composer back; the desktop side panel stays open.
                          if (size !== "desktop") panelRoute = undefined;
                        }}
                        onViewDiff={(path) => {
                          diffPath = path;
                          panelView = "Changes";
                        }}
                      />
                    {:catch failure}<p role="alert">Couldn't load files: {String(failure)}</p>{/await}
                  {:else}
                    {#await changesPanel()}
                      <p role="status">Loading changes…</p>
                    {:then { default: ChangesPanel }}
                      <ChangesPanel
                        project={located.project}
                        workspace={located.chat.workspace}
                        initialPath={diffPath}
                        onFeedback={(text) => {
                          chatView?.insertText(text);
                          if (size !== "desktop") panelRoute = undefined;
                        }}
                      />
                    {:catch failure}<p role="alert">Couldn't load changes: {String(failure)}</p>{/await}
                  {/if}
                {/key}
              </aside>
            {/if}
          </div>
        {:else if loaded}
          {@const ready = app.projects.find((project) => project.state === "ready")}
          <div class="center">
            <div class="intro">
              {#if size === "tablet"}
                <button class="b q" onclick={() => (drawerRoute = app.route)}><Icon name="menu" />Projects</button>
              {/if}
              <h1>{chatId === undefined ? "Pick a chat" : "Chat not found"}</h1>
              <p>Choose a chat in a project, or start a new one.</p>
              {#if ready}<button class="b p" onclick={() => newChat(ready.id)}
                  ><Icon name="plus" />New chat in {ready.name}</button
                >{/if}
            </div>
          </div>
        {/if}
      </main>
    </div>
  </div>
{/if}

{#if creating}
  <CreateProject
    onClose={() => (creating = false)}
    onCreated={async (project) => {
      creating = false;
      await refreshProjects();
      await newChat(project.id);
    }}
  />
{/if}

{#if renaming}
  <RenameChat chat={renaming} onClose={() => (renaming = undefined)} />
{/if}

<style>
  .shell {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--bg1);
    overflow: hidden;
  }
  .phonehdr {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 4px;
    padding-top: max(2px, env(safe-area-inset-top));
    border-bottom: 1px solid var(--line);
    background: var(--bg1);
  }
  .phonetitle {
    flex: 1;
    min-width: 0;
    padding: 4px;
  }
  .phonetitle .t {
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .phonetitle .s {
    font-size: 12px;
    color: var(--tx3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
  }
  .side {
    flex: 0 0 auto;
    border-right: 1px solid var(--line);
    min-height: 0;
  }
  .drawer {
    position: absolute;
    z-index: 30;
    top: 0;
    bottom: 0;
    left: 0;
    box-shadow: var(--shadow);
    animation: slide-left var(--mid) var(--ease);
  }
  main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .banner {
    margin: 8px 12px 0;
  }
  .chathead {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px 12px;
    min-height: 56px;
    padding: 8px 10px 8px 20px;
    border-bottom: 1px solid var(--line);
  }
  .chathead.compact {
    min-height: 0;
    padding: 4px 6px;
  }
  .titles {
    flex: 1 1 0;
    min-width: 0;
  }
  .titles h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .where {
    display: flex;
    gap: 8px;
    min-width: 0;
    font-size: 12.5px;
    color: var(--tx3);
    white-space: nowrap;
  }
  .where .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
  }
  .tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    margin-left: auto;
    flex-wrap: wrap;
  }
  .workarea {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
  }
  .workarea.dock-bottom {
    flex-direction: column;
  }
  .dock-bottom .workspace-panel.terminal-panel {
    width: 100%;
    height: var(--terminal-share);
    border-left: 0;
  }
  .dock-side .workspace-panel.terminal-panel {
    width: var(--terminal-share);
  }
  /* A wide hit area around a hairline; the line brightens while hovered, focused or dragged. */
  .divider {
    position: relative;
    flex: 0 0 auto;
    z-index: 27;
    background: transparent;
    touch-action: none;
  }
  .dock-bottom .divider {
    height: 7px;
    margin: -3px 0;
    cursor: row-resize;
  }
  .dock-side .divider {
    width: 7px;
    margin: 0 -3px;
    cursor: col-resize;
  }
  .divider::after {
    content: "";
    position: absolute;
    background: var(--line);
    transition: background-color var(--fast) var(--ease);
  }
  .dock-bottom .divider::after {
    inset: 3px 0;
  }
  .dock-side .divider::after {
    inset: 0 3px;
  }
  .divider:hover::after,
  .divider:focus-visible::after,
  .divider:active::after {
    background: var(--focus);
  }
  .divider:focus-visible {
    outline: none;
  }
  .panelhead .seg {
    margin-right: 4px;
  }
  .panelhead .segb {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .chat-area {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .workspace-panel {
    display: flex;
    flex-direction: column;
    width: 52%;
    min-width: 0;
    border-left: 1px solid var(--line);
    background: var(--bg1);
    z-index: 26;
    animation: fade var(--mid) var(--ease);
  }
  .panelhead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px 4px 12px;
    border-bottom: 1px solid var(--line);
    min-height: 44px;
  }
  .panelhead h2 {
    flex: 1;
    font-size: 14px;
    font-weight: 700;
    margin: 0;
  }
  .panel-scrim {
    position: absolute;
    inset: 0;
    z-index: 25;
    border: 0;
    background: var(--scrim);
    animation: fade var(--mid) var(--ease);
  }
  @media (max-width: 1099px) {
    .workspace-panel.terminal-panel {
      height: 100%;
    }
    .workspace-panel {
      position: absolute;
      inset: 0 0 0 auto;
      width: 70%;
      box-shadow: var(--shadow);
      animation: slide-right var(--mid) var(--ease);
    }
  }
  @media (max-width: 699px) {
    .workspace-panel {
      width: 100%;
      border-left: 0;
      box-shadow: none;
    }
  }
  .center {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .intro {
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  .intro h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.015em;
  }
  .intro p {
    margin: 0;
    color: var(--tx2);
  }
</style>
