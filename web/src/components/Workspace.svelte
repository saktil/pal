<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, requestId } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import { app, navigate, refreshChatGPT, refreshProjects, type Route, viewport } from "../lib/state.svelte.ts";
  import ChatView from "./ChatView.svelte";
  import CreateProject from "./CreateProject.svelte";
  import Settings from "./Settings.svelte";
  import Sidebar from "./Sidebar.svelte";

  let { onSignOut }: { onSignOut: () => void } = $props();

  /** The route the drawer was opened on: navigating anywhere closes it. */
  let drawerRoute: Route | undefined = $state();
  const drawer = $derived(drawerRoute !== undefined && drawerRoute === app.route);
  let creating = $state(false);
  let error: string | undefined = $state();
  let loaded = $state(false);
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
        {#key located.chat.id}
          <ChatView chat={located.chat} project={located.project} />
        {/key}
      {:else if loaded}
        <div class="center">
          <div class="intro">
            {#if size === "tablet"}
              <button class="b q" onclick={() => (drawerRoute = app.route)}><Icon name="menu" />Projects</button>
            {/if}
            {#if app.projects.length === 0}
              <h1>No projects yet</h1>
              <p>
                A project gives Pal a folder on this server to work in, with its own chats. Pal can create a new folder
                or use one that already exists.
              </p>
              <button class="b p" onclick={() => (creating = true)}><Icon name="folderPlus" />Create project</button>
            {:else}
              <h1>{chatId === undefined ? "Pick a chat" : "Chat not found"}</h1>
              <p>Choose a chat in a project, or start a new one.</p>
              {@const ready = app.projects.find((project) => project.state === "ready")}
              {#if ready}<button class="b p" onclick={() => newChat(ready.id)}
                  ><Icon name="plus" />New chat in {ready.name}</button
                >{/if}
            {/if}
          </div>
        </div>
      {/if}
    </main>
  </div>
</div>

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
