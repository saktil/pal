import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "playwright-core";
import { type Static, Type } from "typebox";

export const BrowserAction = Type.Union([
  Type.Object(
    { type: Type.Literal("navigate"), url: Type.String({ maxLength: 4096 }) },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal("click"), target: Type.String({ maxLength: 16 }) }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal("type"), target: Type.String({ maxLength: 16 }), text: Type.String({ maxLength: 2000 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("key"), key: Type.Enum(["Enter", "Tab", "Escape", "PageDown", "PageUp"]) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("scroll"), dy: Type.Integer({ minimum: -1000, maximum: 1000 }) },
    { additionalProperties: false },
  ),
]);
export const BrowserActionBody = Type.Object(
  {
    session: Type.String({ maxLength: 64 }),
    epoch: Type.Integer(),
    observation: Type.String({ maxLength: 64 }),
    action: BrowserAction,
  },
  { additionalProperties: false },
);
export type BrowserActionInput = Static<typeof BrowserActionBody>;
export type PageObservation = {
  text: string;
  title: string;
  login: boolean;
  truncated: boolean;
  targets: { id: string; kind: string; label: string }[];
};

/** Static inspection in an isolated world: page scripts cannot replace its DOM/string primitives. No input values. */
function inspectPage(input: { id: string; read: boolean }): PageObservation {
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility === "visible" &&
      style.display !== "none" &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    );
  };
  const signature = (element: Element) =>
    JSON.stringify([
      element.tagName,
      element.getAttribute("type"),
      element.getAttribute("role"),
      element.getAttribute("aria-label"),
      element.getAttribute("href"),
      (element.textContent ?? "").slice(0, 120),
    ]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  const targets: { element: HTMLElement; signature: string }[] = [];
  const shown: PageObservation["targets"] = [];
  let count = 0,
    login = false,
    truncated = false;
  while (walker.nextNode()) {
    if (++count > 5000) {
      truncated = true;
      break;
    }
    const element = walker.currentNode as HTMLElement;
    if (!visible(element)) continue;
    if (
      element instanceof HTMLInputElement &&
      (element.type === "password" ||
        /(?:^|\s)(?:username|current-password|new-password|one-time-code)(?:\s|$)/.test(element.autocomplete))
    )
      login = true;
    if (!input.read) continue;
    const box = element.getBoundingClientRect();
    if (targets.length >= 40 || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth)
      continue;
    if (!element.matches("a[href],button,input:not([type=hidden]),textarea,select,[role=button]")) continue;
    const kind = element.tagName.toLowerCase();
    const label = (
      element.getAttribute("aria-label") ??
      element.getAttribute("placeholder") ??
      (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.getAttribute("name")
        : element.innerText) ??
      ""
    ).slice(0, 120);
    shown.push({ id: `t${targets.length}`, kind, label });
    targets.push({ element, signature: signature(element) });
  }
  // Private pages never produce a model-visible observation, including their labels or surrounding text.
  if (login || truncated || !input.read) return { text: "", title: "", login, truncated, targets: [] };
  const texts = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let text = "",
    nodes = 0;
  while (texts.nextNode() && text.length < 8000 && ++nodes <= 5000) {
    const parent = texts.currentNode.parentElement;
    if (
      parent === null ||
      parent.closest("input,textarea,select,script,style,noscript,[hidden]") !== null ||
      !visible(parent)
    )
      continue;
    const box = parent.getBoundingClientRect();
    if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) continue;
    const part = (texts.currentNode.textContent ?? "").slice(0, 8000 - text.length).trim();
    if (part !== "") text += `${part}\n`;
  }
  const store = globalThis as typeof globalThis & {
    __palView?: { id: string; targets: typeof targets; signature: typeof signature };
  };
  store.__palView = { id: input.id, targets, signature };
  return { text: text.slice(0, 8000), title: document.title.slice(0, 200), login, truncated, targets: shown };
}

