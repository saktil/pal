<script lang="ts">
  import { tick } from "svelte";
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
  import AddMenu from "./AddMenu.svelte";
  import CommandMode from "./CommandMode.svelte";
  import InternetSources from "./InternetSources.svelte";
  import ModelControl, { type Group } from "./ModelControl.svelte";
  import WorkspaceMode from "./WorkspaceMode.svelte";
  import { codeCopy } from "../lib/copy.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { rise } from "../lib/motion.ts";
  import { app, navigate, refreshChatGPT, refreshProjects, viewport } from "../lib/state.svelte.ts";

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
  let provider: string | null = $state(null);
  let effort: Effort = $state("off");
  let choosing = $state(false);
  let draft = $state("");
  let typing = $state(false);
  let composer: HTMLTextAreaElement | undefined = $state();
  /** Add text the owner chose elsewhere (a terminal selection, a file reference) to the draft; never sends it. */
  export function insertText(text: string) {
    draft += `${draft ? "\n\n" : ""}${text}`;
    composer?.focus();
  }
  let pending: { key: string; text: string; files: string } | undefined;
  let attachments: Upload[] = $state([]);
  let uploading = $state(0);
  let whenBusy: "followUp" | "steer" = $state("followUp");
  let sending = $state(false);
  let error: string | undefined = $state();
  let openSteps: Record<string, boolean> = $state({});
  /** Texts this page queued, by submission, so a queued item can show what it says. */
  let queuedTexts: Record<number, string> = $state({});
  const phone = $derived(viewport() === "phone");
  /** Set once the history has rendered, so only items arriving afterwards animate in. */
  let settled = $state(false);
  $effect(() => {
    if (stream?.loaded && !settled) void tick().then(() => (settled = true));
  });

  $effect(() => {
    const current = new ChatStream(chat.id);
    stream = current;
    void api.chat(chat.id).then((loaded) => {
      model = loaded.model;
      provider = loaded.provider;
      effort = loaded.effort;
    });
    return () => current.close();
  });

  const items = $derived.by(() => build(stream?.entries ?? [], stream?.partial, stream?.approvals ?? []));
  const awaiting = $derived((stream?.approvals ?? []).some((approval) => approval.state === "pending"));
  const connected = $derived(app.chatgpt?.account != null);
  const effective = $derived(
    model !== null ? { provider: provider ?? "openai", modelId: model } : (app.chatgpt?.default ?? null),
  );
  /** ChatGPT once connected (or while it is this chat's provider), then each API-key provider the owner enabled. */
  const groups = $derived<Group[]>([
    ...(connected || effective?.provider === "openai"
      ? [
          {
            provider: "openai",
            name: "ChatGPT",
            billing: "Your ChatGPT subscription.",
            choices: (app.chatgpt?.models ?? [])
              .filter((choice) => choice.supported)
              .map((choice) => ({
                provider: "openai",
                id: choice.slug,
                name: choice.displayName,
                efforts: choice.efforts,
              })),
          },
        ]
      : []),
    ...(app.providers?.providers ?? [])
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        provider: entry.id,
        name: entry.name,
        billing: entry.billing,
        choices: entry.models.map((choice) => ({
          provider: entry.id,
          id: choice.id,
          name: choice.name,
          efforts: choice.efforts as Effort[],
        })),
      })),
  ]);
  const current = $derived(
    groups
      .flatMap((group) => group.choices)
      .find((choice) => choice.provider === effective?.provider && choice.id === effective.modelId),
  );
  const providerName = $derived(groups.find((group) => group.provider === effective?.provider)?.name);
  const modelName = $derived(current?.name ?? effective?.modelId ?? "Choose model");
  /** The chat's provider can take a message now: signed-in ChatGPT, or an enabled API-key provider. */
  const usable = $derived(
    effective !== null &&
      (effective.provider === "openai"
        ? connected
        : (app.providers?.providers ?? []).some((entry) => entry.id === effective.provider && entry.enabled)),
  );
  const isDefault = $derived(
    effective !== null &&
      app.chatgpt?.default?.provider === effective.provider &&
      app.chatgpt.default.modelId === effective.modelId,
  );
  const canSend = $derived(ready && !sending && !choosing && uploading === 0 && draft.trim() !== "" && usable);

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
      if (model === null && effective !== null) {
        const chosen = await api.setChatModel(chat.id, effective.modelId, undefined, effective.provider);
        model = chosen.model;
        provider = chosen.provider;
      }
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

  async function chooseModel(choice: { provider: string; id: string }, level?: Effort) {
    if (choosing) return;
    choosing = true;
    try {
      const chosen = await api.setChatModel(chat.id, choice.id, level, choice.provider);
      model = chosen.model;
      provider = chosen.provider;
      effort = chosen.effort;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
    } finally {
      choosing = false;
    }
  }

  async function useForNewChats() {
    if (effective === null) return;
    try {
      app.providers = await api.setDefault(effective.provider, effective.modelId);
      await refreshChatGPT();
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
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
  const browserHeads = {
    ...heads,
    pending: "Approval needed for a browser action",
    approved: "Browser action approved",
    denied: "Browser action denied",
  };
  function outcome(approval: CommandApproval): string {
    const at = time(approval.decidedAt ?? undefined);
    if (approval.state === "approved")
      return `Approved once by you at ${at}. Later ${approval.tool === "browser_act" ? "browser actions" : "commands"} ask again.`;
    if (approval.state === "denied") return `Denied by you at ${at}. Nothing was run.`;
    if (approval.state === "expired") return "No answer before it expired. Nothing was run.";
    return "The run stopped before you answered. Nothing was run.";
  }

  async function upload(files: File[]) {
    for (const file of files) {
      uploading += 1;
      try {
        attachments = [...attachments, await api.upload(project.id, file)];
      } catch (failure) {
        error = `${file.name}: ${failure instanceof ApiError ? failure.message : String(failure)}`;
      } finally {
        uploading -= 1;
      }
    }
  }

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function onKey(event: KeyboardEvent) {
    // Enter that confirms an input method's composition is not a send.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && app.sendWithEnter && !phone) {
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
  <div class="scroller">
    <div
      class="transcript"
      style:padding-inline={phone ? "12px" : "20px"}
      style:padding-bottom={app.pet.enabled ? "54px" : undefined}
    >
      {#if stream?.loaded && items.length === 0}
        <div class="empty">
          <h2>Start the conversation</h2>
          {#if ready}<p>Ask a question or describe what you need.</p>
            <p class="wsitem" title={root}><Icon name="folder" /><span class="ellipsis">{root}</span></p>
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
        <div class="item" in:rise={{ enabled: settled && (item.kind !== "assistant" || item.live) }}>
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
                <Icon name={approval.state === "pending" ? "warn" : "term"} />{(approval.tool === "browser_act"
                  ? browserHeads
                  : heads)[approval.state]}
              </div>
              <code class="mono cmd">{approval.command}</code>
              <p class="why">
                {#if approval.tool === "browser_act"}
                  Browser page <span class="mono">{approval.cwd}</span> · timeout {approval.timeout} s · exact action in the
                  sandboxed project browser. Inspect after any interruption.
                {:else}
                  In <span class="mono">{approval.cwd}</span> · timeout {approval.timeout} s · runs as the Pal host user,
                  not in a sandbox.
                {/if}
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
              {#if item.receipt.executed !== undefined}<p class="small dim">
                  Ran as <code>{item.receipt.executed}</code>; output condensed by rtk.
                </p>{/if}
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
                  <div class="md" {@attach codeCopy}>{@html renderMarkdown(text)}</div>
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
        </div>
      {/each}
    </div>
  </div>

  <div class="dock" style:padding={phone ? "0 12px 10px" : "0 20px 16px"}>
    <div class="dockin">
      {#if app.pet.enabled}
        {#await import("./Pet.svelte") then { default: Pet }}
          <Pet coat={app.pet.coat} running={stream?.running ?? false} active={typing || draft !== ""} />
        {/await}
      {/if}
      {#if !ready}
        <div class="callout wa" role="status">
          {workspace?.error ?? "Preparing this chat's working folder. Messages stay disabled until it is ready."}
          {#if workspace?.state === "provisioning"}<button class="b sm" disabled={preparing} onclick={prepare}
              >{preparing ? "Checking…" : "Check workspace"}</button
            >{/if}
        </div>
      {/if}
      {#if effective === null}
        <div class="callout wa nowrap" role="status">
          <span class="grow"><strong>No model is chosen.</strong> Connect a provider and choose a model to send.</span>
          <button class="b sm" onclick={() => navigate({ view: "settings", tab: "models" })}>Connect</button>
        </div>
      {:else if effective.provider === "openai" && !connected}
        <div class="callout wa nowrap" role="status">
          <span class="grow"><strong>ChatGPT isn't connected.</strong> Messages need your ChatGPT subscription.</span>
          <button class="b sm" onclick={() => navigate({ view: "settings", tab: "models" })}>Connect</button>
        </div>
      {:else if effective !== null && !usable}
        <div class="callout wa nowrap" role="status">
          <span class="grow"
            ><strong>{providerName ?? effective.provider} isn't enabled.</strong> Enable it in Settings or choose another
            model; Pal won't send this chat anywhere else on its own.</span
          >
          <button class="b sm" onclick={() => navigate({ view: "settings", tab: "models" })}>Settings</button>
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
            >{awaiting ? "Waiting for your approval" : "Running"}
            <span class="dim"
              >· {modelName}{providerName !== undefined && effective?.provider !== "openai"
                ? ` · ${providerName}`
                : ""}</span
            ></span
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

      <div class="cbx" class:live={stream?.running}>
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
          onfocus={() => (typing = true)}
          onblur={() => (typing = false)}
          onkeydown={onKey}></textarea>
        <div class="tools">
          <AddMenu onFiles={upload} />
          {#if workspace?.mode !== "read-only"}<CommandMode mode={stream?.mode} onChoose={chooseMode} />{/if}
          <WorkspaceMode {workspace} {onNewChat} compact={phone} />
          <span class="grow"></span>
          <ModelControl
            {groups}
            {effective}
            {current}
            {effort}
            busy={choosing}
            {connected}
            {isDefault}
            {usable}
            compact={phone}
            onModel={(choice) => chooseModel(choice)}
            onEffort={(level) => (current === undefined ? Promise.resolve() : chooseModel(current, level))}
            onDefault={useForNewChats}
          />
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
            <button class="b p send busy" onclick={send} disabled={!canSend}>
              <Icon name={whenBusy === "steer" ? "steer" : "send"} />{whenBusy === "steer" ? "Steer" : "Queue"}
            </button>
          {:else}
            <button class="b p send" aria-label="Send" title="Send" onclick={send} disabled={!canSend}>
              <Icon name="send" size={18} />
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
</section>

<style>
  .appr {
    border: 1px solid var(--waln);
    background: var(--wabg);
    border-radius: 12px;
    padding: 14px 16px;
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
  section {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
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
    max-width: 760px;
    margin: 0 auto;
    padding-top: 28px;
    padding-bottom: 18px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .empty {
    padding: 56px 0 16px;
    color: var(--tx2);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .empty h2 {
    margin: 0 0 4px;
    font-size: 24px;
    color: var(--tx);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .empty p {
    margin: 0;
    max-width: 520px;
  }
  .empty .wsitem {
    max-width: 100%;
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
    background: var(--bubble);
    border: 1px solid var(--bubble-line);
    border-radius: 16px 16px 6px 16px;
    padding: 10px 14px;
    font-size: 15px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* Times stay in the accessible text; on hover-capable screens they appear with the message they belong to. */
  .at {
    font-size: 11.5px;
    color: var(--tx3);
    font-variant-numeric: tabular-nums;
    transition: opacity var(--fast) var(--ease);
  }
  @media (hover: hover) {
    .at {
      opacity: 0;
    }
    .item:hover .at,
    .item:focus-within .at {
      opacity: 1;
    }
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
    border-radius: 12px;
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
    font-size: 15px;
    line-height: 1.65;
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
    margin: 0 0 10px;
  }
  .md :global(:is(h1, h2, h3, h4)) {
    margin: 18px 0 8px;
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: 1.3;
  }
  .md :global(:is(h1, h2)) {
    font-size: 18px;
  }
  .md :global(:is(h3, h4)) {
    font-size: 15.5px;
  }
  .md :global(:first-child) {
    margin-top: 0;
  }
  .md :global(blockquote) {
    margin: 0 0 10px;
    padding-left: 12px;
    border-left: 2px solid var(--line2);
    color: var(--tx2);
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
  .md :global(.code) {
    margin: 0 0 10px;
    background: var(--bg0);
    border: 1px solid var(--line);
    border-radius: 10px;
  }
  /* The header stays in view while a long block scrolls past, so Copy is always one click away. */
  .md :global(.codehead) {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 6px 4px 14px;
    border-bottom: 1px solid var(--line);
    border-radius: 10px 10px 0 0;
    background: var(--bg2);
    color: var(--tx3);
    font-family: var(--mono);
    font-size: 12px;
  }
  .md :global(.codecopy) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--tx2);
    font: 500 12.5px var(--sans);
    cursor: pointer;
    transition:
      background-color var(--fast) var(--ease),
      color var(--fast) var(--ease);
  }
  .md :global(.codecopy:hover) {
    background: var(--bg4);
    color: var(--tx);
  }
  .md :global(.codecopy svg) {
    width: 14px;
    height: 14px;
  }
  .md :global(pre) {
    margin: 0;
    padding: 12px 14px;
    overflow-x: auto;
  }
  .md :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: 13px;
    line-height: 1.6;
    tab-size: 4;
  }
  .md :global(.hl-k) {
    color: var(--syn-k);
  }
  .md :global(.hl-s) {
    color: var(--syn-s);
  }
  .md :global(.hl-n) {
    color: var(--syn-n);
  }
  .md :global(.hl-c) {
    color: var(--syn-c);
    font-style: italic;
  }
  .md :global(.hl-f) {
    color: var(--syn-f);
  }
  .md :global(.hl-t) {
    color: var(--syn-t);
  }
  .md :global(.hl-p) {
    color: var(--syn-p);
  }
  .md :global(.hl-m) {
    color: var(--syn-m);
  }
  .md :global(.hl-a) {
    color: var(--addtx);
    background: var(--addbg);
  }
  .md :global(.hl-d) {
    color: var(--deltx);
    background: var(--delbg);
  }
  .md :global(a),
  .callout a {
    color: var(--ac);
  }
  .dock {
    flex: 0 0 auto;
  }
  .dockin {
    max-width: 760px;
    margin: 0 auto;
    position: relative;
    display: flex;
    flex-direction: column;
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
    padding: 0 2px 0 6px;
    font-size: 13px;
    color: var(--tx);
    animation: rise var(--mid) var(--ease);
  }
  .cbx {
    position: relative;
  }
  /* A blue sheen along the composer's top edge, present only while the agent runs. */
  .cbx.live::before {
    content: "";
    position: absolute;
    top: -1px;
    left: 18px;
    right: 18px;
    height: 2px;
    border-radius: 2px;
    background: linear-gradient(90deg, transparent, var(--ac), transparent) 0 0 / 50% 100% no-repeat;
    animation:
      fade var(--mid) var(--ease),
      sheen 2.8s linear infinite;
  }
  @keyframes sheen {
    from {
      background-position: -100% 0;
    }
    to {
      background-position: 200% 0;
    }
  }
  .queue {
    border: 1px dashed var(--line2);
    border-radius: 12px;
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
  .tools .seg {
    margin-left: 4px;
  }
  .send {
    margin-left: 6px;
    width: 34px;
    height: 34px;
    padding: 0;
    border-radius: 50%;
  }
  .send.busy {
    width: auto;
    padding: 0 12px;
    border-radius: 17px;
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
