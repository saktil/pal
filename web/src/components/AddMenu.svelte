<script lang="ts">
  import { tick } from "svelte";
  import Icon from "../lib/Icon.svelte";

  let { onFiles }: { onFiles: (files: File[]) => void } = $props();
  let open = $state(false);
  let container: HTMLDivElement | undefined;
  let opener: HTMLButtonElement | undefined;
  let input: HTMLInputElement | undefined;

  async function show() {
    open = true;
    await tick();
    container?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }
  function close(refocus: boolean) {
    open = false;
    if (refocus) opener?.focus();
  }
  function pick() {
    close(true);
    // Still inside the click, so the browser treats the file chooser as user-initiated.
    input?.click();
  }
  function onOpenerKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      void show();
    }
  }
  function onMenuKey(event: KeyboardEvent) {
    if (event.key === "Tab") close(false);
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      // A single item: movement keys keep focus on it rather than scrolling the page.
      event.preventDefault();
      container?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
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

<div class="add" bind:this={container}>
  <button
    class="b i q plus"
    bind:this={opener}
    aria-label="Add"
    title="Add"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open ? close(false) : show())}
    onkeydown={onOpenerKey}><Icon name="plus" /></button
  >
  <input
    bind:this={input}
    class="sr"
    type="file"
    multiple
    tabindex="-1"
    aria-hidden="true"
    onchange={(event) => {
      const files = [...(event.currentTarget.files ?? [])];
      // Cleared, so choosing the same file again is still a change.
      event.currentTarget.value = "";
      onFiles(files);
    }}
  />
  {#if open}
    <div class="pop" role="menu" aria-label="Add" tabindex="-1" onkeydown={onMenuKey}>
      <button class="opt" role="menuitem" onclick={pick}>
        <span class="row"><Icon name="clip" />Add file from this device</span>
        <span class="optd">Uploads a copy for this chat. It doesn't give Pal access to your folders.</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .add {
    position: relative;
  }
  .plus {
    width: 32px;
    height: 32px;
    margin-left: -6px;
  }
  .plus[aria-expanded="true"] :global(svg) {
    transform: rotate(45deg);
  }
  .plus :global(svg) {
    transition: transform var(--mid) var(--ease);
  }
  .pop {
    bottom: calc(100% + 8px);
    left: -4px;
    width: 300px;
    max-width: calc(100vw - 32px);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    font-weight: 550;
  }
  .optd {
    padding-left: 25px;
  }
</style>
