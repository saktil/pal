// Typed calls to Pal's API. Shapes mirror src/core/api.ts responses.

export type Session = { owner: boolean; signedIn: boolean };

export type ChatGPTModel = { slug: string; displayName: string; supported: boolean };
export type SignInState = "waiting" | "verifying" | "connected" | "failed" | "cancelled";
export type ChatGPTState = {
  account: { accountId: string; email?: string } | null;
  attempt: { state: SignInState; authUrl: string | null; error: { code: string; message: string } | null } | null;
  models: ChatGPTModel[];
  modelsError: string | null;
  model: string | null;
};

export type ChatSummary = { id: string; projectId: string; title: string | null; createdAt: number };
export type Project = {
  id: string;
  name: string;
  mode: "managed" | "existing";
  state: "provisioning" | "ready" | "failed";
  root: string;
  error?: string;
  createdAt: number;
  chats: ChatSummary[];
};
export type FolderListing = {
  path: string;
  parent?: string;
  entries: { name: string; path: string; git: boolean }[];
  truncated: boolean;
  problem?: "denied" | "missing" | "not_directory";
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Called when the server says the owner's session ended, so the app can show sign-in again. */
export const signedOut = new EventTarget();

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    cache: "no-store",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!response.ok) {
    if (response.status === 401 && data.error === "signed_out") signedOut.dispatchEvent(new Event("signed-out"));
    throw new ApiError(response.status, data.error ?? "error", data.message ?? `HTTP ${response.status}`);
  }
  return data as T;
}

/** A fresh idempotency key: retrying the same request reuses it, so the server admits it once. */
export const requestId = (): string => crypto.randomUUID();

export const api = {
  session: () => call<Session>("GET", "session"),
  setup: (token: string, passphrase: string) => call<{ signedIn: true }>("POST", "setup", { token, passphrase }),
  signIn: (passphrase: string) => call<{ signedIn: true }>("POST", "sign-in", { passphrase }),
  signOut: () => call<{ signedIn: false }>("POST", "sign-out"),

  chatgpt: () => call<ChatGPTState>("GET", "chatgpt"),
  chatgptSignIn: () => call<ChatGPTState>("POST", "chatgpt/sign-in"),
  chatgptPaste: (url: string) => call<ChatGPTState>("POST", "chatgpt/sign-in/paste", { url }),
  chatgptCancel: () => call<ChatGPTState>("DELETE", "chatgpt/sign-in"),
  chatgptSignOut: () => call<ChatGPTState>("POST", "chatgpt/sign-out"),
  setDefaultModel: (model: string) => call<ChatGPTState>("PUT", "chatgpt/model", { model }),

  projects: () => call<{ projects: Project[] }>("GET", "projects"),
  createProject: (key: string, name: string, folder?: string) =>
    call<{ project: Project }>("POST", "projects", {
      requestId: key,
      name,
      ...(folder === undefined ? {} : { folder }),
    }),
  folders: (path?: string) =>
    call<FolderListing>("GET", `folders${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`),

  createChat: (key: string, projectId: string) =>
    call<{ chat: ChatSummary }>("POST", "chats", { requestId: key, projectId }),
  chat: (id: string) => call<{ chat: ChatSummary; model: string | null }>("GET", `chats/${id}`),
  send: (id: string, key: string, text: string, whenBusy: "followUp" | "steer") =>
    call<{ admission: { submissionId: number } }>("POST", `chats/${id}/inputs`, { requestId: key, text, whenBusy }),
  stop: (id: string) => call<{ stopped: true }>("POST", `chats/${id}/stop`),
  setChatModel: (id: string, model: string) => call<{ model: string }>("PUT", `chats/${id}/model`, { model }),
};
