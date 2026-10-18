<script lang="ts">
  import { onMount } from "svelte";

  let {
    title,
    description,
    detail,
    confirmLabel,
    busyLabel = "Removing…",
    onCancel,
    onConfirm,
  }: {
    title: string;
    description: string;
    /** A path or identifier shown exactly, in monospace. */
    detail?: string;
    confirmLabel: string;
    busyLabel?: string;
    onCancel: () => void;
    onConfirm: () => Promise<void>;
  } = $props();
  let dialog: HTMLDialogElement;
  let cancel: HTMLButtonElement;
  let busy = $state(false);
  let error: string | undefined = $state();

  onMount(() => {
    dialog.showModal();
    cancel.focus();
  });

  async function confirm() {
    busy = true;
    error = undefined;
    try {
      await onConfirm();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  role="alertdialog"
  aria-labelledby="remove-title"
  aria-describedby="remove-description"
  oncancel={(event) => {
    event.preventDefault();
    if (!busy) onCancel();
  }}
>
  <h2 id="remove-title">{title}</h2>
  <p id="remove-description">{description}</p>
  {#if detail !== undefined}<p class="mono detail">{detail}</p>{/if}
  {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
  <div class="buttons">
    <button bind:this={cancel} class="b" disabled={busy} onclick={onCancel}>Cancel</button>
    <button class="b dz" disabled={busy} onclick={confirm}>{busy ? busyLabel : confirmLabel}</button>
  </div>
</dialog>

<style>
  dialog {
    width: 470px;
    max-width: calc(100% - 32px);
    max-height: calc(100dvh - 32px);
    overflow: auto;
    background: var(--bg2);
    color: var(--tx);
    border: 1px solid var(--line2);
    border-radius: 10px;
    padding: 18px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.55);
  }
  h2 {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
  }
  p {
    margin: 0 0 12px;
    color: var(--tx2);
    font-size: 13px;
  }
  .detail {
    color: var(--tx);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>
