<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { api, ApiError, type ChatSummary } from "../lib/api.ts";
  import { refreshProjects } from "../lib/state.svelte.ts";

  let { chat, onClose }: { chat: ChatSummary; onClose: () => void } = $props();
  // A newer list response must not silently replace the title the owner is editing.
  const snapshot = untrack(() => ({ id: chat.id, title: chat.title }));
  let draft = $state(snapshot.title ?? "");
  let busy = $state(false);
  let error: string | undefined = $state();
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;

  onMount(() => {
    dialog.showModal();
    input.focus();
    input.select();
  });
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || draft.trim() === "") return;
    busy = true;
    error = undefined;
    try {
      await api.renameChat(snapshot.id, draft, snapshot.title);
      await refreshProjects();
      dialog.close();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      if (failure instanceof ApiError && failure.status === 409) await refreshProjects().catch(() => undefined);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="rename-chat-title"
  onclose={onClose}
  oncancel={(event) => {
    if (busy) event.preventDefault();
  }}
>
  <form onsubmit={save}>
    <h2 id="rename-chat-title">Rename chat</h2>
    <label for="chat-name">Chat name</label>
    <input id="chat-name" class="f" bind:this={input} bind:value={draft} maxlength="200" required disabled={busy} />
    {#if error}<div class="callout er" role="alert">{error}</div>{/if}
    <div class="buttons">
      <button class="b" type="button" disabled={busy} onclick={() => dialog.close()}>Cancel</button>
      <button class="b p" type="submit" disabled={busy || draft.trim() === ""}>{busy ? "Saving…" : "Save name"}</button>
    </div>
  </form>
</dialog>

<style>
  dialog {
    width: 470px;
    max-width: calc(100% - 32px);
    background: var(--bg2);
    color: var(--tx);
    border: 1px solid var(--line2);
    border-radius: 10px;
    padding: 18px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.55);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  label {
    font-size: 13px;
    color: var(--tx2);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
