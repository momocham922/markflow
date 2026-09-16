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
  "find by keyword, and get_document to read a document's full content by id. " +
  "Documents created from a voice recording also keep the raw speech-to-text " +
  "transcript (get_transcript, paged) and any web research gathered during the " +
  "recording (get_research); get_document's header says when either exists. " +
  "The transcript is the primary source for what was actually said — the " +
  "document body is an AI-structured summary of it.";

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
        { src: MCP_ICON_DATA_URI, mimeType: "image/png", sizes: ["128x128"] },
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

// get_transcript pages the raw transcript so one call stays well inside MCP
// client output budgets (Claude Code warns at 10k and caps at 25k tokens by
// default; Japanese runs roughly one token per character). A 4-hour recording is
// ~100k+ characters, so callers page with `offset`.
export const DEFAULT_TRANSCRIPT_CHARS = 15_000;
export const MAX_TRANSCRIPT_CHARS = 50_000;
export const MIN_TRANSCRIPT_CHARS = 1_000;
// get_research renders every card; bound the text so a long session can't blow
// the same budget. Cards past the cap are counted, not silently dropped.
export const MAX_RESEARCH_OUTPUT_CHARS = 30_000;
// A real card averages ~2k chars (summary + sources), so 12 stays inside the
// same output budget as MAX_RESEARCH_OUTPUT_CHARS.
export const MAX_RESEARCH_CARDS_PER_CALL = 12;

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
  {
    name: "get_transcript",
    title: "Get transcript",
    description:
      "Read the raw speech-to-text transcript kept with a voice-recorded " +
      "document (the document body is an AI summary of it). Paged: returns up " +
      `to max_chars characters (default ${DEFAULT_TRANSCRIPT_CHARS}) starting at ` +
      "offset, and tells you the offset to continue from. Speech recognition " +
      "can mishear names and numbers — treat it as evidence, not ground truth.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document id." },
        offset: {
          type: "number",
          description: "Character offset to start from (default 0).",
        },
        max_chars: {
          type: "number",
          description: `Characters to return (${MIN_TRANSCRIPT_CHARS}-${MAX_TRANSCRIPT_CHARS}, default ${DEFAULT_TRANSCRIPT_CHARS}).`,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_research",
    title: "Get research",
    description:
      "Read the web research cards gathered while a document was being " +
      "recorded: each card's query, summary, sources and whether it was " +
      "already woven into the document. Cards of type question are follow-up " +
      "questions raised during the meeting, not facts. When a document has " +
      "many cards, the first call returns a numbered index; pass `cards` with " +
      "the numbers you need to read their summaries and sources.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document id." },
        cards: {
          type: "array",
          items: { type: "number" },
          description: `Card numbers from the index to read in full (max ${MAX_RESEARCH_CARDS_PER_CALL}).`,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

// ---------------------------------------------------------------------
// Write surface — create_document (create-only "inbox")
// ---------------------------------------------------------------------
// The ONLY write tool. It is deliberately a constrained, low-blast-radius
// capability, NOT a general document-editing surface:
//   • create-ONLY — every call makes a brand-new document; it never edits,
//     overwrites, moves or deletes an existing one (so no content-destruction
//     path and the client's 3-layer content protection is never bypassed).
//   • confined — the destination folder + ownerId are forced server-side
//     (index.ts); the tool cannot choose a folder, target another user, or
//     write a team / shared document.
//   • gated — advertised + callable only when the connection is write-enabled
//     (index.ts wires deps.createDoc per-uid + env; dark by default).
// Rationale: lets an MCP client (e.g. Claude Code) deposit Markdown it produced
// into a dedicated MarkFlow folder for the user to review/refine, without any of
// the risks of arbitrary write. See callTool + mcpDepsForUid.

// Bound a single create so one call can't write an unbounded blob (the 4 MB RPC
// body cap is a coarser backstop). Enforced in callTool AND re-checked in the
// Firestore-backed createDoc (defense in depth).
export const MAX_CREATE_CONTENT_CHARS = 500_000;
export const MAX_CREATE_TITLE_CHARS = 200;
export const MAX_CREATE_TAGS = 20;
export const MAX_CREATE_TAG_CHARS = 64;

export const CREATE_DOCUMENT_TOOL = {
  name: "create_document",
  title: "Create document",
  description:
    "Create a NEW Markdown document in the user's MarkFlow library. It is " +
    "always placed in a dedicated import folder (the folder cannot be chosen) " +
    "and a fresh document is created on every call — this tool NEVER edits, " +
    "overwrites, moves or deletes an existing document. Use it to save Markdown " +
    "you produced (e.g. notes drafted in this session) into MarkFlow for the " +
    "user to review and refine later.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: `The Markdown body of the new document (required, non-empty, max ${MAX_CREATE_CONTENT_CHARS} characters).`,
      },
      title: {
        type: "string",
        description: `Optional title (max ${MAX_CREATE_TITLE_CHARS} characters). If omitted, a title is derived from the first heading or line of the content.`,
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: `Optional list of tags (max ${MAX_CREATE_TAGS}).`,
      },
    },
    required: ["content"],
    additionalProperties: false,
  },
  // Accurate MCP hints: this tool mutates state (not read-only), but it only
  // ADDS a new document — it is non-destructive and non-idempotent (each call
  // creates another document).
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

