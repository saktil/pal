<script lang="ts">
  import { api, type ChatSummary } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import { app, navigate, refreshProjects } from "../lib/state.svelte.ts";
  import ConfirmRemoval from "./ConfirmRemoval.svelte";

  let {
    currentChatId,
    onNewChat,
    onCreateProject,
    onRenameChat,
    onClose,
  }: {
    currentChatId: string | undefined;
    onNewChat: (projectId: string) => void;
    onCreateProject: () => void;
    onRenameChat: (chat: ChatSummary) => void;
    /** Present when the sidebar is a drawer. */
    onClose?: () => void;
  } = $props();

  let collapsed: Record<string, boolean> = $state({});
  let removing: { kind: "chat" | "project"; id: string; name: string } | undefined = $state();

  async function remove() {
    const item = removing;
    if (item === undefined) return;
    if (item.kind === "chat") await api.deleteChat(item.id);
    else await api.removeProject(item.id);
    await refreshProjects();
    if (
      app.route.view === "chat" &&
      !app.projects.some((project) => project.chats.some((chat) => chat.id === currentChatId))
    )
      navigate({ view: "home" });
    removing = undefined;
  }
  const current = $derived(app.projects.find((project) => project.chats.some((chat) => chat.id === currentChatId)));
  const target = $derived(current ?? app.projects.find((project) => project.state === "ready"));

  function relative(at: number): string {
    const date = new Date(at);
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
</script>

<aside aria-label="Projects and chats">
  {#if onClose !== undefined}
    <div class="close">
      <button class="b i q" aria-label="Close projects" onclick={onClose}><Icon name="x" /></button>
    </div>
  {/if}
  <div class="actions">
    <button class="b grow" onclick={() => target && onNewChat(target.id)} disabled={target === undefined}>
      <Icon name="plus" />New chat
    </button>
    <button class="b" onclick={onCreateProject}><Icon name="folderPlus" />Project</button>
  </div>
  <nav aria-label="Projects">
    <div class="lbl">Projects</div>
    {#if app.projects.length === 0}<p class="none">No projects yet.</p>{/if}
    {#each app.projects as project (project.id)}
      {@const open = !collapsed[project.id]}
      <div class="project">
        <div class="head">
          <button class="row name" aria-expanded={open} onclick={() => (collapsed[project.id] = open)}>
            <Icon name={open ? "chevD" : "chevR"} />
            <span class="label">{project.name}</span>
            {#if project.state !== "ready"}
              <span class="cmeta wa">{project.state === "failed" ? "Failed" : "Preparing"}</span>
            {:else}
              <span class="cmeta">{project.chats.length}</span>
            {/if}
          </button>
          <button
            class="b i q sm"
            aria-label={`New chat in ${project.name}`}
            onclick={() => onNewChat(project.id)}
            disabled={project.state !== "ready"}><Icon name="plus" /></button
          >
          <button
            class="b i q sm"
            aria-label={`Remove project ${project.name}`}
            onclick={() => (removing = { kind: "project", id: project.id, name: project.name })}
            ><Icon name="trash" /></button
          >
        </div>
        {#if open}
          <ul role="list">
            {#each project.chats as chat (chat.id)}
              <li>
                <button
                  class="row chatrow"
                  aria-current={chat.id === currentChatId}
                  onclick={() => navigate({ view: "chat", chatId: chat.id })}
                >
                  <span class="title">{chat.title ?? "New chat"}</span>
                  <span class="cmeta">{relative(chat.createdAt)}</span>
                </button>
                <button
                  class="b i q sm"
                  aria-label={`Rename chat ${chat.title ?? "New chat"}`}
                  onclick={() => onRenameChat(chat)}><Icon name="edit" /></button
                >
                <button
                  class="b i q sm"
                  aria-label={`Delete chat ${chat.title ?? "New chat"}`}
                  onclick={() => (removing = { kind: "chat", id: chat.id, name: chat.title ?? "New chat" })}
                  ><Icon name="trash" /></button
                >
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  </nav>
  <div class="foot">
    <button
      class="row"
      aria-current={app.route.view === "settings"}
      onclick={() => navigate({ view: "settings", tab: "general" })}
    >
      <Icon name="gear" />Settings
    </button>
  </div>
</aside>

{#if removing}
  <ConfirmRemoval
    title={`${removing.kind === "chat" ? "Delete chat" : "Remove project"} “${removing.name}”?`}
    description={removing.kind === "chat"
      ? "Stops running work and hides this chat. Its history is retained on the server."
      : "Stops running work and removes the project and its chats from Pal. All files stay on the server, including managed workspaces. This does not delete any folder."}
    confirmLabel={removing.kind === "chat" ? "Delete chat" : "Remove project"}
    onCancel={() => (removing = undefined)}
    onConfirm={remove}
  />
{/if}

<style>
  aside {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg0);
  }
  .close {
    display: flex;
    justify-content: flex-end;
    padding: 8px 8px 0;
  }
  .actions {
    display: flex;
    gap: 6px;
    padding: 12px 12px 8px;
  }
  .grow {
    flex: 1;
  }
  nav {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 8px 8px;
  }
  .none {
    margin: 4px 8px;
    font-size: 13px;
    color: var(--tx3);
  }
  .project {
    margin-bottom: 4px;
  }
  li {
    display: flex;
    align-items: center;
  }
  .chatrow {
    flex: 1;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .name {
    color: var(--tx);
    font-weight: 500;
  }
  .name :global(svg) {
    color: var(--tx3);
  }
  .label,
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    width: 100%;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .foot {
    padding: 8px;
    border-top: 1px solid var(--line);
    padding-bottom: max(8px, env(safe-area-inset-bottom));
  }
</style>
