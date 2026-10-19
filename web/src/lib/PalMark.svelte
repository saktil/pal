<!-- Pal's mark. `cutout` must match the surface behind it: the visor is drawn in that colour. -->
<script lang="ts">
  let {
    size = 22,
    label = undefined,
    cutout = "var(--side)",
  }: { size?: number; label?: string; cutout?: string } = $props();
  // Eyes get thicker as the mark gets smaller so they stay visible.
  const eye = $derived(size <= 16 ? 5 : size <= 24 ? 4.5 : size <= 40 ? 3.5 : 3);
</script>

<svg
  class="mark"
  viewBox="0 0 64 64"
  width={size}
  height={size}
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
>
  <path
    d="M24 8H44A16 16 0 0 1 60 24V28A16 16 0 0 1 44 44H28V50A8 8 0 0 1 20 58H14A8 8 0 0 1 6 50V26A18 18 0 0 1 24 8Z"
    fill="var(--mark, #d9dce3)"
  />
  <rect x="14" y="16" width="38" height="20" rx="10" fill={cutout} />
  <path
    d="M21.5 28.5a4 4 0 0 1 8 0M36.5 28.5a4 4 0 0 1 8 0"
    fill="none"
    stroke="var(--ac)"
    stroke-width={eye}
    stroke-linecap="round"
  />
</svg>

<style>
  .mark {
    flex: none;
  }
</style>
