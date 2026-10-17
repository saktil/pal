<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type Change, type ChangeSet, type Project } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import ConfirmRemoval from "./ConfirmRemoval.svelte";

  let { project, initialPath }: { project: Project; initialPath?: string | undefined } = $props();
  let changes: ChangeSet | undefined = $state.raw();
  let chosen: string | undefined = $state();
  // A click wins; until then, the file Files asked to see.
  const selected = $derived(chosen ?? initialPath);
  let busy = $state(false);
  let error: string | undefined = $state();
  let done: string | undefined = $state();
  let discarding: Change | undefined = $state.raw();
  const file = $derived(changes?.files.find((candidate) => candidate.path === selected) ?? changes?.files[0]);
  const lines = $derived(file?.patch.split("\n") ?? []);

  async function refresh() {
    busy = true;
    error = undefined;
    done = undefined;
    try {
      changes = await api.changes(project.id);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
  async function review() {
    if (file === undefined) return;
    busy = true;
    error = undefined;
    try {
      await api.review(project.id, file.path, file.revision, !file.reviewed);
      await refresh();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      busy = false;
    }
  }
  async function discard() {
    const target = discarding;
    if (target === undefined) return;
    try {
      await api.discard(project.id, target.path, target.revision);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.code === "changes_stale")) throw failure;
      discarding = undefined;
      await refresh();
      error =
        "This file changed while the dialog was open. Nothing was discarded, so newer work wasn't overwritten. Review the latest revision.";
      return;
    }
    discarding = undefined;
    await refresh();
    done = `Restored ${target.path} to the baseline.`;
  }
  const baseline = $derived(changes?.base?.slice(0, 12) ?? "empty tree");
  onMount(() => {
    void refresh();
  });
</script>

<div class="changes" aria-busy={busy}>
  <div class="info">
    <span class="pill">{project.mode === "managed" ? "Managed" : "Host folder"}</span>
    <span class="mono folder" title={project.root}>{project.root}</span>
    <button class="b sm q" onclick={refresh} disabled={busy}><Icon name="refresh" />Refresh</button>
  </div>
  {#if error}<div class="callout er" role="alert">{error}</div>{/if}
  {#if done}<p class="notice" role="status">{done}</p>{/if}
  {#if changes === undefined}
    <p class="notice" role="status">{busy ? "Reading changes…" : "Refresh to read changes."}</p>
  {:else}
    <div class="notice">
      <span class="mono"
        >{changes.state === "unavailable"
          ? "Baseline unavailable"
          : `Baseline ${changes.base?.slice(0, 12) ?? "empty tree"}`}</span
      >
      <p>{changes.note}</p>
      {#if changes.truncated}<p class="warning">
          Partial scan: file, byte or time limit reached. Not all changes are shown.
        </p>{/if}
    </div>
    {#if changes.state === "ready" && changes.files.length === 0}
      <div class="empty">
        <Icon name="check" />
        <h3>No changes found</h3>
        <p>Files match the baseline within this scan's limits.</p>
      </div>
    {:else if changes.files.length > 0}
      <ul class="files" aria-label="Changed files">
        {#each changes.files as candidate (candidate.path)}
          <li>
            <button
              class="frow"
              aria-current={file?.path === candidate.path ? "true" : undefined}
              onclick={() => (chosen = candidate.path)}
            >
              <span class="status" class:add={candidate.status === "A"} class:del={candidate.status === "D"}
                >{candidate.status}</span
              >
              <span class="mono path">{candidate.path}</span>
              {#if candidate.reviewed}<span class="pill ok">Reviewed</span>{/if}
              {#if candidate.problem}<Icon name="warn" />{/if}
            </button>
          </li>
        {/each}
      </ul>
      {#if file}
        <div class="filehead">
          <strong class="mono path">{file.path}</strong>
          <span class="mono revision">Revision {file.revision.slice(0, 12) || "unavailable"}</span>
          <button
            class="b sm"
            aria-pressed={file.reviewed}
            disabled={busy || file.problem !== undefined}
            onclick={review}><Icon name="check" />{file.reviewed ? "Reviewed" : "Mark reviewed"}</button
          >
          <button class="b sm" disabled={busy || file.problem !== undefined} onclick={() => (discarding = file)}
            >Discard…</button
          >
        </div>
        {#if file.problem}<p class="notice" role="status">{file.problem}</p>
        {:else}
          <pre class="patch" aria-label="File diff">{#each lines.slice(0, 5000) as line, i (i)}<span
                class:add={line.startsWith("+") && !line.startsWith("+++")}
                class:del={line.startsWith("-") && !line.startsWith("---")}
                class:hunk={line.startsWith("@@")}>{line + "\n"}</span
              >{/each}</pre>
          {#if lines.length > 5000}<p class="notice">
              Diff display limited to 5,000 lines. Review the full file in your editor.
            </p>{/if}
        {/if}
      {/if}
    {/if}
  {/if}
</div>

{#if discarding}
  <ConfirmRemoval
    title="Discard changes to this file?"
    description={`${
      discarding.status === "A"
        ? "Deletes this file, which isn't in the baseline."
        : discarding.status === "D"
          ? `Restores the deleted file from baseline ${baseline}.`
          : `Rewrites the file on disk to baseline ${baseline}.`
    } This can't be undone from here and may include changes made before Pal recorded the baseline. If the file changes before you confirm, nothing is discarded.`}
    detail={`${project.root}/${discarding.path} · revision ${discarding.revision.slice(0, 12)}`}
    confirmLabel="Discard changes"
    busyLabel="Discarding…"
    onCancel={() => (discarding = undefined)}
    onConfirm={discard}
  />
{/if}

<style>
  .changes {
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
    flex-wrap: wrap;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }
  .folder,
  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .folder {
    max-width: 100%;
    color: var(--tx2);
  }
  .notice {
    margin: 0;
    padding: 10px 12px;
    color: var(--tx3);
    font-size: 12px;
    border-bottom: 1px solid var(--line);
  }
  .notice p {
    margin: 4px 0 0;
  }
  .warning {
    color: var(--wa);
  }
  .files {
    list-style: none;
    padding: 4px 0;
    margin: 0;
    max-height: 26%;
    overflow: auto;
    flex-shrink: 0;
    border-bottom: 1px solid var(--line);
  }
  .frow {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border: 0;
    color: var(--tx2);
    background: transparent;
    text-align: left;
    font-size: 12.5px;
  }
  .frow:hover {
    background: var(--bg2);
  }
  .frow[aria-current="true"] {
    background: var(--acbg);
    color: var(--tx);
  }
  .status {
    color: var(--wa);
    font-size: 11px;
  }
  .revision {
    color: var(--tx3);
    font-size: 11px;
  }
  .patch {
    flex: 1;
    overflow: auto;
    min-height: 0;
    margin: 0;
    padding: 8px 0;
    background: var(--bg0);
    font: 11.5px/20px var(--mono);
    tab-size: 2;
  }
  .patch span {
    display: block;
    min-width: max-content;
    padding: 0 12px;
    height: 20px;
  }
  .add {
    color: var(--addtx);
  }
  .del {
    color: var(--deltx);
  }
  .patch .add {
    background: var(--addbg);
  }
  .patch .del {
    background: var(--delbg);
  }
  .hunk {
    color: var(--ac);
    background: var(--acbg);
  }
  .empty {
    padding: 28px 18px;
    color: var(--tx2);
  }
  h3 {
    color: var(--tx);
    font-size: 14px;
    margin: 8px 0;
  }
  .empty p {
    font-size: 13px;
  }
</style>