/**
 * The tool catalogue advertised to a client. The create_document (write) tool is
 * offered ONLY when the connection is write-enabled; a read-only connection sees
 * exactly the read tools. index.ts decides write-eligibility per-uid (env
 * MCP_IMPORT_UIDS) and reflects it by setting deps.createDoc, so `canWrite` here
 * is simply `!!deps.createDoc`.
 */
export function toolsFor(canWrite: boolean) {
  return canWrite ? [...TOOLS, CREATE_DOCUMENT_TOOL] : [...TOOLS];
}

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
  /** Length (chars) of the stored voice transcript; 0/absent = none. */
  transcriptChars?: number;
}

/** A document's stored voice transcript (get_transcript). */
export interface McpTranscript {
  id: string;
  title: string;
  text: string;
  recordedAt?: number; // epoch ms
  /** The full recording is kept in cloud storage (Refine can re-transcribe it). */
  audioStored: boolean;
}

export interface McpResearchCard {
  type: string;
  query: string;
  summary: string;
  sources: Array<{ title: string; url: string }>;
  credibility?: string;
  integrated?: boolean;
  timestamp?: number; // epoch ms
}

export interface McpResearchSession {
  id: string;
  startedAt: number; // epoch ms
  endedAt: number | null;
  cards: McpResearchCard[];
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
  if (doc.transcriptChars)
    parts.push(`transcript: ${formatCount(doc.transcriptChars)} chars`);
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

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Full-content rendering of a single document for get_document. */
export function formatDocFull(
  doc: McpDoc,
  extras: { researchCards?: number } = {},
): string {
  const meta: string[] = [
    `Title: ${doc.title?.trim() || "(untitled)"}`,
    `Id: ${doc.id}`,
    `Updated: ${formatTokyo(doc.updatedAt)}`,
  ];
  if (doc.createdAt) meta.push(`Created: ${formatTokyo(doc.createdAt)}`);
  if (doc.folder) meta.push(`Folder: ${doc.folder}`);
  if (doc.tags && doc.tags.length) meta.push(`Tags: ${doc.tags.join(", ")}`);
  if (doc.transcriptChars)
    meta.push(
      `Transcript: ${formatCount(doc.transcriptChars)} chars (read with get_transcript)`,
    );
  if (extras.researchCards)
    meta.push(
      `Research: ${formatCount(extras.researchCards)} cards (read with get_research)`,
    );
  const body = doc.content ?? "";
  return `${meta.join("\n")}\n\n---\n\n${body}`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * One page of a transcript. Never splits a surrogate pair, and when more text
 * follows, backs the cut off to the last line break or sentence end within the
 * final 10% of the page so a page doesn't end mid-sentence. `end` is the offset
 * to continue from.
 */
export function sliceTranscript(
  text: string,
  offset: number,
  maxChars: number,
): { chunk: string; start: number; end: number; total: number } {
  const total = text.length;
  let start = Math.max(0, Math.min(Math.floor(offset), total));
  if (start > 0 && start < total && isLowSurrogate(text.charCodeAt(start)))
    start -= 1;
  let end = Math.min(total, start + maxChars);
  if (end < total) {
    const floor = end - Math.floor(maxChars / 10);
    for (let i = end - 1; i > floor && i > start; i--) {
      const ch = text[i];
      if (ch === "\n" || ch === "。" || ch === "？" || ch === "！") {
        end = i + 1;
        break;
      }
    }
    if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  }
  return { chunk: text.slice(start, end), start, end, total };
}

export function formatTranscriptPage(
  t: McpTranscript,
  offset: number,
  maxChars: number,
): string {
  const { chunk, start, end, total } = sliceTranscript(
    t.text,
    offset,
    maxChars,
  );
  const meta: string[] = [
    `Title: ${t.title?.trim() || "(untitled)"}`,
    `Id: ${t.id}`,
  ];
  if (t.recordedAt) meta.push(`Recorded: ${formatTokyo(t.recordedAt)}`);
  meta.push(
    `Audio stored: ${t.audioStored ? "yes (the recording can be re-transcribed with Refine)" : "no"}`,
  );
  meta.push(
    `Transcript: ${formatCount(total)} chars — showing ${formatCount(start)}–${formatCount(end)}`,
  );
  meta.push(
    "Note: raw speech-to-text; names, numbers and technical terms may be misheard.",
  );
  const tail =
    end < total
      ? `\n\n---\n\n${formatCount(total - end)} more chars. Continue with get_transcript {"id": "${t.id}", "offset": ${end}}.`
      : "\n\n---\n\nEnd of transcript.";
  return `${meta.join("\n")}\n\n---\n\n${chunk}${tail}`;
}

const RESEARCH_TYPE_LABEL: Record<string, string> = {
  topic: "topic",
  "fact-check": "fact-check",
  financial: "financial",
  "explicit-request": "requested",
  internal: "internal",
  question: "follow-up question (not a fact)",
};

function researchCardBlock(n: number, c: McpResearchCard): string {
  const label = RESEARCH_TYPE_LABEL[c.type] || c.type || "research";
  const status = c.integrated
    ? "woven into the document"
    : "not in the document";
  const lines = [
    `### #${n} [${label}] ${c.query || "(no query)"}`,
    `(${status})`,
  ];
  if (c.summary) lines.push(c.summary.trim());
  if (c.sources.length) {
    lines.push("Sources:");
    for (const src of c.sources)
      lines.push(`- ${src.title || src.url} — ${src.url}`);
  }
  return lines.join("\n");
}

function sessionHeading(s: McpResearchSession): string {
  const ended = s.endedAt ? ` – ${formatTokyo(s.endedAt)}` : "";
  return `## Session ${formatTokyo(s.startedAt)}${ended}`;
}

/**
 * Research cards for get_research, numbered 1..N across sessions (in session
 * order). With no `pick`, returns every card in full when that fits the output
 * cap, otherwise a one-line-per-card index so the caller can choose; with
 * `pick`, returns just those cards in full. Nothing is dropped silently.
 */
export function formatResearch(
  doc: { id: string; title: string },
  sessions: McpResearchSession[],
  pick?: number[],
): string {
  const numbered: Array<{
    n: number;
    session: McpResearchSession;
    card: McpResearchCard;
  }> = [];
  for (const s of sessions)
    for (const card of s.cards)
      numbered.push({ n: numbered.length + 1, session: s, card });
  const total = numbered.length;
  const head = `Title: ${doc.title?.trim() || "(untitled)"}\nId: ${doc.id}`;
  if (!total) return `${head}\n\nNo research cards for this document.`;
  const summary = `${sessions.length} research session${sessions.length === 1 ? "" : "s"}, ${formatCount(total)} card${total === 1 ? "" : "s"}`;

  // Render the chosen cards grouped under their session headings.
  const renderFull = (rows: typeof numbered): string => {
    const out: string[] = [];
    let current: McpResearchSession | null = null;
    for (const r of rows) {
      if (r.session !== current) {
        out.push(sessionHeading(r.session));
        current = r.session;
      }
      out.push(researchCardBlock(r.n, r.card));
    }
    return out.join("\n\n");
  };

  if (pick && pick.length) {
    const wanted = new Set(pick);
    const rows = numbered.filter((r) => wanted.has(r.n));
    // Still honour the output cap: keep whole cards, name the ones left over.
    const shown: typeof rows = [];
    let used = 0;
    for (const r of rows) {
      const len = researchCardBlock(r.n, r.card).length;
      if (shown.length && used + len > MAX_RESEARCH_OUTPUT_CHARS) break;
      shown.push(r);
      used += len;
    }
    const notes: string[] = [];
    const left = rows.slice(shown.length).map((r) => r.n);
    if (left.length)
      notes.push(
        `Not shown (output size limit) — request again: ${left.join(", ")}.`,
      );
    const missing = pick.filter((n) => n < 1 || n > total);
    if (missing.length)
      notes.push(
        `No such card number(s): ${missing.join(", ")} (valid: 1–${total}).`,
      );
    const noteText = notes.length ? `\n\n---\n\n${notes.join("\n")}` : "";
    return `${head}\n${summary} — showing ${shown.length}\n\n${renderFull(shown)}${noteText}`;
  }

  const full = renderFull(numbered);
  if (full.length <= MAX_RESEARCH_OUTPUT_CHARS)
    return `${head}\n${summary}\n\n${full}`;

  // Too much to show in one go: a compact index of every card.
  const index: string[] = [];
  let current: McpResearchSession | null = null;
  for (const r of numbered) {
    if (r.session !== current) {
      index.push(`\n${sessionHeading(r.session)}`);
      current = r.session;
    }
    const label = RESEARCH_TYPE_LABEL[r.card.type] || r.card.type || "research";
    const woven = r.card.integrated ? " · woven" : "";
    const q = (r.card.query || "(no query)").replace(/\s+/g, " ").slice(0, 120);
    index.push(`#${r.n} [${label}] ${q}${woven}`);
  }
  return (
    `${head}\n${summary} — too many to show in full, so this is an index.\n` +
    `Read cards with get_research {"id": "${doc.id}", "cards": [numbers]} (up to ${MAX_RESEARCH_CARDS_PER_CALL} per call).\n` +
    index.join("\n")
  );
}

/**
 * Derive a document title from Markdown when the client didn't supply one.
 * Prefers the first ATX heading (`# ...`), else the first non-blank line, with
 * leading list/quote/heading markers stripped; capped to MAX_CREATE_TITLE_CHARS.
 * Returns "Untitled" for empty/whitespace-only content (never an empty title).
 */
export function deriveTitleFromMarkdown(content: string): string {
  const lines = (content || "").split(/\r?\n/);
  let candidate = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*\S)\s*$/);
    if (heading) {
      candidate = heading[1];
      break;
    }
    // First non-blank, non-heading line: strip common leading markers.
    candidate = line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^>\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .trim();
    if (candidate) break;
  }
  candidate = candidate.trim();
  if (!candidate) return "Untitled";
  return candidate.length > MAX_CREATE_TITLE_CHARS
    ? candidate.slice(0, MAX_CREATE_TITLE_CHARS)
    : candidate;
}

