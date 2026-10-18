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
  /** The step being dragged or keyed to, before the server confirms it. */
  let preview: number | undefined = $state();
  let wanted: Effort | undefined;
  let container: HTMLDivElement | undefined;
  let opener: HTMLButtonElement | undefined;
  let range: HTMLInputElement | undefined = $state();

  const steps = $derived(LEVELS.filter((level) => current?.efforts.includes(level)));
  const index = $derived(Math.max(0, steps.indexOf(effort as (typeof LEVELS)[number])));
  const shown = $derived(steps[preview ?? index] ?? effort);
  const adjustable = $derived(current !== undefined && steps.length > 1);
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
        : adjustable
          ? range
          : container?.querySelector<HTMLElement>(".head");
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
  /** Keyboard and drag changes arrive faster than the server answers; send only the latest, one at a time. */
  async function commit(level: Effort) {
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
      preview = undefined;
      // A refused change snaps back to the chat's actual effort.
      if (range !== undefined) range.value = String(index);
    }
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
    aria-label={`Model and reasoning: ${modelName}, reasoning ${LABELS[effort].toLowerCase()}`}
    title={providerName === undefined ? modelName : `${modelName} · ${providerName}`}
    aria-expanded={open}
    onclick={() => (open ? close(false) : show("effort"))}
  >
    <span class="name">{modelName}</span>{#if current !== undefined && steps.length > 1}<span class="level"
        >{LABELS[effort]}</span
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
          <Icon name="model" />
          <span class="grow">
            <span class="hname">{modelName}</span>
            <span class="hlevel">{LABELS[shown]}</span>
            {#if providerName !== undefined && effective?.provider !== "openai"}<span class="hprov">{providerName}</span
              >{/if}
          </span>
          <Icon name="chevR" />
        </button>
        <div class="slider">
          <div class="track" style:--ratio={adjustable ? (preview ?? index) / (steps.length - 1) : 0}>
            {#if adjustable}
              {#each steps as level, at (level)}<span class="dot" style:--at={at / (steps.length - 1)}></span>{/each}
            {/if}
            <input
              bind:this={range}
              type="range"
              min="0"
              max={Math.max(0, steps.length - 1)}
              step="1"
              value={index}
              disabled={!adjustable}
              aria-label="Reasoning effort"
              aria-valuetext={LABELS[shown]}
              oninput={(event) => (preview = Number(event.currentTarget.value))}
              onchange={(event) => {
                const level = steps[Number(event.currentTarget.value)];
                if (level !== undefined) void commit(level);
              }}
            />
          </div>
          {#if adjustable}
            <!-- The header names the current level; the ends say what the scale runs between. -->
            <div class="ticks" aria-hidden="true">
              {#each [steps[0], steps.at(-1)] as level, end (end)}<span class:on={level === shown}
                  >{level === undefined ? "" : LABELS[level]}</span
                >{/each}
            </div>
          {/if}
        </div>
        <p class="note" role="status">
          {#if current === undefined}
            {connected || effective?.provider !== "openai"
              ? "Choose a model to set its reasoning."
              : "Sign in with ChatGPT to choose a model."}
          {:else if steps.length <= 1}
            This model has no adjustable reasoning.
          {:else if saving || busy}
            Saving…
          {:else}
            Reasoning for this chat. Higher takes longer and uses more of your plan or credits.
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
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 10px;
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
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
  }
  .hname {
    font-size: 15px;
    font-weight: 650;
  }
  .hlevel {
    color: var(--tx2);
  }
  .hprov {
    flex-basis: 100%;
    font-size: 12px;
    color: var(--tx3);
  }
  .slider {
    padding: 10px 10px 4px;
  }
  /* A stepped track: the fill runs to the chosen step's thumb and every step has a dot behind the native input. */
  .track {
    --thumb: 28px;
    position: relative;
    height: 32px;
    border-radius: 16px;
    background:
      linear-gradient(var(--ribbon), var(--ribbon)) 0 0 / calc(var(--thumb) + (100% - var(--thumb)) * var(--ratio)) 100%
        no-repeat,
      var(--bg3);
    transition: background-size var(--mid) var(--ease);
  }
  .dot {
    position: absolute;
    top: 50%;
    left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--at));
    width: 5px;
    height: 5px;
    margin: -2.5px 0 0 -2.5px;
    border-radius: 50%;
    background: var(--tx3);
  }
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    border-radius: 16px;
    background: transparent;
    cursor: pointer;
  }
  input[type="range"]:disabled {
    cursor: not-allowed;
  }
  .track:has(input:disabled) {
    opacity: 0.5;
  }
  input[type="range"]::-moz-range-track {
    background: transparent;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: var(--thumb);
    height: var(--thumb);
    border-radius: 50%;
    background: #fff;
    border: 0;
    box-shadow:
      0 1px 4px rgba(2, 4, 12, 0.5),
      0 0 0 1px var(--line2);
    transition: transform var(--fast) var(--ease);
  }
  input[type="range"]::-moz-range-thumb {
    width: var(--thumb);
    height: var(--thumb);
    border-radius: 50%;
    background: #fff;
    border: 0;
    box-shadow:
      0 1px 4px rgba(2, 4, 12, 0.5),
      0 0 0 1px var(--line2);
  }
  input[type="range"]:active::-webkit-slider-thumb {
    transform: scale(0.92);
  }
  .ticks {
    display: flex;
    justify-content: space-between;
    margin: 6px 2px 0;
    font-size: 11.5px;
    color: var(--tx3);
  }
  .ticks .on {
    color: var(--tx);
    font-weight: 650;
  }
  .note {
    margin: 6px 10px 2px;
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
    color: var(--glint);
  }
</style>
