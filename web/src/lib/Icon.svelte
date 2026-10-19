<script lang="ts">
  import { ICONS, type IconName } from "./icons.ts";

  let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg class="i" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path d={ICONS[name]} /></svg>
