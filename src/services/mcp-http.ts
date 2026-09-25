// =====================================================================
// MCP over HTTP — talking to a user-configured server
// ---------------------------------------------------------------------
// The request itself goes through the Rust `mcp_http_rpc` command, not the
// WebView: third-party MCP servers are built for CLI clients and have no reason
// to send CORS headers, and the bearer token stays out of the WebView.
//
// Everything below the transport is pure and tested: envelope parsing has to
// cope with both a plain JSON body and a Streamable-HTTP SSE stream, since the
// spec lets a server answer either way for the same request.
// =====================================================================

import { invoke } from "@tauri-apps/api/core";
import type { McpToolInfo } from "./context-slots";

/** Matches the version our own MCP server offers (server/ai-proxy/mcp.ts). */
export const CLIENT_PROTOCOL_VERSION = "2025-06-18";

/** The parsed shape the pure functions below work with. */
export interface McpHttpRaw {
  status: number;
  contentType: string;
  body: string;
  sessionId: string | null;
}

/**
 * What the Rust command actually returns.
 *
 * serde serialises struct fields as-is and Tauri does NOT camel-case return
 * values (it only converts command ARGUMENTS), so these arrive snake_cased —
 * the same convention the rest of the app already reads from Rust (`site_name`,
 * `gcs_uri`). Reading `contentType` off this object yields undefined, which is
 * exactly how the first build failed: `t.contentType.includes` threw before any
 * request could be judged.
 */
interface McpHttpWire {
  status?: number;
  content_type?: string;
  body?: string;
  session_id?: string | null;
}

export function fromWire(wire: McpHttpWire | null | undefined): McpHttpRaw {
  return {
    status: typeof wire?.status === "number" ? wire.status : 0,
    contentType:
      typeof wire?.content_type === "string" ? wire.content_type : "",
    body: typeof wire?.body === "string" ? wire.body : "",
    sessionId: typeof wire?.session_id === "string" ? wire.session_id : null,
  };
}

// ---------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------

export interface RpcOk {
  ok: true;
  result: Record<string, unknown>;
}
export interface RpcFail {
  ok: false;
  /** Stable code for the UI to branch on. */
  code:
    "auth" | "not_found" | "redirect" | "http" | "rpc" | "malformed" | "empty";
  /** One line, written for the person who has to fix it. */
  message: string;
}
export type RpcOutcome = RpcOk | RpcFail;

/** Pull JSON-RPC messages out of an SSE stream (`data:` lines). */
export function parseSseMessages(body: string): unknown[] {
  const out: unknown[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // A partial or non-JSON data line is not fatal — later ones may parse.
    }
  }
  return out;
}

function messagesFrom(raw: McpHttpRaw): unknown[] {
  if ((raw.contentType ?? "").includes("text/event-stream"))
    return parseSseMessages(raw.body);
  try {
    const parsed = JSON.parse(raw.body);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/**
 * Turn one HTTP response into a JSON-RPC outcome.
 *
 * HTTP status is checked BEFORE the body: a 401 that happens to carry a JSON
 * error should read as "the token was rejected", which is actionable, rather
 * than whatever prose the server put in the payload.
 */
export function parseRpcResponse(raw: McpHttpRaw, id: number): RpcOutcome {
  if (raw.status === 401 || raw.status === 403)
    return {
      ok: false,
      code: "auth",
      message: `認証されませんでした（HTTP ${raw.status}）。トークンを確認してください。`,
    };
  if (raw.status === 404)
    return {
      ok: false,
      code: "not_found",
      message:
        "その URL に MCP サーバが見つかりませんでした（HTTP 404）。エンドポイントのパスを確認してください。",
    };
  if (raw.status >= 300 && raw.status < 400)
    return {
      ok: false,
      code: "redirect",
      message: `リダイレクト（HTTP ${raw.status}）は、トークンが転送先に渡るため追跡しません。最終的な URL を直接指定してください。`,
    };

  const messages = messagesFrom(raw);
  if (messages.length === 0) {
    if (raw.status >= 400)
      return {
        ok: false,
        code: "http",
        message: `サーバがエラーを返しました（HTTP ${raw.status}）。`,
      };
    return {
      ok: false,
      code: "empty",
      message: "サーバの応答が空か、JSON として読めませんでした。",
    };
  }

  // Prefer the message answering this request; fall back to the last one that
  // carries a result or an error (servers may interleave notifications).
  const envelopes = messages as Array<{
    id?: unknown;
    result?: unknown;
    error?: { code?: unknown; message?: unknown };
  }>;
  const match =
    envelopes.find((m) => m.id === id) ??
    [...envelopes].reverse().find((m) => "result" in m || "error" in m);
  if (!match)
    return {
      ok: false,
      code: "malformed",
      message: "JSON-RPC の応答に result も error も含まれていませんでした。",
    };
  if (match.error) {
    const m =
      typeof match.error.message === "string"
        ? match.error.message
        : JSON.stringify(match.error);
    return {
      ok: false,
      code: "rpc",
      message: `サーバがエラーを返しました: ${m}`,
    };
  }
  if (match.result && typeof match.result === "object")
    return { ok: true, result: match.result as Record<string, unknown> };
  return {
    ok: false,
    code: "malformed",
    message: "JSON-RPC の result が オブジェクトではありませんでした。",
  };
}

/** Read a `tools/list` result into the shape the probe layer expects. */
export function parseToolsList(result: Record<string, unknown>): McpToolInfo[] {
  const tools = Array.isArray(result.tools) ? result.tools : [];
  const out: McpToolInfo[] = [];
  for (const t of tools) {
    const tool = t as {
      name?: unknown;
      description?: unknown;
      inputSchema?: unknown;
      annotations?: unknown;
    };
    if (typeof tool.name !== "string" || !tool.name) continue;
    const ann = tool.annotations as { readOnlyHint?: unknown } | undefined;
    out.push({
      name: tool.name,
      description:
        typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: tool.inputSchema,
      annotations:
        ann && typeof ann.readOnlyHint === "boolean"
          ? { readOnlyHint: ann.readOnlyHint }
          : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------

export interface McpHttpServer {
  url: string;
  bearer?: string;
}

export class McpHttpError extends Error {
  constructor(
    readonly code: RpcFail["code"] | "transport",
    message: string,
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(private readonly server: McpHttpServer) {}

  private async rpc(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    let raw: McpHttpRaw;
    try {
      const wire = await invoke<McpHttpWire>("mcp_http_rpc", {
        url: this.server.url,
        bearer: this.server.bearer ?? null,
        sessionId: this.sessionId,
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      raw = fromWire(wire);
    } catch (e) {
      throw new McpHttpError(
        "transport",
        e instanceof Error ? e.message : String(e),
      );
    }
    if (raw.sessionId) this.sessionId = raw.sessionId;
    const outcome = parseRpcResponse(raw, id);
    if (!outcome.ok) throw new McpHttpError(outcome.code, outcome.message);
    return outcome.result;
  }

  /** Handshake. Returns the server's declared identity for display. */
  async initialize(): Promise<{ name: string; version: string }> {
    const result = await this.rpc("initialize", {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "MarkFlow", version: "1.0.0" },
    });
    const info = (result.serverInfo ?? {}) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      name: typeof info.name === "string" ? info.name : "(名前なし)",
      version: typeof info.version === "string" ? info.version : "",
    };
  }

  async listTools(): Promise<McpToolInfo[]> {
    return parseToolsList(await this.rpc("tools/list"));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.rpc("tools/call", { name, arguments: args });
  }
}
