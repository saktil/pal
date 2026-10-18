<script lang="ts">
  import { tick } from "svelte";
  import type { CommandMode } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";

  let { mode, onChoose }: { mode: CommandMode | undefined; onChoose: (mode: CommandMode) => Promise<void> } = $props();
  const options = [
    {
      mode: "ask",
      icon: "lock",
      title: "Ask for approval",
      detail: "Each agent shell command waits until you approve it, with its folder and timeout shown.",
    },
    {
      mode: "full",
      icon: "warn",
      title: "Full access (YOLO)",
      detail:
        "Agent shell commands run without asking, as the Pal host user. Not a sandbox; grants, protections and limits still apply.",
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
      container?.querySelector<HTMLButtonElement>('.opt[aria-checked="true"], .opt')?.focus();
    }
  }
  async function choose(next: CommandMode) {
    if (busy) return;
    busy = true;
    try {
      if (next !== mode) await onChoose(next);
      open = false;
      opener?.focus();
    } finally {
      busy = false;
    }
  }
  function move(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = [...(container?.querySelectorAll<HTMLButtonElement>(".opt") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(at + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
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

<div class="command-mode" bind:this={container}>
  <button
    class="b q"
    class:warn={mode === "full"}
    bind:this={opener}
    aria-label={`Command approval: ${mode === "full" ? "Full access" : "Ask for approval"}`}
    aria-expanded={open}
    disabled={mode === undefined || busy}
    onclick={toggle}
  >
    <Icon name={mode === "full" ? "warn" : "lock"} />{mode === "full" ? "Full access" : "Ask"}<Icon name="chevD" />
  </button>
  {#if open}
    <div class="pop" role="dialog" aria-label="Command approval">
      <div class="poph">How should Pal actions be approved?</div>
      <div role="radiogroup" aria-label="Command approval mode" tabindex="-1" onkeydown={move}>
        {#each options as option (option.mode)}
          <button
            class="opt"
            class:warn={option.mode === "full"}
            role="radio"
            aria-checked={mode === option.mode}
            disabled={busy}
            onclick={() => choose(option.mode)}
          >
            <span class="row"
              ><Icon name={option.icon} /><span class="grow">{option.title}</span>{#if mode === option.mode}<Icon
                  name="check"
                />{/if}</span
            >
            <span class="optd">{option.detail}</span>
          </button>
        {/each}
      </div>
      <p class="popn">
        Applies to this chat. Requests already waiting still need your answer. Human Terminal is separate.
      </p>
    </div>
  {/if}
</div>

<style>
  .pop {
    bottom: calc(100% + 6px);
    left: 0;
    width: 360px;
    max-width: 100%;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .b.warn,
  .opt.warn {
    color: var(--wa);
  }
  .opt.warn .optd {
    color: var(--wa);
    opacity: 0.85;
  }
</style>
