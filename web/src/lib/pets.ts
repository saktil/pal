/** Bundled pets: pixel art drawn as data, with no code, network or model access of their own. */
export type Coat = { readonly name: string; readonly colors: Readonly<Record<Ink, string>> };
type Ink = "b" | "s" | "w" | "e" | "p" | "z";
/** Rows of one 15x12 sprite layer: `.` is empty, every other letter is an ink. */
type Layer = readonly string[];

const SIT: Layer = [
  "",
  ".s.......s",
  ".sp.....ps",
  ".bbbbbbbbb",
  ".bbbbbbbbb",
  ".bbbbbbbbb",
  ".bbbbpbbbb",
  "..bbbbbbb",
  "..bbwwwbb",
  ".bbbwwwbbb",
  ".bbbwwwbbb",
  ".bwbbbbbwb",
];
const EYES_OPEN: Layer = ["", "", "", "", "", "...e...e", "...e...e"];
const EYES_SHUT: Layer = ["", "", "", "", "", "", "..ss...ss"];
const TAIL_DOWN: Layer = ["", "", "", "", "", "", "", "", "", "..........s", "..........bs", "..........bbbs"];
const TAIL_UP: Layer = [
  "",
  "",
  "",
  "",
  "",
  "",
  ".............s",
  "............bs",
  "............b",
  "...........bb",
  "..........bb",
  "..........b",
];
const NAP: Layer = [
  "",
  "",
  "",
  "............zzz",
  ".............z",
  ".s.......s..zzz",
  ".sp.....ps",
  ".bbbbbbbbbbb",
  ".bssbbbssbbbb",
  "bbbbbpbbbbbbbs",
  "bbwwwwwbbbbbbbs",
  ".bbbbbbbbbbbss",
];

export const PETS = {
  cat: {
    name: "Cat",
    size: { width: 15, height: 12 },
    layers: { sit: SIT, eyesOpen: EYES_OPEN, eyesShut: EYES_SHUT, tailDown: TAIL_DOWN, tailUp: TAIL_UP, nap: NAP },
    coats: {
      ginger: {
        name: "Ginger",
        colors: { b: "#f0a04b", s: "#b9662a", w: "#ffe6c7", e: "#1b2033", p: "#ff9aae", z: "#a1a1aa" },
      },
      tuxedo: {
        name: "Tuxedo",
        colors: { b: "#4a5369", s: "#2b3142", w: "#f2f4f8", e: "#9de6b8", p: "#ff9aae", z: "#a1a1aa" },
      },
      silver: {
        name: "Silver tabby",
        colors: { b: "#aab3c5", s: "#6c768c", w: "#eef1f6", e: "#1a2236", p: "#ffb3c1", z: "#a1a1aa" },
      },
    } satisfies Record<string, Coat>,
  },
} as const;

export type PetId = keyof typeof PETS;
export type CoatId = keyof (typeof PETS)["cat"]["coats"];
export type PetLayer = keyof (typeof PETS)["cat"]["layers"];

/** One rectangle per run of same-ink pixels in a row, so a sprite stays a few dozen SVG nodes. */
export function pixels(layer: Layer): { x: number; y: number; width: number; ink: Ink }[] {
  return layer.flatMap((row, y) =>
    [...row.matchAll(/([^.])\1*/g)].map((run) => ({ x: run.index, y, width: run[0].length, ink: run[1] as Ink })),
  );
}
