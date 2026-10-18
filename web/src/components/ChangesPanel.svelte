<script lang="ts">
  import { onMount } from "svelte";
  import {
    api,
    ApiError,
    type Change,
    type ChangeComment,
    type ChangeSet,
    type Project,
    type Workspace,
  } from "../lib/api.ts";
  import Icon from "../lib/Icon.svelte";
  import ConfirmRemoval from "./ConfirmRemoval.svelte";

  let {
    project,
    workspace,
    initialPath,
    onFeedback,
  }: {
    project: Project;
    workspace?: Workspace | null | undefined;
    initialPath?: string | undefined;
    onFeedback?: (text: string) => void;
  } = $props();
  const root = $derived(workspace?.root ?? project.root);
  let changes: ChangeSet | undefined = $state.raw();
  let chosen: string | undefined = $state();
  // A click wins; until then, the file Files asked to see.
  const selected = $derived(chosen ?? initialPath);
  let busy = $state(false);
  let error: string | undefined = $state();
  let done: string | undefined = $state();
  let discarding: Change | undefined = $state.raw();
  let includeIgnored = $state(false);
  const scope = $derived(includeIgnored ? "include-ignored" : "normal");
  let scan = 0;
  const file = $derived(changes?.files.find((candidate) => candidate.path === selected) ?? changes?.files[0]);
  type Row = { kind: "meta" | "hunk" | "add" | "del" | "same"; text: string; old?: number; line?: number };
  // Numbers each line from its hunk header; `line` is the line in the current file, which comments refer to.
  const rows = $derived.by(() => {
    const parsed: Row[] = [];
    let old = 0;
    let line = 0;
    let hunks = false;
    for (const text of (file?.patch ?? "").replace(/\n$/, "").split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk !== null) {
        old = Number(hunk[1]);
        line = Number(hunk[2]);
        hunks = true;
        parsed.push({ kind: "hunk", text });
      } else if (!hunks || text.startsWith("\\")) parsed.push({ kind: "meta", text });
      else if (text.startsWith("+")) parsed.push({ kind: "add", text: text.slice(1), line: line++ });
      else if (text.startsWith("-")) parsed.push({ kind: "del", text: text.slice(1), old: old++ });
      else parsed.push({ kind: "same", text: text.slice(1), old: old++, line: line++ });
    }
    return parsed;
  });
  let composing: number | undefined = $state();
  let draft = $state("");
  const listed = $derived(new Set(changes?.files.map((candidate) => candidate.path)));
  const displayed = $derived(rows.slice(0, 5000));
  const visibleLines = $derived(new Set(displayed.flatMap((row) => (row.line === undefined ? [] : [row.line]))));
  const current = $derived(
    (changes?.comments ?? []).reduce<Record<number, ChangeComment[]>>((byLine, comment) => {
      if (comment.path === file?.path && !comment.outdated) (byLine[comment.line] ??= []).push(comment);
      return byLine;
    }, {}),
  );
  const unplaced = $derived(
    changes?.comments.filter(
      (comment) =>
        !listed.has(comment.path) ||
        (comment.path === file?.path && (comment.outdated || !visibleLines.has(comment.line))),
    ) ?? [],
  );
  const outdatedCount = $derived(unplaced.filter((comment) => comment.outdated).length);
  const pending = $derived(changes?.comments.filter((comment) => !comment.sent) ?? []);

  async function refresh() {
    const request = ++scan;
    busy = true;
    error = undefined;
    done = undefined;
    try {
      const loaded = await api.changes(project.id, scope, workspace?.id);
      if (request === scan) changes = loaded;
    } catch (failure) {
      if (request === scan) error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      if (request === scan) busy = false;
    }
  }
  function changeScope(checked: boolean) {
    includeIgnored = checked;
    changes = undefined;
    composing = undefined;
    discarding = undefined;
    chosen = undefined;
    draft = "";
    void refresh();
  }
  async function review() {
    if (file === undefined) return;
    busy = true;
    error = undefined;
    try {
      await api.review(project.id, file.path, file.revision, !file.reviewed, scope, workspace?.id);
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
      await api.discard(project.id, target.path, target.revision, scope, workspace?.id);
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
  async function act(work: () => Promise<unknown>) {
    busy = true;
    error = undefined;
    try {
      await work();
      await refresh();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      busy = false;
    }
  }
  function open(line: number) {
    composing = composing === line ? undefined : line;
    draft = "";
  }
  const add = (target: Change, line: number) =>
    act(async () => {
      await api.comment(project.id, target.path, target.revision, line, draft, scope, workspace?.id);
      composing = undefined;
      draft = "";
    });
  async function feedback() {
    const sending = pending;
    onFeedback?.(
      [
        "Review feedback:",
        `Workspace: ${root}${workspace == null ? "" : ` (${workspace.mode}, ${workspace.id})`}.`,
        ...sending.map(
          (comment) =>
            `${comment.path} (revision ${comment.revision.slice(0, 12)}), line ${comment.line}${comment.outdated ? " (outdated)" : ""}: ${comment.lineText.trim()}\n${comment.body}`,
        ),
      ].join("\n\n"),
    );
    await act(() =>
      api.commentsSent(
        project.id,
        sending.map((comment) => comment.id),
        scope,
        workspace?.id,
      ),
    );
    if (error === undefined) done = "Feedback is in the composer. Edit it if needed, then send.";
  }
  const baseline = $derived(changes?.base?.slice(0, 12) ?? "empty tree");
  onMount(() => {
    void refresh();
  });
</script>

<div class="changes" aria-busy={busy}>
  <div class="info">
    <span class="pill">{workspace?.mode ?? (project.mode === "managed" ? "Managed" : "Host folder")}</span>
    <span class="mono folder" title={root}>{root}</span>
    <button class="b sm q" onclick={refresh} disabled={busy}><Icon name="refresh" />Refresh</button>
    {#if onFeedback}<button
        class="b sm"
        class:p={pending.length > 0}
        disabled={busy || pending.length === 0}
        onclick={feedback}
        ><Icon name="comment" />Send feedback to chat{pending.length > 0 ? ` (${pending.length})` : ""}</button
      >{/if}
  </div>
  <div class="review-scope">
    <label
      ><input
        type="checkbox"
        checked={includeIgnored}
        onchange={(event) => changeScope(event.currentTarget.checked)}
      />Include ignored files for review</label
    >
    <p>
      Ignored files may contain secrets. This local review choice does not change agent folder or shell access. Excerpts
      reach chat only when you choose Send feedback.
    </p>
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
    {#if unplaced.length > 0}
      <div class="outdated" role="region" aria-label="Other review comments">
        <p class="warning">
          <Icon name={outdatedCount > 0 ? "warn" : "comment"} />
          {outdatedCount > 0
            ? `${outdatedCount} outdated comment${outdatedCount === 1 ? "" : "s"}`
            : "Comments outside the visible diff"}
        </p>
        {#each unplaced as comment (comment.id)}{@render card(comment, true)}{/each}
      </div>
    {/if}
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
              onclick={() => {
                chosen = candidate.path;
                composing = undefined;
              }}
            >
              <span class="status" class:add={candidate.status === "A"} class:del={candidate.status === "D"}
                >{candidate.status}</span
              >
              <span class="mono path">{candidate.path}</span>
              {#if candidate.ignored}<span class="pill wa">Ignored</span>{/if}
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
          {@const target = file}
          <div class="patch" role="region" aria-label="File diff">
            {#each displayed as row, i (i)}
              {#if row.kind === "meta" || row.kind === "hunk"}
                <div class="dl meta" class:hunk={row.kind === "hunk"}><span class="tx">{row.text}</span></div>
              {:else}
                <div class="dl" class:add={row.kind === "add"} class:del={row.kind === "del"}>
                  <span class="ln">{row.old ?? ""}</span>
                  {#if row.line === undefined}<span class="ln"></span>
                  {:else}
                    {@const line = row.line}
                    <button
                      class="ln lnb"
                      aria-label={`Comment on line ${line}`}
                      aria-pressed={composing === line}
                      onclick={() => open(line)}>{line}</button
                    >
                  {/if}
                  <span class="sg">{row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}</span><span class="tx"
                    >{row.text}</span
                  >
                </div>
                {#if row.line !== undefined}
                  {@const line = row.line}
                  {#each current[line] ?? [] as comment (comment.id)}{@render card(comment)}{/each}
                  {#if composing === line}
                    <div class="cm">
                      <label for="change-comment">Comment on line {line}</label>
                      <textarea
                        id="change-comment"
                        class="f"
                        rows="3"
                        maxlength="4000"
                        placeholder="Leave a review comment"
                        bind:value={draft}
                        {@attach (node) => node.focus()}></textarea>
                      <div class="actions">
                        <button class="b sm q" onclick={() => (composing = undefined)}>Cancel</button>
                        <button class="b sm p" disabled={busy || draft.trim() === ""} onclick={() => add(target, line)}
                          >Add comment</button
                        >
                      </div>
                    </div>
                  {/if}
                {/if}
              {/if}
            {/each}
          </div>
          {#if rows.length > 5000}<p class="notice">
              Diff display limited to 5,000 lines. Review the full file in your editor.
            </p>{/if}
        {/if}
      {/if}
    {/if}
  {/if}
</div>

{#snippet card(comment: ChangeComment, detached = false)}
  <div class="cm" class:out={detached}>
    <div class="cmhead">
      <strong>You</strong>
      <span class="mono"
        >{comment.path === file?.path ? "" : `${comment.path} · `}Line {comment.line} · revision {comment.revision.slice(
          0,
          12,
        )}</span
      >
      {#if comment.outdated}<span class="pill wa">Outdated</span>{/if}
      <span class="pill" class:ok={comment.sent}>{comment.sent ? "Added to composer" : "Not sent"}</span>
      <span class="grow"></span>
      <button
        class="b sm q"
        disabled={busy}
        aria-label={`Delete comment on line ${comment.line}`}
        onclick={() => act(() => api.uncomment(project.id, comment.id, workspace?.id))}>Delete</button
      >
    </div>
    {#if detached}<code class="mono quote" class:gone={comment.outdated}>{comment.lineText.trim()}</code>{/if}
    <p>{comment.body}</p>
  </div>
{/snippet}

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
    detail={`${root}/${discarding.path} · revision ${discarding.revision.slice(0, 12)}`}
    confirmLabel="Discard changes"
    busyLabel="Discarding…"
    onCancel={() => (discarding = undefined)}
    onConfirm={discard}
  />
{/if}

<style>
  .review-scope {
    padding: 6px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }
  .review-scope label {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
  }
  .review-scope p {
    margin: 0 0 4px;
    color: var(--tx3);
    line-height: 1.5;
  }
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
  /* Room for the names first; the actions wrap below them on narrow panels. */
  .filehead .path,
  .info .folder {
    flex: 1 1 140px;
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
    padding: 4px 0 24px;
    background: var(--bg0);
    font: 11.5px/20px var(--mono);
    tab-size: 2;
  }
  .dl {
    display: flex;
    min-width: max-content;
    white-space: pre;
  }
  .ln {
    flex: 0 0 46px;
    padding: 0 8px 0 0;
    color: var(--tx3);
    text-align: right;
    user-select: none;
  }
  .lnb {
    border: 0;
    background: transparent;
    font: inherit;
  }
  .lnb:hover,
  .lnb:focus-visible,
  .lnb[aria-pressed="true"] {
    color: var(--ac);
    background: var(--acbg);
  }
  .sg {
    flex: 0 0 16px;
    color: var(--tx3);
    text-align: center;
    user-select: none;
  }
  .tx {
    padding-right: 24px;
  }
  .add {
    color: var(--addtx);
  }
  .del {
    color: var(--deltx);
  }
  .dl.add {
    background: var(--addbg);
  }
  .dl.del {
    background: var(--delbg);
  }
  .hunk {
    color: var(--ac);
    background: var(--acbg);
  }
  .meta .tx {
    padding-left: 12px;
  }
  .cm {
    position: sticky;
    left: 0;
    overflow-wrap: anywhere;
    max-width: 540px;
    margin: 6px 12px 8px 64px;
    padding: 10px 12px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--bg2);
    font: 13px/1.5 var(--sans);
    white-space: normal;
  }
  .cm.out {
    margin: 0;
    max-width: none;
    border-style: dashed;
  }
  .cm p {
    margin: 4px 0 0;
    white-space: pre-wrap;
  }
  .cm label {
    color: var(--tx3);
    font-size: 12px;
  }
  .cm textarea {
    margin-top: 4px;
    resize: vertical;
  }
  .cmhead {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    color: var(--tx3);
    font-size: 12px;
  }
  .cmhead strong {
    color: var(--tx);
    font-weight: 600;
  }
  .grow {
    flex: 1;
  }
  .quote {
    display: block;
    margin-top: 6px;
    color: var(--tx3);
    font-size: 12px;
    white-space: pre-wrap;
  }
  .gone {
    text-decoration: line-through;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 6px;
  }
  .outdated {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: 8px;
    max-height: 40%;
    overflow: auto;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  .outdated .warning {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 12px;
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