/** Confirmation text returned to the client after a successful create_document. */
export function formatCreatedDoc(doc: McpDoc): string {
  const meta: string[] = [
    `Title: ${doc.title?.trim() || "(untitled)"}`,
    `Id: ${doc.id}`,
  ];
  if (doc.folder) meta.push(`Folder: ${doc.folder}`);
  if (doc.tags && doc.tags.length) meta.push(`Tags: ${doc.tags.join(", ")}`);
  return `Created a new document in MarkFlow.\n${meta.join("\n")}`;
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

// Already-validated arguments for a create — callTool normalizes/caps the raw
// tool args into this before handing them to the Firestore-backed createDoc.
// `content` is guaranteed non-empty and within MAX_CREATE_CONTENT_CHARS; `title`
// is a trimmed, capped, non-empty string; `tags` is a de-duped, capped list.
export interface CreateDocInput {
  title: string;
  content: string;
  tags: string[];
}

// Discriminated result so failures (rate limit, disabled, re-validation) surface
// as an in-band tool error rather than throwing — the model sees the message and
// the client never gets a 5xx for an expected refusal.
export type CreateDocResult =
  { ok: true; doc: McpDoc } | { ok: false; message: string };

// I/O the pure dispatcher needs, injected by index.ts (Firestore-backed).
// listDocs returns the user's personal docs (ownerId == uid), most-recent
// first; getDoc returns one doc iff it belongs to the user (else null — the
// authorization check lives in index.ts's implementation, never here).
// createDoc is PRESENT ONLY for write-enabled connections (index.ts sets it per
// uid + env); its presence is exactly what flips the advertised tool catalogue
// to include create_document (see toolsFor / tools/list). When absent, the
// create_document tool is neither listed nor callable.
// getTranscript / getResearch apply the SAME personal-doc authorization as
// getDoc (null = not found or not the caller's personal document).
export interface McpDeps {
  listDocs: () => Promise<McpDoc[]>;
  getDoc: (id: string) => Promise<McpDoc | null>;
  getTranscript?: (id: string) => Promise<McpTranscript | null>;
  getResearch?: (id: string) => Promise<McpResearchSession[] | null>;
  createDoc?: (input: CreateDocInput) => Promise<CreateDocResult>;
}

function intArg(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.floor(raw)
    : fallback;
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
      // Only surface the research COUNT here (the cards themselves stay behind
      // get_research) so a plain document read doesn't grow noisier.
      let researchCards = 0;
      if (deps.getResearch) {
        const sessions = await deps.getResearch(id);
        researchCards = (sessions || []).reduce(
          (n, s) => n + s.cards.length,
          0,
        );
      }
      return textResult(formatDocFull(doc, { researchCards }));
    }
    case "get_transcript": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return errorResult("The 'id' argument is required.");
      if (!deps.getTranscript)
        return errorResult("The get_transcript tool is not enabled.");
      const t = await deps.getTranscript(id);
      if (!t) return errorResult(`No document found with id "${id}".`);
      if (!t.text.trim())
        return textResult(
          `Title: ${t.title?.trim() || "(untitled)"}\nId: ${t.id}\n\nThis document has no transcript.`,
        );
      const offset = Math.max(0, intArg(args.offset, 0));
      if (offset >= t.text.length)
        return errorResult(
          `offset ${offset} is past the end of the transcript (${t.text.length} chars).`,
        );
      const maxChars = Math.max(
        MIN_TRANSCRIPT_CHARS,
        Math.min(
          MAX_TRANSCRIPT_CHARS,
          intArg(args.max_chars, DEFAULT_TRANSCRIPT_CHARS),
        ),
      );
      return textResult(formatTranscriptPage(t, offset, maxChars));
    }
    case "get_research": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return errorResult("The 'id' argument is required.");
      if (!deps.getResearch)
        return errorResult("The get_research tool is not enabled.");
      const doc = await deps.getDoc(id);
      if (!doc) return errorResult(`No document found with id "${id}".`);
      let pick: number[] | undefined;
      if (args.cards !== undefined) {
        if (!Array.isArray(args.cards))
          return errorResult("'cards' must be an array of card numbers.");
        pick = [
          ...new Set(
            args.cards
              .filter(
                (n): n is number => typeof n === "number" && Number.isFinite(n),
              )
              .map((n) => Math.floor(n)),
          ),
        ];
        if (!pick.length)
          return errorResult("'cards' must contain at least one card number.");
        if (pick.length > MAX_RESEARCH_CARDS_PER_CALL)
          return errorResult(
            `Too many cards requested (${pick.length}; max ${MAX_RESEARCH_CARDS_PER_CALL} per call).`,
          );
      }
      const sessions = await deps.getResearch(id);
      if (!sessions) return errorResult(`No document found with id "${id}".`);
      return textResult(formatResearch(doc, sessions, pick));
    }
    case "create_document": {
      // Gate: only write-enabled connections carry deps.createDoc. A read-only
      // connection never advertises this tool, but re-check here so a hand-rolled
      // tools/call can't invoke it regardless.
      if (!deps.createDoc) {
        return errorResult("The create_document tool is not enabled.");
      }
      const content = typeof args.content === "string" ? args.content : "";
      // Trim only for the emptiness check; store the content as authored so
      // leading/trailing structure the client intended is preserved.
      if (!content.trim()) {
        return errorResult(
          "The 'content' argument is required and must be non-empty.",
        );
      }
      if (content.length > MAX_CREATE_CONTENT_CHARS) {
        return errorResult(
          `Content is too large (${content.length} characters; max ${MAX_CREATE_CONTENT_CHARS}).`,
        );
      }
      // Title: explicit if provided & non-blank (capped), else derived.
      const rawTitle = typeof args.title === "string" ? args.title.trim() : "";
      const title = rawTitle
        ? rawTitle.slice(0, MAX_CREATE_TITLE_CHARS)
        : deriveTitleFromMarkdown(content);
      // Tags: strings only, trimmed, non-empty, de-duped, each capped, list capped.
      const tags: string[] = [];
      if (Array.isArray(args.tags)) {
        for (const t of args.tags) {
          if (typeof t !== "string") continue;
          const tag = t.trim().slice(0, MAX_CREATE_TAG_CHARS);
          if (tag && !tags.includes(tag)) tags.push(tag);
          if (tags.length >= MAX_CREATE_TAGS) break;
        }
      }
      const result = await deps.createDoc({ title, content, tags });
      if (!result.ok) return errorResult(result.message);
      return textResult(formatCreatedDoc(result.doc));
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
      // Advertise the write tool only to write-enabled connections (deps.createDoc
      // present). Read-only connections see exactly the read tools.
      return rpcResult(id, { tools: toolsFor(!!deps.createDoc) });

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
