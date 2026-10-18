<script lang="ts">
  import { api, ApiError, type ChatGPTState } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import { app, navigate, refreshChatGPT, saveSetting, type SettingsTab, viewport } from "../lib/state.svelte.ts";
  import McpSettings from "./McpSettings.svelte";
  import ProviderSettings from "./ProviderSettings.svelte";
  import WorkspaceCleanup from "./WorkspaceCleanup.svelte";
  import ExtensionSettings from "./ExtensionSettings.svelte";

  let { tab, onSignOut, embedded = false }: { tab: SettingsTab; onSignOut: () => void; embedded?: boolean } = $props();

  let paste = $state("");
  let busy = $state(false);
  let error: string | undefined = $state();
  const narrow = $derived(viewport() === "phone");
  const chatgpt = $derived(app.chatgpt);
  const attempt = $derived(chatgpt?.attempt);
  const waiting = $derived(attempt?.state === "waiting" || attempt?.state === "verifying");

  const failures: Record<string, string> = {
    denied: "Sign-in was declined in ChatGPT.",
    plan_not_enabled:
      "ChatGPT plan use wasn't granted to Pal, so it can't send messages with your subscription. Sign in again and allow plan use.",
    account_changed:
      "ChatGPT signed in a different account than this connection's. Sign in with the same account, or forget this connection first.",
    reauthorize: "That sign-in can't be used anymore. Start again.",
    invalid_response: "ChatGPT's answer couldn't be verified, so nothing was saved.",
    port_in_use: "Port 1455 on the server is in use, probably by another sign-in. Finish or cancel it, then try again.",
  };

  $effect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refreshChatGPT(), 1000);
    return () => clearInterval(timer);
  });

  async function act(work: () => Promise<ChatGPTState>) {
    busy = true;
    error = undefined;
    try {
      app.chatgpt = await work();
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }

  const tabs = [
    { id: "general", label: "General", icon: "gear" },
    { id: "models", label: "Models", icon: "model" },
    { id: "mcp", label: "MCP servers", icon: "plug" },
    { id: "extensions", label: "Extensions", icon: "model" },
  ] as const;
</script>

<div class="settings" class:narrow>
  {#if !embedded}
    <nav aria-label="Settings sections">
      <div class="title">
        <button class="b i q" aria-label="Back to chat" onclick={() => history.back()}><Icon name="chevL" /></button>
        <h1>Settings</h1>
      </div>
      {#each tabs as item (item.id)}
        <button class="row" aria-current={tab === item.id} onclick={() => navigate({ view: "settings", tab: item.id })}>
          <Icon name={item.icon} />{item.label}
        </button>
      {/each}
    </nav>
  {/if}
  <div class="content">
    <div class="column">
      {#if tab === "general"}
        <h2 class="h2">General</h2>
        <div>
          <div class="setrow">
            <label for="send-enter">
              <div class="setl">Send with Enter</div>
              <div class="setd">Shift+Enter adds a line. On phones, use the Send button.</div>
            </label>
            <input
              id="send-enter"
              class="swi"
              type="checkbox"
              role="switch"
              checked={app.sendWithEnter}
              onchange={(event) => {
                app.sendWithEnter = event.currentTarget.checked;
                saveSetting("pal.sendWithEnter", String(app.sendWithEnter));
              }}
            />
          </div>
          <div class="setrow">
            <div>
              <div class="setl">Theme</div>
              <div class="setd">Dark. A light theme isn't designed yet.</div>
            </div>
          </div>
          <div class="setrow">
            <div>
              <div class="setl">Owner session</div>
              <div class="setd">Signs this browser out of Pal. ChatGPT stays connected.</div>
            </div>
            <button class="b" onclick={onSignOut}>Sign out of Pal</button>
          </div>
        </div>
        <WorkspaceCleanup />
      {:else if tab === "extensions"}
        <ExtensionSettings />
      {:else if tab === "mcp"}
        <McpSettings />
      {:else}
        <h2 class="h2">Models</h2>
        <p class="sub">
          Pal starts with your ChatGPT subscription. Other providers are optional and use your own keys; Pal never falls
          back from one provider to another.
        </p>
        <h3 class="h3">Provider connection</h3>
        <div class="fold">
          <div class="line">
            <strong>ChatGPT</strong><span class="pill">Subscription sign-in</span>
            {#if chatgpt?.account}<span class="pill ok">Connected</span>
            {:else if waiting}<span class="pill ac">Signing in</span>
            {:else}<span class="pill wa">Not signed in</span>{/if}
          </div>
          {#if chatgpt?.account}
            <div class="setd">
              Signed in as <span class="mono">{chatgpt.account.email ?? chatgpt.account.accountId}</span>. Usage counts
              against that account's ChatGPT limits.
            </div>
            <div>
              <button class="b sm" onclick={() => act(api.chatgptSignOut)} disabled={busy}>Sign out of ChatGPT</button>
            </div>
          {:else if attempt?.state === "waiting"}
            <div class="callout ac">
              <strong>Continue in your browser.</strong> Sign in to ChatGPT and allow Pal to use your plan.
            </div>
            {#if attempt.authUrl}
              <div>
                <a class="b p" href={attempt.authUrl} target="_blank" rel="noopener noreferrer"
                  ><Icon name="globe" />Open ChatGPT sign-in</a
                >
              </div>
            {/if}
            <label class="fl">
              If the browser ends on a page that won't load (for example on a phone), paste its address here:
              <input
                class="f mono"
                bind:value={paste}
                placeholder="http://127.0.0.1:1455/auth/callback?…"
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <div class="buttons">
              <button
                class="b"
                onclick={() => act(() => api.chatgptPaste(paste.trim()))}
                disabled={busy || paste.trim() === ""}>Submit address</button
              >
              <button class="b q" onclick={() => act(api.chatgptCancel)} disabled={busy}>Cancel</button>
            </div>
          {:else if attempt?.state === "verifying"}
            <div class="status"><span class="ring spin" aria-hidden="true"></span>Verifying your ChatGPT account…</div>
          {:else}
            {#if attempt?.state === "failed" && attempt.error}
              <div class="callout er" role="alert">{failures[attempt.error.code] ?? attempt.error.message}</div>
            {/if}
            <div class="setd">
              Sign-in opens ChatGPT in your browser. Pal stores the tokens encrypted on this server; they never reach
              this page.
            </div>
            <div>
              <button class="b p" onclick={() => act(api.chatgptSignIn)} disabled={busy}>Sign in with ChatGPT</button>
            </div>
          {/if}
          {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
        </div>

        {#if chatgpt?.account}
          <h3 class="h3">Default model for new chats</h3>
          {#if chatgpt.default !== null && chatgpt.default.provider !== "openai"}
            <p class="setd">
              New chats start with <span class="mono">{chatgpt.default.modelId}</span> on
              {app.providers?.providers.find((entry) => entry.id === chatgpt.default?.provider)?.name ??
                chatgpt.default.provider}. Choose a ChatGPT model here, or another model with “Use for new chats” in a
              chat's model picker.
            </p>
          {/if}
          {#if chatgpt.modelsError}
            <div class="callout er" role="alert">Couldn't list your models: {chatgpt.modelsError}</div>
          {/if}
          <div role="radiogroup" aria-label="Default model">
            {#each chatgpt.models as model (model.slug)}
              <label class="setrow model" class:off={!model.supported}>
                <span>
                  <span class="setl">{model.displayName}</span>
                  <span class="setd mono"
                    >{model.slug}{model.supported ? "" : " · Pal doesn't know this model's capabilities yet"}</span
                  >
                </span>
                <input
                  type="radio"
                  name="default-model"
                  checked={chatgpt.default?.provider === "openai" && chatgpt.default.modelId === model.slug}
                  disabled={!model.supported || busy}
                  onchange={() => act(() => api.setDefaultModel(model.slug))}
                />
              </label>
            {/each}
          </div>
        {/if}
        <ProviderSettings />
      {/if}
    </div>
  </div>
</div>

<style>
  .settings {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  nav {
    flex: 0 0 auto;
    width: 220px;
    border-right: 1px solid var(--line);
    padding: 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .narrow {
    flex-direction: column;
  }
  .narrow nav {
    width: auto;
    border-right: 0;
    border-bottom: 1px solid var(--line);
    flex-direction: row;
    overflow-x: auto;
    align-items: center;
  }
  .narrow nav .row {
    width: auto;
    flex: 0 0 auto;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 8px;
    flex: 0 0 auto;
  }
  .narrow .title {
    padding-bottom: 2px;
  }
  h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .content {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: 24px 20px 48px;
  }
  .narrow .content {
    padding: 24px 12px 48px;
  }
  .column {
    max-width: 760px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
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
  .status {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    color: var(--tx2);
  }
  a.b {
    text-decoration: none;
  }
  .model {
    cursor: pointer;
  }
  .model > span {
    display: flex;
    flex-direction: column;
  }
  .off {
    opacity: 0.55;
    cursor: default;
  }
</style>
