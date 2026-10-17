import { createHash } from "node:crypto";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { HttpError } from "./http.ts";
import { validate } from "./requests.ts";

export const McpGrantBody = Type.Object(
  {
    revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    mode: Type.Enum(["inherit", "subset"]),
    tools: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 128, uniqueItems: true }),
  },
  { additionalProperties: false },
);

/** Pure catalog data: no credential values, connection handles or project contents. */
export type GrantServer = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  authority: number;
  tools: readonly { name: string; description: string; approved: boolean; changed: boolean; fingerprint: string }[];
};
type GrantRow = { server_id: string; version: number; policy: string | null };
type Policy = { authority: number; tools: Record<string, string> };
export type ProjectMcpServer = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  mode: "inherit" | "subset";
  revision: string;
  authorityStale: boolean;
  tools: {
    name: string;
    description: string;
    approved: boolean;
    changed: boolean;
    selected: boolean;
    stale: boolean;
    allowed: boolean;
  }[];
};
export type ProjectMcp = { servers: ProjectMcpServer[] };

/** A project may follow owner defaults or narrow exact approved definitions, never widen them. */
export class McpGrants {
  readonly #database: SqliteDatabase;
  readonly #catalog: () => GrantServer[];
  readonly #changed: (projectId: string, serverId: string) => void;
  constructor(
    database: SqliteDatabase,
    catalog: () => GrantServer[],
    changed: (project: string, server: string) => void,
  ) {
    this.#database = database;
    this.#catalog = catalog;
    this.#changed = changed;
  }
  async #ready(db: SqliteExecutor, project: string): Promise<boolean> {
    return (
      (await db.get("SELECT 1 FROM pal_projects WHERE id = ? AND state = 'ready' AND removed_at IS NULL", project)) !==
      undefined
    );
  }
  async view(project: string): Promise<ProjectMcp> {
    if (!(await this.#ready(this.#database, project))) throw new HttpError(404, "not_found", "no such ready project");
    const rows = await this.#database.all<GrantRow>(
      "SELECT server_id, version, policy FROM pal_mcp_project_grants WHERE project_id = ?",
      project,
    );
    return {
      servers: this.#catalog().map((server) =>
        this.#view(
          server,
          rows.find((row) => row.server_id === server.id),
        ),
      ),
    };
  }
  #view(server: GrantServer, row: GrantRow | undefined): ProjectMcpServer {
    const policy = row?.policy == null ? undefined : (JSON.parse(row.policy) as Policy);
    const authorityStale = policy !== undefined && policy.authority !== server.authority;
    const names = [...new Set([...server.tools.map((tool) => tool.name), ...Object.keys(policy?.tools ?? {})])];
    return {
      id: server.id,
      name: server.name,
      url: server.url,
      enabled: server.enabled,
      mode: policy === undefined ? "inherit" : "subset",
      authorityStale,
      revision: revision(server, row),
      tools: names.map((name) => {
        const tool = server.tools.find((tool) => tool.name === name);
        const approved = tool?.approved ?? false,
          changed = tool?.changed ?? true;
        const selected = policy === undefined ? approved : Object.hasOwn(policy.tools, name);
        const stale = policy !== undefined && selected && (authorityStale || policy.tools[name] !== tool?.fingerprint);
        return {
          name,
          description: tool?.description ?? "No longer in the owner-approved catalog",
          approved,
          changed,
          selected,
          stale,
          allowed: server.enabled && approved && !changed && selected && !stale,
        };
      }),
    };
  }
  async decision(project: string, serverId: string, remote: string): Promise<{ allowed: boolean; revision: string }> {
    if (!(await this.#ready(this.#database, project))) return { allowed: false, revision: "" };
    const row = await this.#database.get<GrantRow>(
      "SELECT server_id, version, policy FROM pal_mcp_project_grants WHERE project_id = ? AND server_id = ?",
      project,
      serverId,
    );
    const server = this.#catalog().find((server) => server.id === serverId);
    if (server === undefined) return { allowed: false, revision: "" };
    const view = this.#view(server, row);
    return { allowed: view.tools.some((tool) => tool.name === remote && tool.allowed), revision: view.revision };
  }
  async set(project: string, serverId: string, input: unknown): Promise<ProjectMcp> {
    const body = validate(McpGrantBody, input);
    await this.#database.transaction(async (tx) => {
      if (!(await this.#ready(tx, project))) throw new HttpError(404, "not_found", "no such ready project");
      const row = await tx.get<GrantRow>(
        "SELECT server_id, version, policy FROM pal_mcp_project_grants WHERE project_id = ? AND server_id = ?",
        project,
        serverId,
      );
      const server = this.#catalog().find((server) => server.id === serverId);
      if (server === undefined) throw new HttpError(404, "not_found", "no such MCP server");
      if (revision(server, row) !== body.revision)
        throw new HttpError(409, "mcp_grant_stale", "Permissions or tool definitions changed. Refresh before saving.");
      if (body.mode === "inherit" && body.tools.length !== 0)
        throw new HttpError(400, "invalid_request", "inherited permissions do not take a tool selection");
      const tools = Object.fromEntries(
        body.tools.map((name) => {
          const tool = server.tools.find((tool) => tool.name === name && tool.approved && !tool.changed);
          if (tool === undefined)
            throw new HttpError(400, "mcp_grant_widening", "projects may select only currently owner-approved tools");
          return [name, tool.fingerprint];
        }),
      );
      const policy = body.mode === "inherit" ? null : JSON.stringify({ authority: server.authority, tools });
      await tx.run(
        "INSERT INTO pal_mcp_project_grants (project_id, server_id, version, policy) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, server_id) DO UPDATE SET version = excluded.version, policy = excluded.policy",
        project,
        serverId,
        (row?.version ?? 0) + 1,
        policy,
      );
    });
    this.#changed(project, serverId);
    return this.view(project);
  }
}

function revision(server: GrantServer, row: GrantRow | undefined): string {
  const tools = server.tools
    .flatMap((tool) => (tool.approved ? [[tool.name, tool.fingerprint, tool.approved, tool.changed]] : []))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash("sha256")
    .update(
      JSON.stringify([server.id, server.authority, server.enabled, tools, row?.version ?? 0, row?.policy ?? null]),
    )
    .digest("hex");
}
