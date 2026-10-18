<script lang="ts">
  import { api, ApiError, type Session } from "../lib/api.ts";
  import { app } from "../lib/state.svelte.ts";

  let { session, onSignedIn }: { session: Session; onSignedIn: () => void } = $props();

  // The setup token arrives in the URL fragment, which the browser never sends to a server.
  const setupToken = $derived(new URLSearchParams(app.hash.replace(/^#/, "")).get("setup") ?? undefined);
  let passphrase = $state("");
  let confirm = $state("");
  let busy = $state(false);
  let error: string | undefined = $state();

  const messages: Record<string, string> = {
    invalid_setup: "This setup link is no longer valid. Use the newest link printed in Pal's terminal.",
    weak_passphrase: "Use at least 12 characters.",
    wrong_passphrase: "That passphrase is not correct.",
    throttled: "Too many attempts. Wait a few minutes, then try again.",
    exists: "This Pal already has an owner. Sign in instead.",
  };

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = undefined;
    if (!session.owner && passphrase !== confirm) {
      error = "The two passphrases differ.";
      return;
    }
    busy = true;
    try {
      if (session.owner) await api.signIn(passphrase);
      else await api.setup(setupToken ?? "", passphrase);
      history.replaceState(null, "", location.pathname);
      onSignedIn();
    } catch (failure) {
      error = failure instanceof ApiError ? (messages[failure.code] ?? failure.message) : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<div class="gate">
  {#if !session.owner && setupToken === undefined}
    <div class="card">
      <h1>Pal isn't set up yet</h1>
      <p>
        Open the setup link printed in the terminal where <code class="code">pal</code> is running. Only someone who can see
        that terminal can claim this Pal.
      </p>
    </div>
  {:else}
    <form class="card" onsubmit={submit}>
      <h1>{session.owner ? "Sign in to Pal" : "Set up Pal"}</h1>
      <p>
        {session.owner
          ? "Enter the owner's passphrase."
          : "Choose a passphrase for this Pal. You'll use it to sign in from any browser."}
      </p>
      <label class="fl">
        Passphrase
        <input
          class="f"
          type="password"
          autocomplete={session.owner ? "current-password" : "new-password"}
          bind:value={passphrase}
          required
        />
      </label>
      {#if !session.owner}
        <label class="fl">
          Confirm passphrase
          <input class="f" type="password" autocomplete="new-password" bind:value={confirm} required />
        </label>
      {/if}
      {#if error !== undefined}<div class="callout er" role="alert">{error}</div>{/if}
      <button class="b p" type="submit" disabled={busy || passphrase === ""}
        >{session.owner ? "Sign in" : "Create owner"}</button
      >
    </form>
  {/if}
</div>

<style>
  .gate {
    height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
    background: var(--bg1);
  }
  .card {
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: stretch;
  }
  h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 750;
    letter-spacing: -0.02em;
  }
  p {
    margin: 0 0 6px;
    color: var(--tx2);
  }
  /* Stacked fields; the shared field style is meant for wrapping rows. */
  .fl {
    flex: none;
  }
  .b.p {
    align-self: flex-start;
  }
</style>
