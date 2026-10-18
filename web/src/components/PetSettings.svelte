<script lang="ts">
  import { type CoatId, PETS, pixels } from "../lib/pets.ts";
  import { app, choosePet } from "../lib/state.svelte.ts";

  const pet = PETS.cat;
  const coats = Object.entries(pet.coats) as [CoatId, (typeof pet.coats)[CoatId]][];
  const sprite = [pet.layers.sit, pet.layers.eyesOpen, pet.layers.tailDown].flatMap(pixels);
</script>

<section class="pet-settings" aria-labelledby="pet-title">
  <div class="extension">
    <div class="details">
      <div class="heading">
        <strong id="pet-title">Composer pet</strong><span class="mono dim">v1</span><span class="pill"
          >Built-in · interface only</span
        >
      </div>
      <p>
        A small pixel cat on the composer. It naps when Pal is idle and flicks its tail while a run works. No tools,
        permissions, network or model requests.
      </p>
      <div class="fine">Saved in this browser only. Off unloads it.</div>
    </div>
    <label class="choice">
      <span>Show</span>
      <input
        class="swi"
        type="checkbox"
        role="switch"
        aria-label="Show the pet on the composer"
        checked={app.pet.enabled}
        onchange={(event) => choosePet({ ...app.pet, enabled: event.currentTarget.checked })}
      />
    </label>
  </div>
  <div class="coats" role="radiogroup" aria-label="Pet coat">
    {#each coats as [id, coat] (id)}
      <label class="coat" class:on={app.pet.coat === id}>
        <input
          type="radio"
          name="pet-coat"
          value={id}
          checked={app.pet.coat === id}
          disabled={!app.pet.enabled}
          onchange={() => choosePet({ ...app.pet, coat: id })}
        />
        <svg
          viewBox={`0 0 ${pet.size.width} ${pet.size.height}`}
          width={pet.size.width * 3}
          height={pet.size.height * 3}
          shape-rendering="crispEdges"
          aria-hidden="true"
        >
          {#each sprite as run (`${run.x},${run.y},${run.ink}`)}
            <rect x={run.x} y={run.y} width={run.width} height="1" fill={coat.colors[run.ink]} />
          {/each}
        </svg>
        <span>{coat.name}</span>
      </label>
    {/each}
  </div>
</section>

<style>
  .extension {
    display: flex;
    gap: 16px;
    padding: 14px 0 10px;
    flex-wrap: wrap;
  }
  .details {
    flex: 1 1 300px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .heading {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  p {
    margin: 0;
    font-size: 13px;
    color: var(--tx2);
  }
  .fine {
    font-size: 12.5px;
    color: var(--tx3);
  }
  .dim {
    color: var(--tx3);
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--tx2);
  }
  .coats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--line);
  }
  .coat {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px 8px 10px;
    border: 1px solid var(--line2);
    border-radius: 12px;
    background: var(--bg1);
    font-size: 13px;
    cursor: pointer;
    transition:
      border-color var(--fast) var(--ease),
      background-color var(--fast) var(--ease);
  }
  .coat.on {
    border-color: var(--acln);
    background: var(--acbg);
  }
  .coat:has(input:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
