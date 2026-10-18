<script lang="ts">
  import type { McpReceipt } from "../../../src/pi/mcp-source.ts";
  import Icon from "../lib/Icon.svelte";

  let { receipt }: { receipt: McpReceipt } = $props();
  const received = $derived(new Date(receipt.receivedAt));
  const fetched = $derived(receipt.cache === undefined ? undefined : new Date(receipt.cache.fetchedAt));
  function age(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
    return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  }
  const elapsed = $derived(
    receipt.elapsedMs < 1000 ? `${receipt.elapsedMs} ms` : `${(receipt.elapsedMs / 1000).toFixed(1)} s`,
  );
</script>

<section aria-label={`${receipt.serverName} ${receipt.tool} sources`}>
  <div class="head">
    <Icon name="globe" />
    <strong>{receipt.serverName}</strong>
    <span class="mono tool">{receipt.tool}</span>
    <span class="pill" class:er={receipt.isError}>{receipt.isError ? "Server error" : "Response received"}</span>
  </div>
  <p class="meta">
    {receipt.cache?.hit ? "Cache read" : "Received"}
    <time datetime={received.toISOString()}>{received.toLocaleString()}</time>
    · {elapsed} · {receipt.cache?.hit ? "Cached at lookup" : "Not cached at lookup"}
  </p>
  {#if receipt.cache?.hit && fetched !== undefined}<p class="meta">
      MCP response fetched <time datetime={fetched.toISOString()}>{fetched.toLocaleString()}</time> · Age at lookup: {age(
        receipt.receivedAt - receipt.cache.fetchedAt,
      )}. This was not a live lookup.
    </p>{/if}
  {#if receipt.cache?.bypassed}<p class="meta">
      Pal's cache was bypassed as requested. The MCP service may cache independently; this does not prove an origin
      recrawl.
    </p>{/if}
  {#if receipt.query}<p class="query">{receipt.query}</p>{/if}
  {#if receipt.library}<p class="meta">Library requested: <span class="mono">{receipt.library}</span></p>{/if}
  {#if receipt.isError}
    <p class="meta">The server returned an error; no source links were accepted.</p>
  {:else if receipt.sources.length === 0}
    <p class="meta">No source links were returned.</p>
  {:else}
    <details>
      <summary>Links ({receipt.sources.length})</summary>
      <ul>
        {#each receipt.sources as source (source.url)}
          <li>
            <span class="meta">{source.kind === "reported" ? "Server-reported link" : "Requested URL"}</span>
            <a href={source.url} target="_blank" rel="noopener noreferrer">
              <strong>{source.title}</strong>
              <span class="mono url">{source.url}</span>
            </a>
          </li>
        {/each}
      </ul>
      <p class="meta">
        Up to 20 links, not independently verified. A requested URL does not prove that page was fetched. Pal never
        opens these links automatically.
      </p>
    </details>
  {/if}
</section>

<style>
  section {
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg1);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 13px;
  }
  strong {
    font-weight: 500;
  }
  .tool {
    color: var(--tx2);
    font-size: 12px;
  }
  .meta {
    color: var(--tx3);
    font-size: 11.5px;
    margin: 6px 0 0;
    line-height: 1.5;
  }
  .query {
    font-size: 13px;
    color: var(--tx2);
    white-space: pre-wrap;
    margin: 8px 0;
  }
  summary {
    cursor: pointer;
    color: var(--ac);
    font-size: 12.5px;
    margin-top: 8px;
    min-height: 30px;
    align-content: center;
  }
  summary:focus-visible {
    outline: 2px solid var(--ac);
    outline-offset: 2px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    border-top: 1px solid var(--line);
    padding: 6px 0;
  }
  a {
    display: block;
    color: var(--tx);
    text-decoration: none;
    line-height: 1.5;
    padding: 4px 0;
  }
  a:hover strong {
    color: var(--ac);
    text-decoration: underline;
  }
  .url {
    display: block;
    font-size: 11.5px;
    color: var(--ac);
  }
  @media (max-width: 699px) {
    summary,
    a {
      min-height: 44px;
    }
  }
</style>