/** Only opaque, freshly inspected elements can be acted on; arbitrary selectors and JavaScript are not accepted. */
function actOnPage(input: { observation: string; action: Static<typeof BrowserAction> }): boolean {
  const store = (
    globalThis as typeof globalThis & {
      __palView?: {
        id: string;
        targets: { element: HTMLElement; signature: string }[];
        signature: (element: Element) => string;
      };
    }
  ).__palView;
  if (store?.id !== input.observation) throw new Error("stale observation");
  // The page can add a login form after the asynchronous preflight but before this DOM action.
  if (
    document.querySelector(
      'input[type="password" i],input[autocomplete~="username" i],input[autocomplete~="current-password" i],input[autocomplete~="new-password" i],input[autocomplete~="one-time-code" i]',
    ) !== null
  )
    throw new Error("private page");
  if (input.action.type !== "click" && input.action.type !== "type") return false;
  const index = /^t(\d+)$/.exec(input.action.target)?.[1];
  const target = index === undefined ? undefined : store.targets[Number(index)];
  if (target === undefined || !target.element.isConnected || store.signature(target.element) !== target.signature)
    throw new Error("target changed");
  const element = target.element;
  const style = getComputedStyle(element),
    box = element.getBoundingClientRect();
  if (style.visibility !== "visible" || style.display === "none" || box.width <= 0 || box.height <= 0)
    throw new Error("target hidden");
  if (
    element instanceof HTMLInputElement &&
    (element.type === "password" || /username|password|one-time-code/.test(element.autocomplete))
  )
    throw new Error("private input");
  if (input.action.type === "click") HTMLElement.prototype.click.call(element);
  else {
    let prototype;
    if (element instanceof HTMLInputElement) prototype = HTMLInputElement.prototype;
    else if (element instanceof HTMLTextAreaElement) prototype = HTMLTextAreaElement.prototype;
    if (prototype === undefined) throw new Error("not a text input");
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, input.action.text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return true;
}

/** Bounded, text-only model access. The owner viewport is a separate channel and is never captured here. */
export class BrowserPage {
  readonly #page: Page;
  #client: CDPSession | undefined;
  #current: { id: string; url: string; at: number; result: PageObservation } | undefined;
  constructor(page: Page) {
    this.#page = page;
  }

  async #evaluate<T>(fn: (...args: never[]) => unknown, argument: unknown, guard: () => void = () => {}): Promise<T> {
    this.#client ??= await this.#page.context().newCDPSession(this.#page);
    guard();
    const { frameTree } = await this.#client.send("Page.getFrameTree");
    guard();
    const { executionContextId } = await this.#client.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "pal-inspection",
    });
    guard();
    const response = await this.#client.send("Runtime.evaluate", {
      expression: `(${fn.toString()})(${JSON.stringify(argument)})`,
      contextId: executionContextId,
      returnByValue: true,
      awaitPromise: false,
      userGesture: true,
      timeout: 2000,
    });
    guard();
    if (response.exceptionDetails !== undefined)
      throw new Error("page inspection/action failed; inspect the page before retrying");
    return response.result.value as T;
  }

  async observe(guard: () => void = () => {}): Promise<PageObservation & { observation: string }> {
    const id = randomUUID(),
      url = this.#page.url();
    const result = await this.#evaluate<PageObservation>(inspectPage, { id, read: true }, guard);
    if (url !== this.#page.url()) throw new Error("page changed during inspection");
    this.#current = result.login || result.truncated ? undefined : { id, url, at: Date.now(), result };
    return { ...result, observation: id };
  }

  async privatePage(guard: () => void = () => {}): Promise<boolean> {
    const result = await this.#evaluate<PageObservation>(inspectPage, { id: "", read: false }, guard);
    return result.login || result.truncated;
  }

  current(id: string): PageObservation {
    const current = this.#current;
    if (
      current === undefined ||
      id !== current.id ||
      current.url !== this.#page.url() ||
      Date.now() - current.at > 120_000
    )
      throw new Error("the browser observation expired or changed; inspect again");
    return current.result;
  }

  async act(input: BrowserActionInput, guard: () => void): Promise<void> {
    this.current(input.observation);
    if (await this.privatePage(guard)) throw new Error("private or unsupported page; use the owner viewport");
    guard();
    try {
      if (input.action.type === "click" || input.action.type === "type") await this.#evaluate(actOnPage, input, guard);
      else if (input.action.type === "navigate")
        await this.#page.goto(input.action.url, { waitUntil: "commit", timeout: 10_000 });
      else if (input.action.type === "key") await this.#page.keyboard.press(input.action.key);
      else await this.#page.mouse.wheel(0, input.action.dy);
      guard();
    } finally {
      this.#current = undefined;
    }
  }
}
