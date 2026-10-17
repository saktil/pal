<script lang="ts">
  // Placeholder shell until the approved design export is implemented.
  type Health = { status: string; version: string };

  async function loadHealth(): Promise<Health> {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as Health;
  }
</script>

<main>
  <h1>Pal</h1>
  {#await loadHealth()}
    <p>Checking server…</p>
  {:then health}
    <p>Server {health.status} (version {health.version})</p>
  {:catch error}
    <p role="alert">Server unreachable: {error.message}</p>
  {/await}
</main>
