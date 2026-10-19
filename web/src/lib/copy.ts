/** The Clipboard API needs a secure context, and Pal is often reached over plain HTTP on a private network. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } finally {
      area.remove();
    }
  }
}

export function codeCopy(node: HTMLElement): () => void {
  async function copy(event: MouseEvent) {
    const button = event.target instanceof Element ? event.target.closest("button[data-copy]") : null;
    const code = button?.closest(".code")?.querySelector("code");
    const label = button?.querySelector("span");
    if (!(button instanceof HTMLButtonElement) || !code || !label) return;
    const copied = await copyText(code.textContent);
    button.focus();
    label.textContent = copied ? "Copied" : "Copy failed";
    setTimeout(() => (label.textContent = "Copy"), 1600);
  }
  const click = (event: MouseEvent) => void copy(event);
  node.addEventListener("click", click);
  return () => node.removeEventListener("click", click);
}
