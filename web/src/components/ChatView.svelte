<script lang="ts">
  import {
    api,
    ApiError,
    type ChatSummary,
    type CommandMode as Approval,
    type Effort,
    type Project,
    requestId,
    type Upload,
    type WorkspaceMode as Mode,
  } from "../lib/api.ts";
  import {
    type Attachment,
    type Block,
    ChatStream,
    type CommandApproval,
    type Entry,
    type Message,
    type McpReceipt,
    type NestedCall,
    type ShellReceipt,
    textOf,
  } from "../lib/chat.svelte.ts";
  import Icon from "../lib/Icon.svelte";
  import CommandMode from "./CommandMode.svelte";
  import InternetSources from "./InternetSources.svelte";
  import WorkspaceMode from "./WorkspaceMode.svelte";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { app, navigate, refreshProjects, viewport } from "../lib/state.svelte.ts";

  let { chat, project, onNewChat }: { chat: ChatSummary; project: Project; onNewChat: (mode: Mode) => Promise<void> } =
    $props();
  const workspace = $derived(chat.workspace);
  const root = $derived(workspace?.root ?? project.root);
  const ready = $derived(workspace == null || workspace.state === "ready");
  let preparing = $state(false);
  async function prepare() {
    preparing = true;
    try {
      await api.prepareWorkspace(chat.id);
      await refreshProjects();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      preparing = false;
    }
  }

  type Step = {
    id: string;
    name: string;
    code: string | undefined;
    result: { text: string; isError: boolean; calls: NestedCall[] } | undefined;
  };
  type Item =
    | { kind: "user"; id: string; text: string; at: number | undefined; attachments: Attachment[] }
    | {
        kind: "assistant";
        id: string;
        texts: string[];
        steps: Step[];
        at: number | undefined;
        error: string | undefined;
        stopped: boolean;
        live: boolean;
      }
    | { kind: "note"; id: string; text: string }
    | { kind: "shell"; id: string; receipt: ShellReceipt }
    | { kind: "mcp"; id: string; receipt: McpReceipt }
    | { kind: "approval"; id: string; approval: CommandApproval };

  const USAGE_URL = "https://chatgpt.com/settings/usage";

  let stream: ChatStream | undefined = $state();
  let model: string | null = $state(null);
  let effort: Effort = $state("off");
  let choosing = $state(false);
  const efforts = ["off", "low", "medium", "high"] as const;
  let draft = $state("");
  let composer: HTMLTextAreaElement | undefined = $state();
  /** Add text the owner chose elsewhere (a terminal selection, a file reference) to the draft; never sends it. */
  export function insertText(text: string) {
    draft += `${draft ? "\n\n" : ""}${text}`;
    composer?.focus();
  }
  let pending: { key: string; text: string; files: string } | undefined;
  let attachments: Upload[] = $state([]);
  let uploading = $state(0);
  let fileInput: HTMLInputElement | undefined = $state();
  let whenBusy: "followUp" | "steer" = $state("followUp");
  let picker = $state(false);
  let sending = $state(false);
  let error: string | undefined = $state();
  let openSteps: Record<string, boolean> = $state({});
  /** Texts this page queued, by submission, so a queued item can show what it says. */
  let queuedTexts: Record<number, string> = $state({});
  const phone = $derived(viewport() === "phone");

  $effect(() => {
    const current = new ChatStream(chat.id);
    stream = current;
    void api.chat(chat.id).then((loaded) => {
      model = loaded.model;
      effort = loaded.effort;
    });
    return () => current.close();
  });

  const items = $derived.by(() => build(stream?.entries ?? [], stream?.partial, stream?.approvals ?? []));
  const awaiting = $derived((stream?.approvals ?? []).some((approval) => approval.state === "pending"));
  const connected = $derived(app.chatgpt?.account != null);
  const choices = $derived((app.chatgpt?.models ?? []).filter((choice) => choice.supported));
  const effectiveModel = $derived(model ?? app.chatgpt?.model ?? null);
  const modelName = $derived(
    choices.find((choice) => choice.slug === effectiveModel)?.displayName ?? effectiveModel ?? "Choose model",
  );
  const supportedEfforts = $derived(choices.find((choice) => choice.slug === effectiveModel)?.efforts ?? []);
  const canSend = $derived(
    ready && !sending && !choosing && uploading === 0 && draft.trim() !== "" && connected && effectiveModel !== null,
  );

  function build(entries: Entry[], partial: Message | undefined, approvals: readonly CommandApproval[]): Item[] {
    // A result belongs to the call of that ID in the latest assistant message before it; IDs may repeat across turns.
    const results: Record<string, { text: string; isError: boolean; calls: NestedCall[] }> = {};
    const caller: Record<string, number> = {};
    for (const entry of entries) {
      const message = entry.model?.[0];
      if (entry.kind === "pi.assistant" && message !== undefined && typeof message.content !== "string") {
        for (const block of message.content) if (block.type === "toolCall") caller[block.id] = entry.id;
      } else if (entry.kind === "pi.tool-result" && message?.toolCallId !== undefined) {
        results[`${caller[message.toolCallId]}/${message.toolCallId}`] = {
          text: textOf(message),
          isError: message.isError === true,
          calls: message.details?.calls ?? [],
        };
      }
    }
    const assistant = (id: string, message: Message, live: boolean): Item => {
      const blocks: Block[] =
        typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      return {
        kind: "assistant",
        id,
        texts: blocks.flatMap((block) => (block.type === "text" && block.text !== "" ? [block.text] : [])),
        steps: blocks.flatMap((block) =>
          block.type === "toolCall"
            ? [
                {
                  id: block.id,
                  name: block.name,
                  code: typeof block.arguments.code === "string" ? block.arguments.code : undefined,
                  result: results[`${id}/${block.id}`],
                },
              ]
            : [],
        ),
        at: message.timestamp,
        error: message.stopReason === "error" ? (message.errorMessage ?? "The model request failed.") : undefined,
        stopped: message.stopReason === "aborted",
        live,
      };
    };
    const receipts = new Map(
      entries.flatMap((entry) =>
        entry.data?.shell?.status === "finished" ? [[entry.data.shell.callId, entry.data.shell] as const] : [],
      ),
    );
    const internet = new Map(
      entries.flatMap((entry) =>
        entry.kind === "pal.mcp" && entry.data?.mcp ? [[entry.data.mcp.callId, entry.id] as const] : [],
      ),
    );
    // Each command request sits under the assistant turn whose script asked; others close the transcript.
    const placed = new Set(entries.map((entry) => entry.id));
    const asked = (assistant: number | null) =>
      approvals.flatMap((approval): Item[] =>
        approval.assistant === assistant ? [{ kind: "approval", id: `approval-${approval.id}`, approval }] : [],
      );
    const built: Item[] = [];
    for (const entry of entries) {
      if (entry.kind === "pal.mcp" && entry.data?.mcp !== undefined) {
        if (internet.get(entry.data.mcp.callId) === entry.id)
          built.push({ kind: "mcp", id: String(entry.id), receipt: entry.data.mcp });
        continue;
      }
      if (entry.kind === "pal.shell" && entry.data?.shell?.status === "started") {
        built.push({
          kind: "shell",
          id: String(entry.id),
          receipt: receipts.get(entry.data.shell.callId) ?? entry.data.shell,
        });
        continue;
      }
      const message = entry.model?.[0];
      if ((entry.kind === "pi.user" || entry.kind === "pal.user") && message !== undefined) {
        // An input with attachments shows its own text; the attachments' contents went to the model, not the bubble.
        const content = typeof message.content === "string" ? message.content : message.content[0];
        const text = typeof content === "string" ? content : content?.type === "text" ? content.text : "";
        built.push({
          kind: "user",
          id: String(entry.id),
          text,
          at: message.timestamp,
          attachments: entry.data?.attachments ?? [],
        });
      } else if (entry.kind === "pi.assistant" && message !== undefined) {
        built.push(assistant(String(entry.id), message, false), ...asked(entry.id));
      } else if (entry.kind === "pi.compaction") {
        built.push({
          kind: "note",
          id: String(entry.id),
          text: "Earlier messages were summarized to keep the chat within the model's context.",
        });
      }
    }
    for (const approval of approvals) {
      if (approval.assistant === null || !placed.has(approval.assistant))
        built.push({ kind: "approval", id: `approval-${approval.id}`, approval });
    }
    if (partial !== undefined) built.push(assistant("live", partial, true));
    return built;
  }

  async function send() {
    const text = draft.trim();
    if (!canSend) return;
    const ids = attachments.map((attachment) => attachment.id);
    // A retry after a lost response reuses the key, so the server admits the message once.
    if (pending?.text !== text || pending.files !== ids.join()) pending = { key: requestId(), text, files: ids.join() };
    sending = true;
    error = undefined;
    try {
      if (model === null && effectiveModel !== null) model = (await api.setChatModel(chat.id, effectiveModel)).model;
      const { admission } = await api.send(chat.id, pending.key, text, stream?.running ? whenBusy : "followUp", ids);
      if (stream?.running) queuedTexts[admission.submissionId] = text;
      pending = undefined;
      draft = "";
      attachments = [];
      if (chat.title === null) void refreshProjects();
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      sending = false;
    }
  }

  async function chooseModel(slug: string, level?: Effort) {
    if (choosing) return;
    if (level === undefined) picker = false;
    choosing = true;
    try {
      const chosen = await api.setChatModel(chat.id, slug, level);
      model = chosen.model;
      effort = chosen.effort;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      choosing = false;
    }
  }

  async function chooseMode(next: Approval) {
    try {
      const { chat: changed } = await api.setCommandMode(chat.id, next);
      if (stream !== undefined && changed.commandMode !== undefined) stream.mode = changed.commandMode;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    }
  }

  let deciding: string | undefined = $state();
  async function decide(approval: CommandApproval, decision: "approve" | "deny") {
    if (deciding !== undefined) return;
    deciding = approval.id;
    error = undefined;
    try {
      stream?.showApprovals(await api.decideCommand(chat.id, approval.id, decision, approval.digest));
    } catch (failure) {
      error =
        failure instanceof ApiError && failure.code === "approval_stale"
          ? "That request is no longer waiting for an answer. Nothing changed."
          : failure instanceof ApiError
            ? failure.message
            : String(failure);
    } finally {
      deciding = undefined;
    }
  }

  const heads = {
    pending: "Approval needed to run a command",
    approved: "Command approved",
    denied: "Command denied",
    expired: "Approval expired",
    stopped: "Approval request ended",
  } as const;
  function outcome(approval: CommandApproval): string {
    const at = time(approval.decidedAt ?? undefined);
    if (approval.state === "approved") return `Approved once by you at ${at}. Later commands ask again.`;
    if (approval.state === "denied") return `Denied by you at ${at}. Nothing was run.`;
    if (approval.state === "expired") return "No answer before it expired. Nothing was run.";
    return "The run stopped before you answered. Nothing was run.";
  }

  async function upload(files: FileList | null) {
    for (const file of files ?? []) {
      uploading += 1;
      try {
        attachments = [...attachments, await api.upload(project.id, file)];
      } catch (failure) {
        error = `${file.name}: ${failure instanceof ApiError ? failure.message : String(failure)}`;
      } finally {
        uploading -= 1;
      }
    }
    if (fileInput !== undefined) fileInput.value = "";
  }

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && app.sendWithEnter && !phone) {
      event.preventDefault();
      void send();
    }
  }

  /** `mcp__exa__web_search_exa` reads as "exa · web_search_exa". */
  function toolLabel(name: string): string {
    const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name) ?? [];
    return server === undefined || tool === undefined ? name : `${server} · ${tool}`;
  }

  function time(at: number | undefined): string {
    return at === undefined ? "" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
</script>

<section aria-label="Chat">
  {#if !phone}
    <header>
      <div class="titles">
        <div class="project">{project.name}</div>
        <h1>{chat.title ?? "New chat"}</h1>
      </div>
      <span class="wsitem" title={root}><Icon name="folder" />{root}</span>
    </header>
  {/if}

  <div class="scroller">
    <div class="transcript" style:padding-inline={phone ? "12px" : "20px"}>
      {#if stream?.loaded && items.length === 0}
        <div class="empty">
          <h2>Start the conversation</h2>
          {#if ready}<p>Pal works in <span class="mono">{root}</span>. Ask a question or describe what you need.</p>
          {:else}<p>This chat's folder is not ready. No local folder was substituted.</p>{/if}
          {#if workspace?.mode === "worktree" && ready}<p>
              Detached worktree from <span class="mono">{workspace.base?.slice(0, 12)}</span>. Source dirt was not
              copied; {workspace.submodules} submodules left uninitialized. Not a sandbox.
            </p>{/if}
          {#if workspace?.mode === "read-only"}<p>
              Agent file writes and shell are disabled. Human Terminal and MCP grants are separate. This is a tool
              policy, not a sandbox.
            </p>{/if}
        </div>
      {/if}
      {#each items as item (item.id)}
        {#if item.kind === "user"}
          <div class="user">
            <div class="bubble">{item.text}</div>
            {#if item.attachments.length > 0}
              <div class="chips end">
                {#each item.attachments as attachment (attachment.id)}
                  <span class="chip plain"
                    ><Icon name="file" />{attachment.name}<span class="dim">{size(attachment.size)}</span></span
                  >
                {/each}
              </div>
            {/if}
            <span class="at">{time(item.at)}</span>
          </div>
        {:else if item.kind === "note"}
          <div class="note"><Icon name="info" /><span>{item.text}</span></div>
        {:else if item.kind === "mcp"}
          <InternetSources receipt={item.receipt} />
        {:else if item.kind === "approval"}
          {@const approval = item.approval}
          <div class="appr" class:settled={approval.state !== "pending"} role="group" aria-label="Approval request">
            <div class="apph">
              <Icon name={approval.state === "pending" ? "warn" : "term"} />{heads[approval.state]}
            </div>
            <code class="mono cmd">{approval.command}</code>
            <p class="why">
              In <span class="mono">{approval.cwd}</span> · timeout {approval.timeout} s · runs as the Pal host user, not
              in a sandbox.
            </p>
            {#if approval.state === "pending"}
              <p class="why">
                Waits until {time(approval.expiresAt)} at most; Stop ends it. Nothing runs until you approve.
              </p>
              <div class="acts">
                <button class="b p" disabled={deciding !== undefined} onclick={() => decide(approval, "approve")}
                  >Approve once</button
                >
                <button class="b" disabled={deciding !== undefined} onclick={() => decide(approval, "deny")}
                  >Deny</button
                >
              </div>
            {:else}
              <div class="why">{outcome(approval)}</div>
            {/if}
          </div>
        {:else if item.kind === "shell"}
          <details class="activity">
            <summary class="acth"
              ><Icon name="term" /><span class="grow">Host command <span class="dim">· not sandboxed</span></span>
              <span class="pill" class:er={item.receipt.timedOut || (item.receipt.exitCode ?? 0) !== 0}>
                {item.receipt.timedOut
                  ? "Timed out"
                  : item.receipt.exitCode !== undefined
                    ? `Exit ${item.receipt.exitCode}`
                    : "Pending receipt"}
              </span>
            </summary>
            <div class="small dim mono ellipsis" title={item.receipt.cwd}>{item.receipt.cwd}</div>
            <pre class="out">{item.receipt.command}</pre>
            {#if item.receipt.output !== undefined}<pre class="out">{item.receipt.output}</pre>{/if}
            {#if item.receipt.truncated}<p class="small dim">Output truncated to the last 64 KiB.</p>{/if}
            {#if item.receipt.status !== "finished"}<p class="small dim">
                No completion receipt yet. If interrupted, inspect the workspace before retrying.
              </p>{/if}
          </details>
        {:else}
          {#if item.steps.length > 0}
            {@const open = openSteps[item.id] === true}
            <div class="activity">
              <button class="acth" aria-expanded={open} onclick={() => (openSteps[item.id] = !open)}>
                {#if item.live && item.steps.some((step) => step.result === undefined)}
                  <span class="ring spin" aria-hidden="true"></span>
                {:else}
                  <Icon name="run" />
                {/if}
                <span class="grow">
                  <span class="strong"
                    >{item.steps.length === 1 ? "Ran a script" : `Ran ${item.steps.length} scripts`}</span
                  >
                  {#if item.steps.some((step) => step.result?.isError)}<span class="dim"> · with errors</span>{/if}
                </span>
                <span class="dim small">{open ? "Hide" : "Show"}</span>
                <Icon name={open ? "chevD" : "chevR"} />
              </button>
              {#if open}
                <ol>
                  {#each item.steps as step (step.id)}
                    <li>
                      <div class="steprow">
                        <Icon name="run" /><span class="dim">{step.name}</span>
                        {#if step.result === undefined}<span class="pill">Running</span>
                        {:else if step.result.isError}<span class="pill er">Failed</span>
                        {:else}<span class="pill ok">Done</span>{/if}
                      </div>
                      {#if step.code !== undefined}<pre class="out">{step.code}</pre>{/if}
                      {#each step.result?.calls ?? [] as call (call.id)}
                        <div class="steprow call">
                          <Icon name={call.name.startsWith("mcp__") ? "globe" : "run"} />
                          <span>{toolLabel(call.name)}</span>
                          <span class="mono args">{call.args}</span>
                          {#if call.status === "ok"}<span class="pill ok">Done</span>
                          {:else if call.status === "running"}<span class="pill">Interrupted</span>
                          {:else}<span class="pill er">{call.status === "cancelled" ? "Cancelled" : "Failed"}</span
                            >{/if}
                        </div>
                        {#if call.error}<div class="dim small call">{call.error}</div>{/if}
                      {/each}
                      {#if step.result !== undefined}<pre class="out">{step.result.text}</pre>{/if}
                    </li>
                  {/each}
                </ol>
              {/if}
            </div>
          {/if}
          {#if item.texts.length > 0 || item.error !== undefined || item.stopped || item.live}
            <div class="assistant">
              {#each item.texts as text, index (index)}
                <!-- Sanitized by renderMarkdown: no raw HTML from the model survives. -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                <div class="md">{@html renderMarkdown(text)}</div>
              {/each}
              {#if item.live && item.texts.length === 0 && item.steps.length === 0}
                <div class="thinking"><span class="ring spin" aria-hidden="true"></span>Thinking…</div>
              {/if}
              {#if item.error !== undefined}
                {#if item.error.includes("subscription_sharing_usage_limit_exceeded")}
                  <div class="callout wa" role="alert">
                    <strong>ChatGPT usage limit reached.</strong> Pal paused instead of retrying. Check
                    <a href={USAGE_URL} target="_blank" rel="noopener noreferrer">ChatGPT settings → Usage</a>, then
                    send again.
                  </div>
                {:else}
                  <div class="callout er" role="alert"><strong>The model request failed.</strong> {item.error}</div>
                {/if}
              {/if}
              {#if item.stopped}<div class="note"><Icon name="stop" /><span>Stopped.</span></div>{/if}
              {#if !item.live}<span class="at">{time(item.at)}</span>{/if}
            </div>
          {/if}
        {/if}
      {/each}
    </div>
  </div>

  <div class="dock" style:padding={phone ? "0 12px 10px" : "0 20px 16px"}>
    <div class="dockin">
      {#if picker}
        <div class="pop" role="dialog" aria-label="Choose model" style:width={phone ? "100%" : "420px"}>
          <div class="poph">Model for this chat</div>
          {#if !connected}
            <p class="popn">Sign in with ChatGPT to list your models.</p>
          {/if}
          <div role="radiogroup" aria-label="ChatGPT models">
            {#each choices as choice (choice.slug)}
              <button
                class="opt"
                role="radio"
                aria-checked={choice.slug === effectiveModel}
                disabled={choosing}
                onclick={() => chooseModel(choice.slug)}
              >
                <span>{choice.displayName}</span><span class="mono optd">{choice.slug}</span>
              </button>
            {/each}
          </div>
          <div class="reasoning">
            <span>Reasoning effort</span>
            <div class="seg" role="radiogroup" aria-label="Reasoning effort">
              {#each efforts as level (level)}
                <button
                  class="segb"
                  role="radio"
                  aria-checked={effort === level}
                  disabled={choosing || effectiveModel === null || !supportedEfforts.includes(level)}
                  onclick={() => effectiveModel !== null && chooseModel(effectiveModel, level)}
                  >{level[0]?.toUpperCase()}{level.slice(1)}</button
                >
              {/each}
            </div>
            <p class="optd">Current: {effort}. Applies to this chat; unavailable levels are disabled.</p>
          </div>
        </div>
      {/if}

      {#if !ready}
        <div class="callout wa" role="status">
          {workspace?.error ?? "Preparing this chat's working folder. Messages stay disabled until it is ready."}
          {#if workspace?.state === "provisioning"}<button class="b sm" disabled={preparing} onclick={prepare}
              >{preparing ? "Checking…" : "Check workspace"}</button
            >{/if}
        </div>
      {/if}
      {#if !connected}
        <div class="callout wa nowrap" role="status">
          <span class="grow"><strong>ChatGPT isn't connected.</strong> Messages need your ChatGPT subscription.</span>
          <button class="b sm" onclick={() => navigate({ view: "settings", tab: "models" })}>Connect</button>
        </div>
      {/if}
      {#if stream !== undefined && stream.loaded && !stream.connected}
        <div class="callout wa" role="status">Reconnecting to Pal… The chat keeps running on the server.</div>
      {/if}
      {#if stream?.retry !== undefined}
        <div class="callout wa" role="status">The model request failed; Pal retries shortly. {stream.retry.error}</div>
      {/if}
      {#if stream?.running}
        <div class="running" role="status">
          <span class="ring spin" aria-hidden="true"></span>
          <span class="grow ellipsis"
            >{awaiting ? "Waiting for your approval" : "Running"} <span class="dim">· {modelName}</span></span
          >
          <button class="b sm" onclick={() => api.stop(chat.id)}><Icon name="stop" />Stop</button>
        </div>
      {/if}
      {#if (stream?.inbox.length ?? 0) > 0}
        <div class="queue">
          <div class="dim small">Sent when the current run reaches a stopping point.</div>
          {#each stream?.inbox ?? [] as queued (queued.id)}
            <div class="queued">
              <span class="pill">{queued.mode === "steer" ? "Steering" : "Queued"}</span>
              <span class="grow ellipsis">{queuedTexts[queued.id] ?? "Queued message"}</span>
            </div>
          {/each}
        </div>
      {/if}
      {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}

      <div class="cbx">
        {#if attachments.length > 0 || uploading > 0}
          <div class="chips">
            {#each attachments as attachment (attachment.id)}
              <span class="chip">
                <Icon name="file" /><span class="ellipsis">{attachment.name}</span>
                <button
                  class="chipx"
                  aria-label={`Remove ${attachment.name}`}
                  onclick={() => (attachments = attachments.filter((kept) => kept.id !== attachment.id))}
                  ><Icon name="x" size={12} /></button
                >
              </span>
            {/each}
            {#if uploading > 0}<span class="chip plain"
                ><span class="ring spin" aria-hidden="true"></span>Uploading…</span
              >{/if}
          </div>
        {/if}
        <label for="composer" class="sr">Message</label>
        <textarea
          id="composer"
          bind:this={composer}
          class="cta"
          rows="3"
          placeholder={stream?.running ? "Steer the run or queue a follow-up" : "Message Pal"}
          bind:value={draft}
          onkeydown={onKey}></textarea>
        <div class="tools">
          <input
            bind:this={fileInput}
            class="sr"
            type="file"
            multiple
            tabindex="-1"
            aria-hidden="true"
            onchange={(event) => upload(event.currentTarget.files)}
          />
          <button class="b q" aria-label="Upload from this device" onclick={() => fileInput?.click()}>
            <Icon name="clip" />{#if !phone}<span>Upload from this device</span>{/if}
          </button>
          <button class="b q" aria-label="Choose model" aria-expanded={picker} onclick={() => (picker = !picker)}>
            <Icon name="model" />{modelName}<Icon name="chevD" />
          </button>
          <WorkspaceMode {workspace} {onNewChat} />
          {#if workspace?.mode !== "read-only"}<CommandMode mode={stream?.mode} onChoose={chooseMode} />{/if}
          <span class="grow"></span>
          {#if stream?.running}
            <div class="seg" role="radiogroup" aria-label="While the agent is running">
              <button class="segb" role="radio" aria-checked={whenBusy === "steer"} onclick={() => (whenBusy = "steer")}
                >Steer</button
              >
              <button
                class="segb"
                role="radio"
                aria-checked={whenBusy === "followUp"}
                onclick={() => (whenBusy = "followUp")}>Queue</button
              >
            </div>
          {/if}
          <button class="b p send" onclick={send} disabled={!canSend}>
            <Icon name="send" />{stream?.running ? (whenBusy === "steer" ? "Steer" : "Queue") : "Send"}
          </button>
        </div>
      </div>
    </div>
  </div>
</section>

<style>
  .appr {
    border: 1px solid #5a4a2c;
    background: var(--wabg);
    border-radius: 8px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .appr.settled {
    border-color: var(--line2);
    background: var(--bg1);
  }
  .apph {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    color: var(--wa);
    font-size: 13px;
  }
  .settled .apph {
    color: var(--tx2);
  }
  .cmd {
    display: block;
    background: var(--bg1);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 12.5px;
    overflow-x: auto;
    white-space: pre;
  }
  .why {
    margin: 0;
    font-size: 13px;
    color: var(--tx2);
    overflow-wrap: anywhere;
  }
  .acts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .reasoning {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 8px 10px 2px;
    border-top: 1px solid var(--line);
  }
  section {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px 12px;
    padding: 8px 12px 8px 14px;
    min-height: 56px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .titles {
    flex: 1 1 200px;
    min-width: 0;
  }
  .project {
    font-size: 12px;
    color: var(--tx3);
    line-height: 1.3;
  }
  h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .scroller {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column-reverse;
  }
  .transcript {
    width: 100%;
    max-width: 780px;
    margin: 0 auto;
    padding-top: 20px;
    padding-bottom: 14px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .empty {
    padding: 40px 0 16px;
    color: var(--tx2);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .empty h2 {
    margin: 0;
    font-size: 16px;
    color: var(--tx);
    font-weight: 600;
  }
  .empty p {
    margin: 0;
    max-width: 520px;
  }
  .user {
    align-self: flex-end;
    max-width: min(88%, 620px);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
  .bubble {
    background: var(--bg3);
    border: 1px solid var(--line2);
    border-radius: 10px;
    padding: 9px 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .at {
    font-size: 11.5px;
    color: var(--tx3);
  }
  .note {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 12.5px;
    color: var(--tx2);
  }
  .activity {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg1);
  }
  .activity ol {
    list-style: none;
    margin: 0;
    padding: 6px 12px 8px;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
  }
  .activity li {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 0;
  }
  .steprow {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .strong {
    color: var(--tx);
  }
  .call {
    margin-left: 24px;
  }
  .args {
    font-size: 12px;
    color: var(--tx3);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .dim {
    color: var(--tx3);
  }
  .small {
    font-size: 12px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .assistant {
    display: flex;
    flex-direction: column;
    gap: 8px;
    line-height: 1.6;
  }
  .thinking {
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--tx2);
    font-size: 13px;
  }
  .md {
    overflow-wrap: anywhere;
  }
  .md :global(p) {
    margin: 0 0 8px;
  }
  .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .md :global(ul),
  .md :global(ol) {
    margin: 0 0 8px;
    padding-left: 22px;
  }
  .md :global(code) {
    font-family: var(--mono);
    font-size: 0.88em;
    background: var(--bg3);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .md :global(pre) {
    margin: 0 0 8px;
    padding: 8px 10px;
    background: var(--bg0);
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow-x: auto;
  }
  .md :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: 12.5px;
  }
  .md :global(a),
  .callout a {
    color: var(--ac);
  }
  .dock {
    flex: 0 0 auto;
  }
  .dockin {
    max-width: 780px;
    margin: 0 auto;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .pop {
    bottom: calc(100% + 6px);
    left: 0;
  }
  .opt {
    flex-direction: row;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
  }
  .nowrap {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .running {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 6px 6px 12px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--bg2);
    font-size: 13px;
  }
  .queue {
    border: 1px dashed var(--line2);
    border-radius: 8px;
    padding: 6px 6px 6px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .queued {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-wrap: wrap;
  }
  .send {
    margin-left: 4px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 2px 2px 0;
  }
  .chips.end {
    justify-content: flex-end;
  }
  .plain {
    padding-right: 8px;
  }
</style>
