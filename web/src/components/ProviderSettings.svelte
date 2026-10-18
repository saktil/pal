<script lang="ts">
  import { api, ApiError, type KeyCheck, type ProvidersState } from "../lib/api.ts";
  import { app } from "../lib/state.svelte.ts";

  const providers = $derived(app.providers?.providers ?? []);
  let drafts: Record<string, string> = $state({});
  let checks: Record<string, KeyCheck | undefined> = $state({});
  let busy: string | undefined = $state();
  let error: { id: string; message: string } | undefined = $state();

  async function act(id: string, work: () => Promise<ProvidersState>) {
    busy = id;
    error = undefined;
    checks[id] = undefined;
    try {
      app.providers = await work();
    } catch (failure) {
      error = { id, message: failure instanceof ApiError ? failure.message : String(failure) };
    } finally {
      busy = undefined;
    }
  }
  async function save(id: string) {
    await act(id, () => api.providerKey(id, (drafts[id] ?? "").trim()));
    if (error?.id !== id) drafts[id] = "";
  }
  async function check(id: string) {
    busy = id;
    error = undefined;
    try {
      checks[id] = (await api.providerCheck(id)).check;
    } catch (failure) {
      error = { id, message: failure instanceof ApiError ? failure.message : String(failure) };
    } finally {
      busy = undefined;
    }
  }
</script>

<h3 class="h3">Other model providers</h3>
<p class="setd">
  Optional, with your own API keys. Each stays off until you enable it, and Pal never switches a chat to it or falls
  back to it on its own. Keys are stored encrypted on this server and never shown again.
</p>
{#each providers as provider (provider.id)}
  <div class="fold" role="group" aria-label={provider.name}>
    <div class="line">
      <strong>{provider.name}</strong><span class="pill">API key</span>
      {#if provider.enabled}<span class="pill ok">Enabled</span>
      {:else if provider.hasKey}<span class="pill">Key saved · off</span>
      {:else}<span class="pill wa">Not set up</span>{/if}
    </div>
    <div class="setd">{provider.billing}</div>
    <label class="fl key">
      {provider.hasKey ? "Replace API key" : "API key"}
      <input
        class="f mono"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder={provider.hasKey ? "Saved key hidden" : "Paste your key"}
        bind:value={drafts[provider.id]}
      />
    </label>
    <div class="buttons">
      <button
        class="b"
        disabled={busy !== undefined || (drafts[provider.id] ?? "").trim() === ""}
        onclick={() => save(provider.id)}>Save key</button
      >
      {#if provider.hasKey}
        <button
          class="b q"
          disabled={busy !== undefined}
          onclick={() => act(provider.id, () => api.providerKey(provider.id, null))}>Remove key</button
        >
      {/if}
      {#if provider.hasKey && provider.id === "openrouter"}
        <button class="b q" disabled={busy !== undefined} onclick={() => check(provider.id)}>Check key</button>
      {/if}
      <a class="b q" href={provider.keys} target="_blank" rel="noopener noreferrer">Get a key</a>
    </div>
    <div class="setrow">
      <label for={`provider-${provider.id}`}>
        <div class="setl">Use {provider.name} in chats</div>
        <div class="setd">
          {provider.enabled
            ? `${provider.models.length} models in the chat model picker.`
            : provider.hasKey
              ? "Off. Chats can't send to it."
              : "Save a key first."}
        </div>
      </label>
      <input
        id={`provider-${provider.id}`}
        class="swi"
        type="checkbox"
        role="switch"
        checked={provider.enabled}
        disabled={!provider.hasKey || busy !== undefined}
        onchange={(event) => act(provider.id, () => api.providerEnabled(provider.id, event.currentTarget.checked))}
      />
    </div>
    {#if checks[provider.id] !== undefined}
      <div class="callout" class:ac={checks[provider.id]?.ok} class:wa={!checks[provider.id]?.ok} role="status">
        {checks[provider.id]?.detail}
      </div>
    {/if}
    {#if error?.id === provider.id}<div class="callout er" role="alert">{error.message}</div>{/if}
  </div>
{/each}

<style>
  /* Shared fields grow in rows; in this column card they keep their natural height. */
  .key {
    flex: 0 0 auto;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .buttons {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  a.b {
    text-decoration: none;
  }
</style>
