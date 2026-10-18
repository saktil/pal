import { cubicOut } from "svelte/easing";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");

/** Entrance for content that arrives while the owner is watching; instant when off or motion is reduced. */
export function rise(_node: Element, { enabled }: { enabled: boolean }) {
  if (!enabled || reduced.matches) return { duration: 0 };
  return {
    duration: 220,
    easing: cubicOut,
    css: (t: number) => `opacity: ${t}; transform: translateY(${(1 - t) * 6}px)`,
  };
}
