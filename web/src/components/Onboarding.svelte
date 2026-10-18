<script lang="ts">
  import { onMount } from "svelte";
  import mark from "../assets/pal-mark.png";
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
    <h1><img src={mark} alt="" width="40" height="40" />Welcome to Pal</h1>
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
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 28px;
    font-weight: 750;
    letter-spacing: -0.025em;
    margin: 12px 0 16px;
  }
  ol {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
    padding: 0;
    counter-reset: step;
  }
  li {
    counter-increment: step;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 12px 3px 3px;
    border: 1px solid var(--line2);
    border-radius: 999px;
    color: var(--tx3);
    font-size: 13px;
    font-weight: 550;
  }
  li::before {
    content: counter(step);
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--bg3);
    font-size: 12px;
    font-weight: 700;
  }
  [aria-current="step"] {
    color: var(--tx);
    border-color: var(--acln);
    background: var(--acbg);
  }
  [aria-current="step"]::before {
    background: var(--primary);
    color: var(--on-primary);
  }
</style>
