// =====================================================================
// MCP (Model Context Protocol) server — pure protocol logic
// ---------------------------------------------------------------------
// MarkFlow exposes the signed-in user's PERSONAL documents (ownerId == uid,
// read-only) to Claude as an MCP *server* over Streamable HTTP. This module
// holds ONLY the pure, side-effect-free protocol surface so it can be unit
// tested exhaustively (see mcp.test.ts): JSON-RPC framing, `initialize`
// negotiation, the tool catalogue, and the search / formatting logic over a
// plain document array. All Firestore / HTTP wiring lives in index.ts and is
// injected into handleMcpMessage() as async `deps`.
//
// Why hand-rolled (no @modelcontextprotocol/sdk): this ai-proxy has NO
// package.json — deps are npm-installed ad-hoc in the Dockerfile and esbuild
// bundles local .ts with node_modules marked --external. The server is a
// stateless, read-only *tool* server (no resources/prompts/SSE/sessions), for
// which the wire protocol is ~120 lines. Hand-rolling keeps zero new deps, no
// ESM/CJS bundling risk, matches every other raw-http route here, and makes the
// dispatch trivially testable. Revisit the SDK if we ever add resources/prompts
// or server→client streaming.
// =====================================================================

import { MCP_ICON_DATA_URI } from "./mcp-assets";

// ---------------------------------------------------------------------
// JSON-RPC 2.0 framing
// ---------------------------------------------------------------------

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId; // absent => notification
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Standard JSON-RPC error codes (subset we use).
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/** A JSON-RPC message is a *request* (must be answered) iff it carries an id. */
export function isRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    !!msg &&
    typeof msg === "object" &&
    typeof (msg as JsonRpcRequest).method === "string"
  );
}

export function hasId(msg: JsonRpcRequest): boolean {
  return "id" in msg && msg.id !== undefined;
}

// ---------------------------------------------------------------------
// Protocol version negotiation
// ---------------------------------------------------------------------

// Versions we have explicitly validated our tool surface against. `initialize`
// echoes the client's requested version when it is a well-formed date string
// (our tools/list + tools/call framing is stable across every MCP revision from
// 2024-11-05 onward, so echoing maximises client compatibility); it falls back
// to LATEST when the client omits or sends a malformed version.
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const LATEST_PROTOCOL_VERSION = "2025-06-18";

