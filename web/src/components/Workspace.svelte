<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, requestId } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import { app, navigate, refreshChatGPT, refreshProjects, type Route, viewport } from "../lib/state.svelte.ts";
  import ChatView from "./ChatView.svelte";
  import CreateProject from "./CreateProject.svelte";
  import Onboarding from "./Onboarding.svelte";
  import Settings from "./Settings.svelte";
  import Sidebar from "./Sidebar.svelte";

  let { onSignOut }: { onSignOut: () => void } = $props();

  /** The route the drawer was opened on: navigating anywhere closes it. */
  let drawerRoute: Route | undefined = $state();
  const drawer = $derived(drawerRoute !== undefined && drawerRoute === app.route);
  let creating = $state(false);
  let error: string | undefined = $state();
  let loaded = $state(false);
  let panelRoute: Route | undefined = $state();
  const panel = $derived(panelRoute === app.route);
  const changesPanel = () => import("./ChangesPanel.svelte");
  const size = $derived(viewport());
  const chatId = $derived(app.route.view === "chat" ? app.route.chatId : undefined);
  const located = $derived.by(() => {
    for (const project of app.projects) {
      const chat = project.chats.find((candidate) => candidate.id === chatId);
      if (chat !== undefined) return { project, chat };
    }
    return undefined;
  });

  onMount(() => {
    void Promise.all([refreshProjects(), refreshChatGPT()])
      .catch((failure: unknown) => (error = failure instanceof Error ? failure.message : String(failure)))
      .finally(() => (loaded = true));
  });

  async function newChat(projectId: string) {
    error = undefined;
    try {
      const { chat } = await api.createChat(requestId(), projectId);
      await refreshProjects();
      navigate({ view: "chat", chatId: chat.id });
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape") panelRoute = undefined;
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
  <Onboarding onCreateProject={() => (creating = true)} {onSignOut} />
{:else}
  <div class="shell">
    {#if size === "phone" && app.route.view !== "settings"}
      <header class="phonehdr">
        <button class="b i q" aria-label="Projects and chats" onclick={() => (drawerRoute = app.route)}
          ><Icon name="menu" /></button
        >
        <div class="phonetitle">
          <div class="t">{located?.chat.title ?? (located ? "New chat" : "Pal")}</div>
          {#if located}<div class="s">{located.project.name}</div>{/if}
        </div>
      </header>
    {/if}
    <div class="body">
      {#if size === "desktop" || drawer}
        <div
          class="side"
          class:drawer={size !== "desktop"}
          style:width={size === "desktop" ? "252px" : size === "phone" ? "86%" : "300px"}
        >
          <Sidebar
            currentChatId={chatId}
            onNewChat={newChat}
            onCreateProject={() => (creating = true)}
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
          <div class="workspace-tools">
            {#if size === "tablet"}<button
                class="b i q"
                aria-label="Projects and chats"
                onclick={() => (drawerRoute = app.route)}><Icon name="menu" /></button
              >{/if}
            <button class="b sm q" aria-expanded={panel} onclick={() => (panelRoute = panel ? undefined : app.route)}
              ><Icon name="edit" />Changes</button
            >
          </div>
          <div class="workarea">
            <div class="chat-area">
              {#key located.chat.id}<ChatView chat={located.chat} project={located.project} />{/key}
            </div>
            {#if panel}
              {#if size === "tablet"}<button
                  class="panel-scrim"
                  aria-label="Close workspace panel"
                  onclick={() => (panelRoute = undefined)}
                ></button>{/if}
              <aside class="workspace-panel" aria-label="Workspace panel">
                <div class="panelhead">
                  <h2>Changes</h2>
                  <button class="b i q" aria-label="Close panel" onclick={() => (panelRoute = undefined)}
                    ><Icon name="x" /></button
                  >
                </div>
                {#key located.project.id}
                  {#await changesPanel()}
                    <p role="status">Loading changes…</p>
                  {:then { default: ChangesPanel }}
                    <ChangesPanel project={located.project} />
                  {:catch failure}<p role="alert">Couldn't load changes: {String(failure)}</p>{/await}
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
    box-shadow: 16px 0 40px rgba(0, 0, 0, 0.5);
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
  .workspace-tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 4px 8px;
    border-bottom: 1px solid var(--line);
  }
  .workarea {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
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
    font-size: 13px;
    font-weight: 600;
    margin: 0;
  }
  .panel-scrim {
    position: absolute;
    inset: 0;
    z-index: 25;
    border: 0;
    background: rgba(0, 0, 0, 0.5);
  }
  @media (max-width: 1099px) {
    .workspace-panel {
      position: absolute;
      inset: 0 0 0 auto;
      width: 70%;
      box-shadow: -16px 0 40px rgba(0, 0, 0, 0.5);
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
    font-size: 18px;
    font-weight: 600;
  }
  .intro p {
    margin: 0;
    color: var(--tx2);
  }
</style>
