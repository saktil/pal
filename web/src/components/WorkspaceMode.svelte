<script lang="ts">
  import { tick } from "svelte";
  import type { Workspace, WorkspaceMode } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";

  let {
    workspace,
    onNewChat,
  }: { workspace: Workspace | null | undefined; onNewChat: (mode: WorkspaceMode) => Promise<void> } = $props();
  const labels = { local: "Local", worktree: "Worktree", "read-only": "Read-only" };
  const mode = $derived(workspace?.mode ?? "local");
  const options = [
    { mode: "local", title: "New local chat", detail: "Use the project's source folder, including manual changes." },
    {
      mode: "worktree",
      title: "New worktree chat",
      detail: "Start from committed HEAD in a separate folder. Dirty and untracked source files stay behind.",
    },
    {
      mode: "read-only",
      title: "New read-only chat",
      detail: "Read the source folder without agent file writes or shell. MCP grants and human Terminal are separate.",
    },
  ] as const;
  let open = $state(false);
  let busy = $state(false);
  let container: HTMLDivElement | undefined;
  let opener: HTMLButtonElement | undefined;

  async function toggle() {
    open = !open;
    if (open) {
      await tick();
      container?.querySelector<HTMLButtonElement>(".opt")?.focus();
    }
  }
  async function create(mode: WorkspaceMode) {
    if (busy) return;
    busy = true;
    try {
      await onNewChat(mode);
      open = false;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (!busy && event.target instanceof Node && !container?.contains(event.target)) open = false;
  }}
  onkeydown={(event) => {
    if (open && event.key === "Escape" && !busy) {
      open = false;
      opener?.focus();
    }
  }}
/>

<div class="workspace-mode" bind:this={container}>
  <button
    class="b q"
    bind:this={opener}
    aria-label="Workspace mode"
    aria-expanded={open}
    disabled={busy}
    onclick={toggle}
  >
    <Icon name={mode === "read-only" ? "lock" : "folder"} />{labels[mode]}<Icon name="chevD" />
  </button>
  {#if open}
    <div class="pop" role="dialog" aria-label="Workspace mode">
      <div class="poph">New chat workspace</div>
      <p class="popn">
        This chat stays in {labels[mode]}. Choose a mode to start a new chat; existing runs keep their folders.
      </p>
      {#each options as option (option.mode)}
        <button class="opt" disabled={busy} onclick={() => create(option.mode)}>
          <span>{option.title}</span><span class="optd">{option.detail}</span>
        </button>
      {/each}
      <p class="popn">
        Not a sandbox. Worktree creation runs no hooks, filters, setup scripts or submodule downloads. Files and Git
        registrations are retained when a chat is removed.
      </p>
      <p class="popn">Worktree limits: 8 per project, 10,000 files, 8 MiB per file, 256 MiB total.</p>
      {#if busy}<p class="popn" role="status">Creating the new chat workspace…</p>{/if}
    </div>
  {/if}
</div>

<style>
  .pop {
    bottom: calc(100% + 6px);
    left: 0;
    width: 360px;
    max-width: 100%;
    max-height: min(480px, 65dvh);
  }
</style>