const DATE_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === "string" && DATE_VERSION_RE.test(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

// ---------------------------------------------------------------------
// Server identity + capabilities
// ---------------------------------------------------------------------

export const SERVER_INFO = {
  name: "markflow",
  title: "MarkFlow Documents",
  version: "1.0.0",
} as const;

export const SERVER_INSTRUCTIONS =
  "These tools expose the signed-in MarkFlow user's own personal documents " +
  "(read-only Markdown). Use list_documents to browse, search_documents to " +
  "find by keyword, and get_document to read a document's full content by id.";

export function buildInitializeResult(requestedVersion: unknown) {
  return {
    protocolVersion: negotiateProtocolVersion(requestedVersion),
    capabilities: { tools: { listChanged: false } },
    // serverInfo.icons per MCP SEP-973 (rev 2025-11-25+): a self-contained data:
    // URI so no origin/plumbing is needed. NOTE: Claude's custom-connector UI
    // ignores this today (verified 2026-09) — it renders in other MCP clients and
    // future-proofs for when Anthropic ships icon rendering. See mcp-assets.ts.
    serverInfo: {
      ...SERVER_INFO,
      icons: [
        { src: MCP_ICON_DATA_URI, mimeType: "image/png", sizes: "128x128" },
      ],
    },
    instructions: SERVER_INSTRUCTIONS,
  };
}

// ---------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------

// Cap how many docs a single list/search returns so a huge library can't
// balloon one tool response past model/context limits. get_document fetches the
// full body of one doc on demand.
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

// Cap the number of JSON-RPC messages accepted in a single batch POST. A batch of
// N list/search calls would otherwise fan out to N Firestore queries; combined
// with the 4 MB body cap that is a cheap read-amplification / DoS lever. 50 is
// far above any real client's initialize/tools handshake.
export const MAX_RPC_BATCH = 50;

export const TOOLS = [
  {
    name: "list_documents",
    title: "List documents",
    description:
      "List the user's personal MarkFlow documents (most recently updated " +
      "first). Returns each document's id, title, folder, tags and update " +
      "time. Use get_document with an id to read the full content.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: `Max documents to return (1-${MAX_LIST_LIMIT}, default ${DEFAULT_LIST_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "search_documents",
    title: "Search documents",
    description:
      "Search the user's personal MarkFlow documents by keyword (matches " +
      "title and body, case-insensitive). Returns matching documents with a " +
      "short snippet and id. Use get_document to read the full content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword(s) to search for." },
        limit: {
          type: "number",
          description: `Max results to return (1-${MAX_LIST_LIMIT}, default ${DEFAULT_LIST_LIMIT}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_document",
    title: "Get document",
    description:
      "Read the full Markdown content of one of the user's personal " +
      "documents by its id (get ids from list_documents or search_documents).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document id to read." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

// ---------------------------------------------------------------------
// Document shape + formatting / search (pure)
// ---------------------------------------------------------------------

export interface McpDoc {
  id: string;
  title: string;
  content: string;
  updatedAt: number; // epoch ms
  createdAt?: number; // epoch ms
  folder?: string | null;
  tags?: string[];
  docType?: string;
}

// True iff a raw Firestore `documents/{id}` record is `uid`'s PERSONAL doc — the
// only class the MCP tools may expose. Team docs (non-empty `teamId`) and docs the
// owner shared with collaborators (non-empty `collaboratorUids`) live in the SAME
// collection with `ownerId == uid`, so ownerId alone is NOT sufficient scoping;
// exposing them would leak content authored by other team members and break the
// consent screen's promise (共有・チームのドキュメントは対象外). Pure so it can be
// unit-tested; the Firestore wiring in index.ts applies it in both list and get.
export function isPersonalDocData(
  uid: string,
  data: Record<string, unknown>,
): boolean {
  if (!uid || String(data.ownerId ?? "") !== uid) return false;
  const teamId = data.teamId;
  if (typeof teamId === "string" && teamId !== "") return false; // team doc
  const collab = data.collaboratorUids;
  if (Array.isArray(collab) && collab.length > 0) return false; // shared out
  return true;
}

/** Format an epoch-ms timestamp as "YYYY-MM-DD HH:mm" in Asia/Tokyo (project TZ). */
export function formatTokyo(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "unknown";
  // sv-SE yields ISO-like "YYYY-MM-DD HH:mm:ss"; slice to minute precision.
  const s = new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
  return s.slice(0, 16);
}

function clampLimit(raw: unknown, fallback: number): number {
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.floor(raw)
      : fallback;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, n));
}

/** One-line summary of a document for list/search output. */
export function formatDocLine(doc: McpDoc): string {
  const title = doc.title?.trim() || "(untitled)";
  const parts = [`updated ${formatTokyo(doc.updatedAt)}`];
  if (doc.folder) parts.push(`folder: ${doc.folder}`);
  if (doc.tags && doc.tags.length) parts.push(`tags: ${doc.tags.join(", ")}`);
  if (doc.docType && doc.docType !== "markdown")
    parts.push(`type: ${doc.docType}`);
  return `• ${title}\n  id: ${doc.id}\n  ${parts.join(" · ")}`;
}

export function formatDocList(docs: McpDoc[], limit: number): string {
  const shown = docs.slice(0, limit);
  if (!shown.length) return "No documents found.";
  const header =
    docs.length > shown.length
      ? `Showing ${shown.length} of ${docs.length} documents (most recently updated first):`
      : `${shown.length} document${shown.length === 1 ? "" : "s"} (most recently updated first):`;
  return `${header}\n\n${shown.map(formatDocLine).join("\n\n")}`;
}

/** Full-content rendering of a single document for get_document. */
export function formatDocFull(doc: McpDoc): string {
  const meta: string[] = [
    `Title: ${doc.title?.trim() || "(untitled)"}`,
    `Id: ${doc.id}`,
    `Updated: ${formatTokyo(doc.updatedAt)}`,
  ];
  if (doc.createdAt) meta.push(`Created: ${formatTokyo(doc.createdAt)}`);
  if (doc.folder) meta.push(`Folder: ${doc.folder}`);
  if (doc.tags && doc.tags.length) meta.push(`Tags: ${doc.tags.join(", ")}`);
  const body = doc.content ?? "";
  return `${meta.join("\n")}\n\n---\n\n${body}`;
}

/** Build a ~160-char snippet around the first query hit (or the head of the body). */
export function snippet(content: string, query: string): string {
  const body = (content || "").replace(/\s+/g, " ").trim();
  if (!body) return "(empty document)";
  const idx = query ? body.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (idx < 0) return body.length > 160 ? body.slice(0, 160) + "…" : body;
  const start = Math.max(0, idx - 60);
  const end = Math.min(body.length, idx + query.length + 100);
  return (
    (start > 0 ? "…" : "") +
    body.slice(start, end) +
    (end < body.length ? "…" : "")
  );
}

/**
 * Case-insensitive keyword filter over title + body, ranked by recency.
 * Every term (whitespace-split) must appear somewhere in title+content.
 */
export function searchDocuments(
  docs: McpDoc[],
  query: string,
  limit: number,
): McpDoc[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const matched = docs.filter((d) => {
    const hay = `${d.title || ""}\n${d.content || ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  matched.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return matched.slice(0, limit);
}

export function formatSearchResults(docs: McpDoc[], query: string): string {
  if (!docs.length) return `No documents match "${query}".`;
  const blocks = docs.map((d) => {
    const title = d.title?.trim() || "(untitled)";
    return `• ${title}\n  id: ${d.id}\n  updated ${formatTokyo(d.updatedAt)}\n  ${snippet(d.content, query)}`;
  });
  return `${docs.length} result${docs.length === 1 ? "" : "s"} for "${query}":\n\n${blocks.join("\n\n")}`;
}

// ---------------------------------------------------------------------
// Tool-call results (MCP content shape)
// ---------------------------------------------------------------------

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------

// I/O the pure dispatcher needs, injected by index.ts (Firestore-backed).
// listDocs returns the user's personal docs (ownerId == uid), most-recent
// first; getDoc returns one doc iff it belongs to the user (else null — the
// authorization check lives in index.ts's implementation, never here).
export interface McpDeps {
  listDocs: () => Promise<McpDoc[]>;
  getDoc: (id: string) => Promise<McpDoc | null>;
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  deps: McpDeps,
): Promise<ToolResult> {
  switch (name) {
    case "list_documents": {
      const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT);
      const docs = await deps.listDocs();
      return textResult(formatDocList(docs, limit));
    }
    case "search_documents": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return errorResult("The 'query' argument is required.");
      const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT);
      const docs = await deps.listDocs();
      const hits = searchDocuments(docs, query, limit);
      return textResult(formatSearchResults(hits, query));
    }
    case "get_document": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return errorResult("The 'id' argument is required.");
      const doc = await deps.getDoc(id);
      if (!doc) return errorResult(`No document found with id "${id}".`);
      return textResult(formatDocFull(doc));
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

/**
 * Handle one JSON-RPC message. Returns a JsonRpcResponse to send back, or null
 * for notifications (which get an HTTP 202 with no body at the transport layer).
 * Protocol/transport errors surface as JSON-RPC errors; tool failures surface as
 * a successful result with isError:true (per MCP: tool errors are in-band so the
 * model can see and react to them).
 */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  deps: McpDeps,
): Promise<JsonRpcResponse | null> {
  const id: JsonRpcId = hasId(msg) ? (msg.id as JsonRpcId) : null;
  const notification = !hasId(msg);
  const params = (msg.params || {}) as Record<string, unknown>;

  switch (msg.method) {
    case "initialize":
      return rpcResult(id, buildInitializeResult(params.protocolVersion));

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications: no response

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments || {}) as Record<string, unknown>;
      if (!name) return rpcError(id, RPC.INVALID_PARAMS, "Missing tool name");
      try {
        const result = await callTool(name, args, deps);
        return rpcResult(id, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Log the real cause server-side, but surface only a generic in-band tool
        // error to the client — never leak internal error text / stack details
        // (parity with the generic HTTP 500 the route wrapper returns).
        console.error(`[mcp] tool "${name}" failed: ${message}`);
        return rpcResult(id, errorResult("Tool execution failed."));
      }
    }

    default:
      // Unknown notification → swallow; unknown request → method-not-found.
      if (notification) return null;
      return rpcError(
        id,
        RPC.METHOD_NOT_FOUND,
        `Method not found: ${msg.method}`,
      );
  }
}
