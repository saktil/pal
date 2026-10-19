<script lang="ts">
  import { onMount, tick } from "svelte";
  import { api, ApiError } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import PalMark from "../lib/PalMark.svelte";
  import {
    app,
    defaultReady,
    providerReady,
    refreshChatGPT,
    refreshProviders,
    savedDefault,
  } from "../lib/state.svelte.ts";
  import ChatGPTConnection from "./ChatGPTConnection.svelte";
  import DefaultModel from "./DefaultModel.svelte";
  import McpSettings from "./McpSettings.svelte";
  import ProviderConnection from "./ProviderConnection.svelte";
  import WorkspaceCleanup from "./WorkspaceCleanup.svelte";

  let { onCreateProject }: { onCreateProject: () => void } = $props();
  type Step = "choose" | "connect" | "model" | "internet" | "project";
  /** Starts from what is saved, so a reload or restart resumes; undefined while loading. */
  let step: Step | undefined = $state();
  let reviewed: boolean | undefined = $state();
  let chosen: string | undefined = $state();
  let busy = $state(false);
  let error: string | undefined = $state();
  let failure: string | undefined = $state();
  let content: HTMLDivElement | undefined = $state();

  const STEPS = ["Provider", "Model", "Internet tools", "First project"];
  const at = $derived({ choose: 0, connect: 0, model: 1, internet: 2, project: 3 }[step ?? "choose"]);
  const options = $derived([
    {
      id: "openai",
      name: "ChatGPT",
      method: "Subscription sign-in",
      billing: "Counts against your ChatGPT plan's usage limits.",
      status: app.chatgpt?.account != null ? "Connected" : undefined,
    },
    ...(app.providers?.providers ?? []).map((provider) => ({
      id: provider.id,
      name: provider.id === "compatible" ? "OpenAI-compatible endpoint" : provider.name,
      method: provider.id === "compatible" ? "Custom endpoint" : "API key",
      billing: provider.billing,
      status: provider.enabled ? "Enabled" : providerReady(provider) ? "Ready · off" : undefined,
    })),
  ]);
  const option = $derived(options.find((entry) => entry.id === chosen));
  const view = $derived(app.providers?.providers.find((entry) => entry.id === chosen));
  const connected = $derived(
    chosen === "openai" ? app.chatgpt?.account != null : view !== undefined && providerReady(view),
  );
  const modelChosen = $derived(defaultReady() && savedDefault()?.provider === chosen);

  async function load() {
    error = undefined;
    try {
      const [mcp] = await Promise.all([
        api.mcp(),
        app.providers === undefined ? refreshProviders() : undefined,
        app.chatgpt === undefined ? refreshChatGPT() : undefined,
      ]);
      reviewed = !mcp.review;
      chosen = savedDefault()?.provider;
      step = !defaultReady() ? "choose" : reviewed ? "project" : "internet";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  onMount(() => void load());

  /** Moves to a step and puts keyboard focus on its heading. */
  async function go(next: Step) {
    failure = undefined;
    step = next;
    await tick();
    const heading = content?.querySelector("h2");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus();
  }

  /** Continuing with an API-key provider is the owner's choice to use it, so it is enabled here. */
  async function connect() {
    if (view !== undefined && !view.enabled) {
      busy = true;
      failure = undefined;
      try {
        app.providers = await api.providerEnabled(view.id, true);
      } catch (cause) {
        failure = cause instanceof ApiError ? cause.message : String(cause);
        return;
      } finally {
        busy = false;
      }
    }
    await go("model");
  }
</script>

<section aria-label="Set up Pal">
  <div class="intro">
    <h1><PalMark size={22} cutout="var(--bg1)" />Welcome to Pal</h1>
    <ol aria-label="Setup steps">
      {#each STEPS as label, index (label)}
        <li aria-current={index === at ? "step" : undefined}>{label}</li>
      {/each}
    </ol>
  </div>
  <div class="content" bind:this={content}>
    {#if error !== undefined}
      <div class="callout er" role="alert">Couldn't load setup: {error}</div>
      <div><button class="b" onclick={load}>Try again</button></div>
    {:else if step === undefined}
      <p role="status">Loading setup…</p>
    {:else if step === "choose"}
      <hgroup>
        <h2 class="h2">Connect a model provider</h2>
        <p class="sub">Choose the provider you want to use with Pal.</p>
      </hgroup>
      <div class="choices" role="radiogroup" aria-label="Model provider">
        {#each options as entry (entry.id)}
          <label class="choice">
            <input type="radio" name="provider" value={entry.id} bind:group={chosen} />
            <span class="what">
              <span class="line">
                <strong>{entry.name}</strong><span class="pill">{entry.method}</span>
                {#if entry.status !== undefined}<span class="pill" class:ok={entry.status !== "Ready · off"}
                    >{entry.status}</span
                  >{/if}
              </span>
              <span class="setd">{entry.billing}</span>
            </span>
          </label>
        {/each}
      </div>
      <div class="nav">
        <button class="b p" disabled={option === undefined} onclick={() => go("connect")}>Continue</button>
      </div>
    {:else if step === "connect" && option !== undefined}
      <hgroup>
        <h2 class="h2">Connect {option.name}</h2>
        <p class="sub">
          {#if chosen === "openai"}
            Sign in with your ChatGPT account in your browser. Pal never sees your ChatGPT password.
          {:else if chosen === "compatible"}
            Describe a server that speaks OpenAI's chat completions API, such as a model server on your network.
          {:else}
            Paste an API key from {option.name}. Pal stores it encrypted on this server and never shows it again.
          {/if}
        </p>
      </hgroup>
      {#if chosen === "openai"}
        <ChatGPTConnection />
      {:else if view !== undefined}
        <ProviderConnection provider={view} switchable={false} />
        {#if !view.enabled}<p class="setd">Continue turns on {view.name} for chats.</p>{/if}
      {/if}
      {#if failure !== undefined}<div class="callout er" role="alert">{failure}</div>{/if}
      <div class="nav">
        <button class="b q" onclick={() => go("choose")}><Icon name="chevL" />Back</button>
        <button class="b p" disabled={!connected || busy} onclick={connect}>Continue</button>
      </div>
    {:else if step === "model" && option !== undefined && chosen !== undefined}
      <hgroup>
        <h2 class="h2">Choose a model</h2>
        <p class="sub">
          New chats start with the model you choose from {view?.name ?? option.name}. You can switch models in any chat.
        </p>
      </hgroup>
      <DefaultModel provider={chosen} />
      <div class="nav">
        <button class="b q" onclick={() => go("connect")}><Icon name="chevL" />Back</button>
        <button class="b p" disabled={!modelChosen} onclick={() => go(reviewed ? "project" : "internet")}
          >Continue</button
        >
      </div>
    {:else if step === "internet"}
      <McpSettings
        onReviewed={() => {
          reviewed = true;
          void go("project");
        }}
      />
    {:else if step === "project"}
      <hgroup>
        <h2 class="h2">Create your first project</h2>
        <p class="sub">Give Pal a managed workspace or choose an existing folder on this server.</p>
      </hgroup>
      <div><button class="b p" onclick={onCreateProject}><Icon name="folderPlus" />Create project</button></div>
      <WorkspaceCleanup />
    {/if}
  </div>
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
  .content {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-top: 0;
    padding-bottom: 48px;
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
  .content :global(h2:focus) {
    outline: none;
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
  hgroup {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
  }
  .choices {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .choice {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    cursor: pointer;
    transition:
      border-color var(--fast) var(--ease),
      background-color var(--fast) var(--ease);
  }
  .choice:hover {
    border-color: var(--line2);
  }
  .choice:has(:checked) {
    border-color: var(--acln);
    background: var(--acbg);
  }
  .choice input {
    flex: 0 0 auto;
    margin-top: 2px;
  }
  .what {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .nav {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>
