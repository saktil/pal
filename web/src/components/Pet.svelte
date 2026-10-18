<script lang="ts">
  import { type CoatId, PETS, type PetLayer, pixels } from "../lib/pets.ts";

  let { coat, running, active }: { coat: string; running: boolean; active: boolean } = $props();
  const pet = PETS.cat;
  const SCALE = 3;
  /** A coat saved by another version of Pal falls back to the first bundled one. */
  const colors = $derived((pet.coats[coat as CoatId] ?? pet.coats.ginger).colors);
  /** Naps after half a minute with no run and no composer use; either wakes it. */
  let napping = $state(false);
  $effect(() => {
    if (running || active) {
      napping = false;
      return;
    }
    const timer = setTimeout(() => (napping = true), 30_000);
    return () => clearTimeout(timer);
  });
</script>

{#snippet layer(name: PetLayer, kind: string)}
  <g class={kind}>
    {#each pixels(pet.layers[name]) as run (`${run.x},${run.y}`)}
      <rect x={run.x} y={run.y} width={run.width} height="1" fill={colors[run.ink]} />
    {/each}
  </g>
{/snippet}

<!-- Decorative only: invisible to assistive technology and to the pointer, so it never takes input. -->
<div class="pet" class:running class:napping data-coat={coat} aria-hidden="true">
  <svg
    viewBox={`0 0 ${pet.size.width} ${pet.size.height}`}
    width={pet.size.width * SCALE}
    height={pet.size.height * SCALE}
    shape-rendering="crispEdges"
  >
    {#if napping}
      {@render layer("nap", "nap")}
    {:else}
      {@render layer("sit", "body")}
      {@render layer("tailDown", "tail down")}
      {@render layer("tailUp", "tail up")}
      {@render layer("eyesOpen", "eyes open")}
      {@render layer("eyesShut", "eyes shut")}
    {/if}
  </svg>
</div>

<style>
  /* Perched on the top edge of the composer dock; during a run it steps aside so Stop stays clear. */
  .pet {
    position: absolute;
    right: 22px;
    bottom: calc(100% - 1px);
    z-index: 1;
    pointer-events: none;
    line-height: 0;
    animation: fade var(--mid) var(--ease);
    transition: right 0.5s steps(5, end);
  }
  .pet.running {
    right: 112px;
  }
  svg {
    display: block;
  }
  .up,
  .shut {
    opacity: 0;
  }
  /* Awake: an occasional blink. Running: the tail flicks in two-frame steps until the run ends. */
  .open {
    animation: blink 7s steps(1, end) infinite;
  }
  .shut {
    animation: blink-shut 7s steps(1, end) infinite;
  }
  .running .down {
    animation: flick 0.9s steps(1, end) infinite;
  }
  .running .up {
    animation: flick-up 0.9s steps(1, end) infinite;
  }
  .running svg {
    animation: hop 0.36s steps(3, end) 1;
  }
  .nap {
    animation: fade 0.6s var(--ease);
  }
  @keyframes blink {
    0%,
    96% {
      opacity: 1;
    }
    97%,
    100% {
      opacity: 0;
    }
  }
  @keyframes blink-shut {
    0%,
    96% {
      opacity: 0;
    }
    97%,
    100% {
      opacity: 1;
    }
  }
  @keyframes flick {
    0%,
    49% {
      opacity: 1;
    }
    50%,
    100% {
      opacity: 0;
    }
  }
  @keyframes flick-up {
    0%,
    49% {
      opacity: 0;
    }
    50%,
    100% {
      opacity: 1;
    }
  }
  @keyframes hop {
    50% {
      transform: translateY(-6px);
    }
  }
</style>
