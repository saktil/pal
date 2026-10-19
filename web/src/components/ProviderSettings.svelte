<script lang="ts">
  import { app } from "../lib/state.svelte.ts";
  import ProviderConnection from "./ProviderConnection.svelte";
</script>

<h3 class="h3">API keys and endpoints</h3>
<p class="setd">
  Use your own API keys or endpoint. Each stays off until you enable it, and Pal never switches a chat to it or falls
  back to it on its own. Keys are stored encrypted on this server and never shown again.
</p>
{#each app.providers?.providers ?? [] as provider (provider.id)}
  <ProviderConnection {provider} />
{/each}
