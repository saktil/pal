<script lang="ts" module>
  import type { Effort } from "../lib/api.ts";

  export type Choice = { provider: string; id: string; name: string; efforts: readonly Effort[] };
  export type Group = { provider: string; name: string; billing: string; choices: Choice[] };
  /** Pi's thinking levels in order; a model's steps are the ones it supports. */
  const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  export const LABELS: Record<Effort, string> = {
    off: "Off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  };
</script>

<script lang="ts">
  import { tick } from "svelte";
  import Icon from "../lib/Icon.svelte";

  let {
    groups,
    effective,
    current,
    effort,
    busy,
    connected,
    isDefault,
    usable,
    compact,
    onModel,
    onEffort,
    onDefault,
  }: {
    groups: Group[];
    effective: { provider: string; modelId: string } | null;
    current: Choice | undefined;
    effort: Effort;
    busy: boolean;
    connected: boolean;
    isDefault: boolean;
    usable: boolean;
    compact: boolean;
    onModel: (choice: Choice) => Promise<void>;
    onEffort: (level: Effort) => Promise<void>;
    onDefault: () => Promise<void>;
  } = $props();

  const SHOWN_PER_PROVIDER = 50;
  let open = $state(false);
  let view: "effort" | "models" = $state("effort");
  let query = $state("");
  let saving = $state(false);
  /** The level just chosen, shown checked before the server confirms it. */
  let chosen: Effort | undefined = $state();
  let wanted: Effort | undefined;
  let container: HTMLDivElement | undefined;
  let opener: HTMLButtonElement | undefined;

  const steps = $derived(LEVELS.filter((level) => current?.efforts.includes(level)));
  const shown = $derived(chosen ?? effort);
  const adjustable = $derived(current !== undefined && steps.length > 1);
  /** "Off" beside a model name reads as if the model were off. */
  const levelName = (level: Effort) => (level === "off" ? "Reasoning off" : LABELS[level]);
  const modelName = $derived(current?.name ?? effective?.modelId ?? "Choose model");
  const providerName = $derived(groups.find((group) => group.provider === effective?.provider)?.name);
  const searchable = $derived(groups.reduce((total, group) => total + group.choices.length, 0) > 12);
  const matching = $derived.by(() => {
    const words = query.trim().toLowerCase();
    if (words === "") return groups;
    return groups.map((group) => ({
      ...group,
      choices: group.choices.filter((choice) => `${choice.name} ${choice.id}`.toLowerCase().includes(words)),
    }));
  });

  async function show(next: "effort" | "models") {
    open = true;
    view = next;
    await tick();
    const target =
      next === "models"
        ? container?.querySelector<HTMLElement>(
            'input[type="search"], [role="radio"][aria-checked="true"], [role="radio"]',
          )
        : (container?.querySelector<HTMLElement>('.levels [aria-checked="true"]') ??
          container?.querySelector<HTMLElement>(".head"));
    target?.focus();
  }
  function close(refocus: boolean) {
    open = false;
    query = "";
    if (refocus) opener?.focus();
  }
  async function choose(choice: Choice) {
    close(true);
    await onModel(choice);
  }
  /** Arrow keys move faster than the server answers; send only the latest level, one at a time. */
  async function commit(level: Effort) {
    chosen = level;
    wanted = level;
    if (saving) return;
    saving = true;
    try {
      while (wanted !== undefined && wanted !== effort) {
        const next = wanted;
        wanted = undefined;
        await onEffort(next);
      }
    } finally {
      wanted = undefined;
      saving = false;
      // A refused change falls back to the chat's actual effort.
      chosen = undefined;
    }
  }
  /** Radio-group keys: arrows step through the model's levels and choose as they go. */
  function stepKey(event: KeyboardEvent) {
    const at = steps.indexOf(shown as (typeof LEVELS)[number]);
    const last = steps.length - 1;
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? Math.min(last, at + 1)
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? Math.max(0, at - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined;
    const level = next === undefined ? undefined : steps[next];
    if (level === undefined) return;
    event.preventDefault();
    void commit(level);
    void tick().then(() => container?.querySelector<HTMLElement>('.levels [aria-checked="true"]')?.focus());
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (open && event.target instanceof Node && !container?.contains(event.target)) close(false);
  }}
  onkeydown={(event) => {
    if (open && event.key === "Escape") close(true);
  }}
/>

<div class="model" class:compact bind:this={container}>
  <button
    class="b q trigger"
    bind:this={opener}
    aria-label={`Model and reasoning: ${modelName}, ${levelName(effort).toLowerCase()}`}
    title={providerName === undefined ? modelName : `${modelName} · ${providerName}`}
    aria-expanded={open}
    onclick={() => (open ? close(false) : show("effort"))}
  >
    <span class="name">{modelName}</span>{#if current !== undefined && steps.length > 1}<span class="level"
        >{levelName(effort)}</span
      >{/if}<Icon name="chevD" />
  </button>
  {#if open}
    <div
      class="pop"
      class:wide={view === "models"}
      role="dialog"
      aria-label={view === "models" ? "Choose model" : "Model and reasoning"}
    >
      {#if view === "effort"}
        <button class="head" aria-label={`Choose model (${modelName})`} onclick={() => show("models")}>
          <span class="grow">
            <span class="hname">{modelName}</span>
            {#if providerName !== undefined && effective?.provider !== "openai"}<span class="hprov">{providerName}</span
              >{/if}
          </span>
          <span class="change">Change</span>
          <Icon name="chevR" />
        </button>
        {#if adjustable}
          <div class="lbl">Reasoning</div>
          <div class="levels" role="radiogroup" aria-label="Reasoning effort" tabindex="-1" onkeydown={stepKey}>
            {#each steps as level, at (level)}
              {@const on = level === shown}
              <button
                class="level-row"
                role="radio"
                aria-checked={on}
                tabindex={on ? 0 : -1}
                disabled={busy && !saving}
                onclick={() => commit(level)}
              >
                <span class="meter" aria-hidden="true">
                  {#each [0, 1, 2, 3] as bar (bar)}<span class:lit={bar < Math.round((at / (steps.length - 1)) * 4)}
                    ></span>{/each}
                </span>
                <span class="grow">{LABELS[level]}</span>
                {#if on}<Icon name="check" />{/if}
              </button>
            {/each}
          </div>
        {/if}
        <p class="note" role="status">
          {#if current === undefined}
            {connected || effective?.provider !== "openai"
              ? "Choose a model to set its reasoning."
              : "Sign in with ChatGPT to choose a model."}
          {:else if steps.length <= 1}
            This model has no adjustable reasoning.
          {:else if saving}
            Saving…
          {:else}
            Higher levels think longer and use more of your plan or credits.
          {/if}
        </p>
        <div class="defaults">
          {#if isDefault}<span class="optd">New chats start with this model.</span>
          {:else}<button class="b sm" disabled={effective === null || !usable} onclick={onDefault}
              >Use for new chats</button
            >{/if}
        </div>
      {:else}
        <div class="listhead">
          <button class="b i q sm" aria-label="Back to reasoning" onclick={() => show("effort")}
            ><Icon name="chevL" /></button
          >
          <span>Choose model</span>
        </div>
        {#if searchable}
          <input
            class="f search"
            type="search"
            placeholder="Search models"
            aria-label="Search models"
            bind:value={query}
          />
        {/if}
        <div class="models">
          {#each matching as group (group.provider)}
            <div class="grouph"><span>{group.name}</span><span class="optd">{group.billing}</span></div>
            {#if group.provider === "openai" && !connected}
              <p class="popn">Sign in with ChatGPT to list your models.</p>
            {:else if effective !== null && group.provider !== effective.provider}
              <p class="popn">Choosing one sends this chat's history to {group.name} with your next message.</p>
            {/if}
            <div role="radiogroup" aria-label={`${group.name} models`}>
              {#each group.choices.slice(0, SHOWN_PER_PROVIDER) as choice (choice.id)}
                {@const chosen = choice.provider === effective?.provider && choice.id === effective.modelId}
                <button class="opt" role="radio" aria-checked={chosen} disabled={busy} onclick={() => choose(choice)}>
                  <span>{choice.name}</span>
                  <span class="mono optd">{choice.id}</span>
                  {#if chosen}<Icon name="check" />{/if}
                </button>
              {/each}
            </div>
            {#if group.choices.length > SHOWN_PER_PROVIDER}
              <p class="popn">Showing {SHOWN_PER_PROVIDER} of {group.choices.length}. Search to find others.</p>
            {:else if group.choices.length === 0 && query.trim() !== ""}
              <p class="popn">No {group.name} model matches.</p>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .model {
    position: relative;
    min-width: 0;
  }
  .trigger {
    max-width: 100%;
    gap: 6px;
    color: var(--tx);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .level {
    color: var(--tx3);
    font-weight: 500;
  }
  .compact .trigger {
    max-width: 150px;
  }
  .compact .level {
    display: none;
  }
  .pop {
    bottom: calc(100% + 8px);
    right: -4px;
    width: 320px;
    max-width: calc(100vw - 32px);
    padding: 8px;
    --origin: bottom right;
    max-height: min(520px, 70dvh);
  }
  .pop.wide {
    width: 420px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--tx);
    text-align: left;
    transition: background-color var(--fast) var(--ease);
  }
  .head:hover {
    background: var(--bg3);
  }
  .head :global(svg) {
    color: var(--tx3);
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .hname {
    font-size: 14px;
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hprov {
    font-size: 12px;
    color: var(--tx3);
  }
  .change {
    font-size: 12.5px;
    color: var(--tx3);
  }
  .lbl {
    padding: 10px 10px 4px;
    border-top: 1px solid var(--line);
    margin-top: 6px;
  }
  .levels {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .levels:focus {
    outline: none;
  }
  .level-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--tx2);
    font-size: 13.5px;
    text-align: left;
    transition:
      background-color var(--fast) var(--ease),
      color var(--fast) var(--ease);
  }
  @media (pointer: coarse) {
    .level-row {
      min-height: 44px;
    }
  }
  .level-row:hover:not(:disabled) {
    background: var(--bg3);
    color: var(--tx);
  }
  .level-row[aria-checked="true"] {
    background: var(--acbg);
    color: var(--tx);
    font-weight: 600;
  }
  .level-row :global(svg) {
    color: var(--tx);
  }
  /* Four small bars show where a level sits on the model's scale; color stays neutral. */
  .meter {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    height: 12px;
  }
  .meter span {
    width: 3px;
    border-radius: 1px;
    background: var(--line3);
  }
  .meter span:nth-child(1) {
    height: 4px;
  }
  .meter span:nth-child(2) {
    height: 6px;
  }
  .meter span:nth-child(3) {
    height: 9px;
  }
  .meter span:nth-child(4) {
    height: 12px;
  }
  .meter .lit {
    background: var(--tx);
  }
  .note {
    margin: 8px 10px 2px;
    font-size: 12.5px;
    color: var(--tx3);
  }
  .defaults {
    margin-top: 8px;
    padding: 8px 10px 2px;
    border-top: 1px solid var(--line);
  }
  .listhead {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px 6px;
    font-weight: 650;
  }
  .search {
    margin: 0 4px 6px;
    width: calc(100% - 8px);
  }
  .models {
    max-height: min(320px, 45dvh);
    overflow-y: auto;
  }
  .grouph {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 10px 2px;
    font-size: 12.5px;
    font-weight: 650;
    color: var(--tx2);
  }
  .grouph .optd {
    font-weight: 400;
  }
  .opt {
    flex-direction: row;
    align-items: baseline;
    gap: 8px;
  }
  .opt .mono {
    margin-left: auto;
  }
  .opt :global(svg) {
    align-self: center;
    color: var(--tx);
  }
</style>
