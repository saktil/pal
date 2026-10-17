<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type McpServer, type McpState } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";

  let { onReviewed }: { onReviewed?: () => void } = $props();

  let review = $state(false);
  let servers: McpServer[] = $state([]);
  let loaded = $state(false);
  let open: Record<string, boolean> = $state({});
  let keys: Record<string, string> = $state({});
  let choices: Record<string, string[]> = $state({});
  let busy: Record<string, boolean> = $state({});
  let confirmRemove: string | undefined = $state();
  let error: string | undefined = $state();
  let adding = $state(false);
  let draft = $state({
    name: "",
    url: "",
    auth: "none" as "none" | "header" | "bearer",
    header: "x-api-key",
    key: "",
    private: false,
  });

  const STATES: Record<McpState, { label: string; cls: string }> = {
    disabled: { label: "Disabled", cls: "" },
    idle: { label: "Enabled · idle", cls: "ok" },
    connecting: { label: "Connecting", cls: "ac" },
    ready: { label: "Ready", cls: "ok" },
    key_required: { label: "Key required", cls: "wa" },
    rate_limited: { label: "Rate-limited", cls: "wa" },
    unreachable: { label: "Unreachable", cls: "er" },
    blocked: { label: "Blocked by network policy", cls: "er" },
    changed: { label: "Tools changed", cls: "wa" },
    error: { label: "Error", cls: "er" },
  };

  onMount(() => {
    void api
      .mcp()
      .then(accept)
      .catch((failure: unknown) => (error = String(failure)))
      .finally(() => (loaded = true));
  });

  function accept(listing: { review: boolean; servers: McpServer[] }) {
    review = listing.review;
    servers = listing.servers;
  }

  function replace(server: McpServer) {
    servers = servers.map((known) => (known.id === server.id ? server : known));
    choices[server.id] = server.tools.filter((tool) => tool.approved && !tool.changed).map((tool) => tool.name);
  }

  async function act(id: string, work: () => Promise<{ server: McpServer }>) {
    busy[id] = true;
    error = undefined;
    try {
      replace((await work()).server);
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy[id] = false;
    }
  }

  async function finishReview(enable: boolean) {
    busy.review = true;
    try {
      accept(await api.mcpReview(enable));
      onReviewed?.();
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      busy.review = false;
    }
  }

  async function add() {
    error = undefined;
    try {
      const auth = draft.auth === "header" ? { kind: "header" as const, header: draft.header } : { kind: draft.auth };
      const { server } = await api.mcpAdd({
        name: draft.name.trim(),
        url: draft.url.trim(),
        auth,
        private: draft.private,
      });
      servers = [...servers, server];
      if (draft.key !== "" && draft.auth !== "none") replace((await api.mcpKey(server.id, draft.key)).server);
      replace((await api.mcpTest(server.id)).server);
      open[server.id] = true;
      adding = false;
      draft = { name: "", url: "", auth: "none", header: "x-api-key", key: "", private: false };
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    }
  }

  async function remove(id: string) {
    try {
      accept(await api.mcpRemove(id));
      confirmRemove = undefined;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    }
  }

  function toggleTool(id: string, name: string, on: boolean) {
    const current = choices[id] ?? [];
    choices[id] = on ? [...current, name] : current.filter((tool) => tool !== name);
  }

  function authLabel(server: McpServer): string {
    if (server.auth.kind === "none") return "No key";
    const kind = server.auth.kind === "bearer" ? "Bearer key" : `Key in ${server.auth.header}`;
    return `${kind} · ${server.keyConfigured ? "configured" : "not configured"}`;
  }
</script>

<div class="head">
  <h2 class="h2 grow">MCP servers</h2>
  <button class="b p" onclick={() => (adding = true)} disabled={adding}><Icon name="plus" />Add server</button>
</div>
<p class="sub">
  MCP servers give Pal's scripts more tools. Pal calls a tool only while its server is enabled and only after you
  approve it; a server receives whatever a script sends to its tools. Keys are stored encrypted and never shown again.
</p>

