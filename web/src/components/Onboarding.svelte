<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import { app } from "../lib/state.svelte.ts";
  import McpSettings from "./McpSettings.svelte";
  import Settings from "./Settings.svelte";
  import WorkspaceCleanup from "./WorkspaceCleanup.svelte";

  let { onCreateProject, onSignOut }: { onCreateProject: () => void; onSignOut: () => void } = $props();
  let reviewed: boolean | undefined = $state();
  let error: string | undefined = $state();
  const step = $derived(app.chatgpt?.account == null ? 1 : reviewed ? 3 : 2);

  async function load() {
    error = undefined;
    try {
      reviewed = !(await api.mcp()).review;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  onMount(() => void load());
</script>

<section aria-label="Set up Pal">
  <div class="intro">
    <h1>Welcome to Pal</h1>
    <ol aria-label="Setup steps">
      <li aria-current={step === 1 ? "step" : undefined}>ChatGPT</li>
      <li aria-current={step === 2 ? "step" : undefined}>Internet tools</li>
      <li aria-current={step === 3 ? "step" : undefined}>First project</li>
    </ol>
  </div>
  {#if step === 1}
    <Settings tab="models" {onSignOut} embedded />
  {:else}
    <div class="content">
      {#if error !== undefined}
        <div class="callout er" role="alert">Couldn't load setup: {error}</div>
        <button class="b" onclick={load}>Try again</button>
      {:else if reviewed === undefined}
        <p role="status">Loading internet tools…</p>
      {:else if step === 2}
        <McpSettings onReviewed={() => (reviewed = true)} />
      {:else}
        <h2 class="h2">Create your first project</h2>
        <p class="sub">Give Pal a managed workspace or choose an existing folder on this server.</p>
        <button class="b p" onclick={onCreateProject}><Icon name="folderPlus" />Create project</button>
        <WorkspaceCleanup />
      {/if}
    </div>
  {/if}
</section>

<style>
  section {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: auto;
    background: var(--bg1);
  }
  .intro,
  .content {
    width: 100%;
    max-width: 800px;
    margin: 0 auto;
    padding: 24px 20px;
  }
  h1 {
    font-size: 22px;
    font-weight: 500;
    margin: 0 0 16px;
  }
  ol {
    display: flex;
    gap: 24px;
    padding-left: 20px;
    color: var(--tx3);
    font-size: 12px;
  }
  [aria-current="step"] {
    color: var(--ac);
  }
</style>
