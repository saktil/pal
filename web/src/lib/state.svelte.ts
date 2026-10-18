import { api, type ChatGPTState, type ExtensionView, type Project, type ProvidersState } from "./api.ts";

export type SettingsTab = "general" | "models" | "mcp" | "extensions";
export type Route = { view: "home" } | { view: "chat"; chatId: string } | { view: "settings"; tab: SettingsTab };

function parseRoute(hash: string): Route {
  const [, view, id] = hash.replace(/^#/, "").split("/");
  if (view === "chat" && id !== undefined && id !== "") return { view: "chat", chatId: id };
  if (view === "settings")
    return { view: "settings", tab: id === "models" || id === "mcp" || id === "extensions" ? id : "general" };
  return { view: "home" };
}

export const app = $state({
  hash: location.hash,
  route: parseRoute(location.hash),
  projects: [] as Project[],
  chatgpt: undefined as ChatGPTState | undefined,
  providers: undefined as ProvidersState | undefined,
  extensions: undefined as ExtensionView | undefined,
  width: window.innerWidth,
  sendWithEnter: readSetting("pal.sendWithEnter") !== "false",
  pet: { enabled: readSetting("pal.pet") !== "off", coat: readSetting("pal.petCoat") ?? "silver" },
  theme: themeSetting(readSetting("pal.theme")),
  systemLight: matchMedia("(prefers-color-scheme: light)").matches,
});

/** Dark is Pal's default; System follows the device. Saved per browser. */
export type Theme = "dark" | "light" | "system";
function themeSetting(value: string | null): Theme {
  return value === "light" || value === "system" ? value : "dark";
}
matchMedia("(prefers-color-scheme: light)").addEventListener("change", (event) => (app.systemLight = event.matches));
export function shownTheme(): "dark" | "light" {
  if (app.theme !== "system") return app.theme;
  return app.systemLight ? "light" : "dark";
}
export function chooseTheme(theme: Theme): void {
  app.theme = theme;
  saveSetting("pal.theme", theme);
}

/** The composer pet is a per-browser choice: it changes nothing on the server or in any chat. */
export type PetChoice = { enabled: boolean; coat: string };

export function choosePet(choice: PetChoice): void {
  app.pet = choice;
  saveSetting("pal.pet", choice.enabled ? "on" : "off");
  saveSetting("pal.petCoat", choice.coat);
}

addEventListener("hashchange", () => {
  app.hash = location.hash;
  app.route = parseRoute(location.hash);
});
addEventListener("resize", () => (app.width = window.innerWidth));

export function navigate(route: Route): void {
  let hash = "#/";
  if (route.view === "chat") hash = `#/chat/${route.chatId}`;
  else if (route.view === "settings") hash = `#/settings/${route.tab}`;
  location.hash = hash;
}

/** The design's breakpoints: phone below 700px, tablet below 1100px. */
export function viewport(): "phone" | "tablet" | "desktop" {
  if (app.width < 700) return "phone";
  if (app.width < 1100) return "tablet";
  return "desktop";
}

export async function refreshProjects(): Promise<void> {
  app.projects = (await api.projects()).projects;
}

export async function refreshChatGPT(): Promise<void> {
  app.chatgpt = await api.chatgpt();
}

export async function refreshProviders(): Promise<void> {
  app.providers = await api.providers();
}

export async function refreshExtensions(): Promise<void> {
  app.extensions = await api.extensions();
}

export function readSetting(key: string): string | null {
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
