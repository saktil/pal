<script lang="ts">
  import { onMount, tick } from "svelte";
  import { api, type Project, type ProjectFolder } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";

  type Preview = Awaited<ReturnType<typeof api.file>>;

  let { project }: { project: Project } = $props();
  /** Loaded folders by relative path ("" is the project root); only expanded ones are fetched. */
  let folders: Record<string, ProjectFolder> = $state({});
  let expanded: Record<string, boolean> = $state({});
  let preview: Preview | undefined = $state.raw();
  let opener: string | undefined;
  let busy = $state(false);
  let error: string | undefined = $state();
  let back: HTMLButtonElement | undefined = $state();
  const lines = $derived(preview?.kind === "text" ? preview.text.split("\n") : []);

  async function run(work: () => Promise<void>) {
    busy = true;
    error = undefined;
    try {
      await work();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }

  const load = (path: string) =>
    run(async () => {
      folders[path] = await api.files(project.id, path);
    });

  function toggle(path: string) {
    expanded[path] = !expanded[path];
    if (expanded[path] && folders[path] === undefined) void load(path);
  }

  /** A link may name a folder or a file; the server's path policy decides whether it is readable at all. */
  async function openLink(path: string) {
    await run(async () => {
      try {
        folders[path] = await api.files(project.id, path);
        expanded[path] = true;
      } catch {
        await display(path);
      }
    });
  }

  async function display(path: string) {
    opener = path;
    preview = await api.file(project.id, path);
    await tick();
    back?.focus();
  }

  const show = (path: string) => run(() => display(path));

  async function close() {
    preview = undefined;
    await tick();
    document.querySelector<HTMLButtonElement>(`[data-file-row="${CSS.escape(opener ?? "")}"]`)?.focus();
  }

  function refresh() {
    void run(async () => {
      const open = ["", ...Object.keys(expanded).filter((path) => expanded[path])];
      const reloaded = await Promise.all(open.map(async (path) => [path, await api.files(project.id, path)] as const));
      folders = Object.fromEntries(reloaded);
      if (preview !== undefined) preview = await api.file(project.id, preview.path);
    });
  }

  function size(bytes: number | undefined): string {
    if (bytes === undefined) return "";
    if (bytes < 1024) return `${bytes} B`;
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }

  onMount(() => {
    void load("");
  });
</script>

{#snippet tree(path: string, depth: number)}
  {@const folder = folders[path]}
  {#if folder !== undefined}
    <ul role="list" class="rows">
      {#each folder.entries as entry (entry.path)}
        <li>
          <button
            class="frow"
            style:padding-left={`${12 + depth * 16}px`}
            data-file-row={entry.path}
            aria-expanded={entry.kind === "folder" ? expanded[entry.path] === true : undefined}
            onclick={() =>
              entry.kind === "folder"
                ? toggle(entry.path)
                : entry.kind === "link"
                  ? openLink(entry.path)
                  : show(entry.path)}
          >
            <Icon name={entry.kind === "folder" ? (expanded[entry.path] ? "chevD" : "chevR") : "file"} />
            <span class="mono name">{entry.name}{entry.kind === "link" ? " →" : ""}</span>
            <span class="dim">{size(entry.size)}</span>
          </button>
          {#if entry.kind !== "file" && expanded[entry.path]}{@render tree(entry.path, depth + 1)}{/if}
        </li>
      {/each}
      {#if folder.entries.length === 0}<li class="dim note" style:padding-left={`${28 + depth * 16}px`}>
          Empty folder
        </li>{/if}
      {#if folder.omitted > 0}
        <li class="dim note" style:padding-left={`${28 + depth * 16}px`}>{folder.omitted} more entries not shown</li>
      {/if}
    </ul>
  {:else if expanded[path] || path === ""}
    <p class="dim note" role="status" style:padding-left={`${28 + depth * 16}px`}>Loading…</p>
  {/if}
{/snippet}

<div class="files" aria-busy={busy}>
  <div class="info">
    <span class="pill">{project.mode === "managed" ? "Managed" : "Host folder"}</span>
    <span class="mono folder" title={project.root}>{project.root}</span>
    <button class="b sm q" onclick={refresh} disabled={busy}><Icon name="refresh" />Refresh</button>
  </div>
  {#if error}<div class="callout er" role="alert">{error}</div>{/if}
  {#if preview === undefined}
    <p class="hint">Read-only view of the project folder. Viewing a file doesn't send it to the model.</p>
    <div class="scroll">{@render tree("", 0)}</div>
  {:else}
    {@const slash = preview.path.lastIndexOf("/")}
    <div class="filehead">
      <button class="b i q" aria-label="Back to files" bind:this={back} onclick={close}><Icon name="chevL" /></button>
      <span class="mono path" title={preview.path}
        ><span class="dim">{preview.path.slice(0, slash + 1)}</span>{preview.path.slice(slash + 1)}</span
      >
      <span class="pill"><Icon name="lock" />Read-only</span>
    </div>
    <div class="scroll code">
      {#if preview.kind === "binary"}
        <p class="note">Binary file, {size(preview.size)}. Its contents aren't shown.</p>
      {:else}
        {#if preview.truncated}
          <p class="note warning">Large file ({size(preview.size)}): only the first 256 KB are shown.</p>
        {/if}
        <div class="lines">
          {#each lines as line, index (index)}
            <div class="line">
              <span class="number" aria-hidden="true">{index + 1}</span><span class="text">{line}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .files {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .info,
  .filehead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }
  .filehead {
    gap: 6px;
    padding: 8px 10px;
  }
  .folder,
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .folder {
    color: var(--tx2);
  }
  .path {
    font-size: 12.5px;
  }
  .hint {
    margin: 0;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--tx3);
    border-bottom: 1px solid var(--line);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px 0 16px;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .frow {
    min-height: 30px;
    gap: 6px;
  }
  .frow :global(svg) {
    color: var(--tx3);
  }
  .name {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dim {
    color: var(--tx3);
    font-size: 12px;
  }
  .note {
    margin: 6px 12px;
    font-size: 12px;
    color: var(--tx3);
    list-style: none;
  }
  .warning {
    color: var(--wa);
  }
  .code {
    font-family: var(--mono);
    font-size: 12.5px;
    padding-top: 6px;
  }
  .lines {
    display: inline-block;
    min-width: 100%;
  }
  .line {
    display: flex;
    white-space: pre;
    line-height: 20px;
  }
  .number {
    flex: 0 0 46px;
    text-align: right;
    padding-right: 10px;
    color: var(--tx3);
    user-select: none;
  }
  .text {
    padding-right: 24px;
  }
</style>