{#if review}
  <div class="fold accent">
    <strong>Enable internet tools?</strong>
    <p class="sub">
      Exa searches and reads public web pages; Context7 answers questions from library documentation. Both work without
      a key at limited rates, and a key raises the limits. Queries go to those services, separately from ChatGPT. Pal
      asks before sending private code or documents to them.
    </p>
    <div class="row-buttons">
      <button class="b p" onclick={() => finishReview(true)} disabled={busy.review}>Enable Exa and Context7</button>
      <button class="b" onclick={() => finishReview(false)} disabled={busy.review}>Not now</button>
    </div>
  </div>
{/if}

{#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}

{#if adding}
  <div class="fold accent">
    <div class="line">
      <strong class="grow">Add MCP server</strong>
      <button class="b i q" aria-label="Cancel adding server" onclick={() => (adding = false)}><Icon name="x" /></button
      >
    </div>
    <p class="sub">Streamable HTTP servers. Local command servers need Pal's executor, which isn't available yet.</p>
    <div class="fields">
      <label class="fl"
        >Name<input class="f" bind:value={draft.name} placeholder="e.g. Issue tracker" autocomplete="off" /></label
      >
      <label class="fl wide"
        >URL<input
          class="f mono"
          bind:value={draft.url}
          placeholder="https://tools.example.com/mcp"
          autocomplete="off"
          spellcheck="false"
        /></label
      >
    </div>
    <div class="fields">
      <label class="fl">
        Key
        <select class="f" bind:value={draft.auth}>
          <option value="none">None</option>
          <option value="header">API key header</option>
          <option value="bearer">Bearer token</option>
        </select>
      </label>
      {#if draft.auth === "header"}
        <label class="fl"
          >Header name<input class="f mono" bind:value={draft.header} autocomplete="off" spellcheck="false" /></label
        >
      {/if}
      {#if draft.auth !== "none"}
        <label class="fl wide"
          >Key<input class="f mono" type="password" bind:value={draft.key} autocomplete="off" /></label
        >
      {/if}
    </div>
    <label class="flr">
      <input type="checkbox" bind:checked={draft.private} />
      Private endpoint: allow a local or private-network address (and plain HTTP). Only for servers you run.
    </label>
    <div class="row-buttons end">
      <button class="b p" onclick={add} disabled={draft.name.trim() === "" || draft.url.trim() === ""}
        >Add and test</button
      >
    </div>
  </div>
{/if}

{#if loaded && servers.length === 0}<p class="sub">No MCP servers yet.</p>{/if}
<div class="list">
  {#each servers as server (server.id)}
    {@const status = STATES[server.state]}
    {@const expanded = open[server.id] === true}
    <div class="fold card">
      <div class="line">
        <button class="b q name" aria-expanded={expanded} onclick={() => (open[server.id] = !expanded)}>
          <Icon name={expanded ? "chevD" : "chevR"} />
          <span>{server.name}</span>
          <span class="cmeta"
            >{server.preset !== null ? "Preset" : server.private ? "Private endpoint" : "HTTPS"} · {authLabel(
              server,
            )}</span
          >
        </button>
        <span class="pill {status.cls}">{status.label}</span>
        <label class="switch">
          <input
            class="swi"
            type="checkbox"
            role="switch"
            checked={server.enabled}
            disabled={busy[server.id]}
            aria-label={`Enable ${server.name}`}
            onchange={(event) => act(server.id, () => api.mcpEnabled(server.id, event.currentTarget.checked))}
          />
          {server.enabled ? "On" : "Off"}
        </label>
      </div>
      <div class="mono url">{server.url}</div>
      {#if busy[server.id]}
        <div class="status" role="status">
          <span class="ring spin" aria-hidden="true"></span>Talking to {server.name}…
        </div>
      {:else if server.state === "key_required" || server.state === "rate_limited" || server.state === "changed"}
        <div class="callout wa" role="status">
          <strong>{status.label}.</strong>
          {server.state === "changed"
            ? "Review the tools below; changed ones stay off until approved again."
            : server.detail}
        </div>
      {:else if server.state === "unreachable" || server.state === "blocked" || server.state === "error"}
        <div class="callout er" role="alert">
          <span><strong>{status.label}.</strong> {server.detail}</span>
          <div><button class="b sm" onclick={() => act(server.id, () => api.mcpTest(server.id))}>Retry</button></div>
        </div>
      {/if}
      {#if expanded}
        <div class="details">
          <div class="h3">Connection</div>
          {#if server.auth.kind !== "none"}
            <div class="fields">
              <label class="fl wide">
                {server.keyConfigured ? "Replace key" : "Key"}
                <input
                  class="f mono"
                  type="password"
                  bind:value={keys[server.id]}
                  placeholder={server.keyConfigured
                    ? "Saved; type to replace"
                    : "Optional for presets: raises rate limits"}
                  autocomplete="off"
                />
              </label>
            </div>
            <div class="row-buttons">
              <button
                class="b sm"
                disabled={(keys[server.id] ?? "") === ""}
                onclick={() =>
                  act(server.id, async () => {
                    const saved = await api.mcpKey(server.id, keys[server.id] ?? "");
                    keys[server.id] = "";
                    return saved;
                  })}>Save key</button
              >
              {#if server.keyConfigured}
                <button class="b sm q" onclick={() => act(server.id, () => api.mcpKey(server.id, null))}
                  >Remove key</button
                >
              {/if}
            </div>
          {/if}
          <div>
            <button class="b sm" onclick={() => act(server.id, () => api.mcpTest(server.id))}>Test connection</button>
          </div>
          <p class="sub">Testing connects and lists tools. It never calls one.</p>
          {#if !server.private}
            <label class="flr">
              <input
                type="checkbox"
                checked={server.fakeIp}
                disabled={busy[server.id]}
                aria-label={`Allow fake-IP routing for ${server.name}`}
                onchange={(event) => act(server.id, () => api.mcpFakeIp(server.id, event.currentTarget.checked))}
              />
              Allow a trusted local proxy’s fake-IP DNS for this endpoint (198.18.0.0/15).
            </label>
            <p class="sub">
              Only for a proxy you already trust. HTTPS and certificate verification stay on; other private addresses
              stay blocked. Changing this disables the server and clears tool approvals. Test, then enable it again.
            </p>
          {/if}
          <div class="h3">Tools</div>
          {#if server.tools.length === 0}
            <p class="sub">Test the connection to list this server's tools.</p>
          {:else}
            {#each server.tools as tool (tool.name)}
              <label class="srcrow tool">
                <input
                  type="checkbox"
                  checked={(
                    choices[server.id] ?? server.tools.filter((t) => t.approved && !t.changed).map((t) => t.name)
                  ).includes(tool.name)}
                  onchange={(event) => {
                    choices[server.id] ??= server.tools.filter((t) => t.approved && !t.changed).map((t) => t.name);
                    toggleTool(server.id, tool.name, event.currentTarget.checked);
                  }}
                />
                <span class="grow">
                  <span class="mono">{tool.name}</span>
                  {#if tool.changed}<span class="pill wa">Changed since approval</span>
                  {:else if tool.approved}<span class="pill ok">Approved</span>{/if}
                  <span class="setd">{tool.description}</span>
                </span>
              </label>
            {/each}
            <div class="row-buttons">
              <button
                class="b sm p"
                onclick={() =>
                  act(server.id, () =>
                    api.mcpTools(
                      server.id,
                      choices[server.id] ?? server.tools.filter((t) => t.approved && !t.changed).map((t) => t.name),
                    ),
                  )}>Approve selected tools</button
              >
            </div>
          {/if}
          {#if server.preset === null}
            <div class="row-buttons divider">
              {#if confirmRemove === server.id}
                <span class="grow small"
                  >Remove {server.name}? Its tools stop at once and its stored key is deleted.</span
                >
                <button class="b sm" onclick={() => (confirmRemove = undefined)}>Cancel</button>
                <button class="b sm dz" onclick={() => remove(server.id)}>Remove</button>
              {:else}
                <button class="b sm q d" onclick={() => (confirmRemove = server.id)}>Remove server…</button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .head,
  .line {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .accent {
    border-color: var(--acln);
    gap: 12px;
  }
  .row-buttons {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .end {
    justify-content: flex-end;
  }
  .fields {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    align-items: flex-end;
  }
  .wide {
    flex: 3 1 260px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card {
    gap: 10px;
  }
  .name {
    padding-left: 4px;
    flex: 1 1 220px;
    justify-content: flex-start;
    min-width: 0;
    color: var(--tx);
  }
  .name .cmeta {
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .switch {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--tx2);
  }
  .url {
    font-size: 12px;
    color: var(--tx3);
    overflow-wrap: anywhere;
    padding-left: 30px;
  }
  .status {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    color: var(--tx2);
    padding-left: 30px;
  }
  .details {
    display: flex;
    flex-direction: column;
    gap: 12px;
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .tool {
    align-items: flex-start;
    justify-content: flex-start;
    cursor: pointer;
  }
  .tool input {
    margin-top: 3px;
  }
  .tool .grow {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: center;
  }
  .tool .setd {
    flex-basis: 100%;
  }
  .divider {
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }
  .small {
    font-size: 12.5px;
    color: var(--tx2);
  }
</style>
