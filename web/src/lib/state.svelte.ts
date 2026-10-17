import { api, type ChatGPTState, type Project } from "./api.ts";

export type SettingsTab = "general" | "models" | "mcp";
export type Route = { view: "home" } | { view: "chat"; chatId: string } | { view: "settings"; tab: SettingsTab };

function parseRoute(hash: string): Route {
  const [, view, id] = hash.replace(/^#/, "").split("/");
  if (view === "chat" && id !== undefined && id !== "") return { view: "chat", chatId: id };
  if (view === "settings") return { view: "settings", tab: id === "models" || id === "mcp" ? id : "general" };
  return { view: "home" };
}

export const app = $state({
  hash: location.hash,
  route: parseRoute(location.hash),
  projects: [] as Project[],
  chatgpt: undefined as ChatGPTState | undefined,
  width: window.innerWidth,
  sendWithEnter: readSetting("pal.sendWithEnter") !== "false",
});

addEventListener("hashchange", () => {
  app.hash = location.hash;
  app.route = parseRoute(location.hash);
});
addEventListener("resize", () => (app.width = window.innerWidth));

export function navigate(route: Route): void {
  location.hash =
    route.view === "chat" ? `#/chat/${route.chatId}` : route.view === "settings" ? `#/settings/${route.tab}` : "#/";
}

/** The design's breakpoints: phone below 700px, tablet below 1100px. */
export function viewport(): "phone" | "tablet" | "desktop" {
  return app.width < 700 ? "phone" : app.width < 1100 ? "tablet" : "desktop";
}

export async function refreshProjects(): Promise<void> {
  app.projects = (await api.projects()).projects;
}

export async function refreshChatGPT(): Promise<void> {
  app.chatgpt = await api.chatgpt();
}

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse storage; the setting then lasts for this page only.
  }
}
