import { describe, it, expect, vi } from "vitest";
import {
  negotiateProtocolVersion,
  LATEST_PROTOCOL_VERSION,
  buildInitializeResult,
  TOOLS,
  CREATE_DOCUMENT_TOOL,
  toolsFor,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_CREATE_CONTENT_CHARS,
  MAX_CREATE_TITLE_CHARS,
  MAX_CREATE_TAGS,
  MAX_CREATE_TAG_CHARS,
  searchDocuments,
  formatDocList,
  formatDocFull,
  formatSearchResults,
  deriveTitleFromMarkdown,
  formatCreatedDoc,
  snippet,
  callTool,
  handleMcpMessage,
  isRequest,
  hasId,
  isPersonalDocData,
  sliceTranscript,
  formatTranscriptPage,
  formatResearch,
  DEFAULT_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_CHARS,
  MAX_RESEARCH_OUTPUT_CHARS,
  MAX_RESEARCH_CARDS_PER_CALL,
  type McpTranscript,
  type McpResearchSession,
  type McpDoc,
  type McpDeps,
  type CreateDocInput,
  type CreateDocResult,
} from "./mcp";

const DOCS: McpDoc[] = [
  {
    id: "a",
    title: "Grocery list",
    content: "milk, eggs, bread and butter",
    updatedAt: 3000,
    folder: "home",
    tags: ["shopping"],
  },
  {
    id: "b",
    title: "Project plan",
    content: "Ship the MCP connector by Q3. Milestone one.",
    updatedAt: 2000,
    docType: "markdown",
  },
  {
    id: "c",
    title: "Empty",
    content: "",
    updatedAt: 1000,
  },
];

function depsFor(docs: McpDoc[]): McpDeps {
  return {
    listDocs: async () => [...docs].sort((x, y) => y.updatedAt - x.updatedAt),
    getDoc: async (id) => docs.find((d) => d.id === id) || null,
  };
}

describe("isPersonalDocData (MCP scoping — personal docs only)", () => {
  const UID = "owner-uid";
  it("accepts a plain personal doc owned by the uid", () => {
    expect(isPersonalDocData(UID, { ownerId: UID })).toBe(true);
    expect(
      isPersonalDocData(UID, {
        ownerId: UID,
        teamId: null,
        collaboratorUids: [],
      }),
    ).toBe(true);
  });
  it("rejects a doc owned by a different uid", () => {
    expect(isPersonalDocData(UID, { ownerId: "someone-else" })).toBe(false);
    expect(isPersonalDocData(UID, {})).toBe(false);
  });
  it("rejects a team doc (non-empty teamId) even when ownerId matches", () => {
    expect(isPersonalDocData(UID, { ownerId: UID, teamId: "team-123" })).toBe(
      false,
    );
  });
  it("rejects a doc shared out (non-empty collaboratorUids) even when ownerId matches", () => {
    expect(
      isPersonalDocData(UID, {
        ownerId: UID,
        collaboratorUids: ["friend-uid"],
      }),
    ).toBe(false);
  });
  it("does not treat empty-string teamId as a team doc", () => {
    expect(isPersonalDocData(UID, { ownerId: UID, teamId: "" })).toBe(true);
  });
  it("rejects when uid is empty (never expose docs to an unauthenticated caller)", () => {
    expect(isPersonalDocData("", { ownerId: "" })).toBe(false);
  });
});

describe("negotiateProtocolVersion", () => {
  it("echoes a well-formed date version", () => {
    expect(negotiateProtocolVersion("2025-11-25")).toBe("2025-11-25");
    expect(negotiateProtocolVersion("2026-07-28")).toBe("2026-07-28");
  });
  it("falls back to LATEST on missing/malformed input", () => {
    expect(negotiateProtocolVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion("")).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion("v3")).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(2025 as unknown)).toBe(
      LATEST_PROTOCOL_VERSION,
    );
  });
});

describe("buildInitializeResult", () => {
  it("advertises tools capability + server info", () => {
    const r = buildInitializeResult("2025-06-18");
    expect(r.protocolVersion).toBe("2025-06-18");
    expect(r.capabilities.tools).toBeTruthy();
    expect(r.serverInfo.name).toBe("markflow");
    expect(typeof r.instructions).toBe("string");
  });

  it("advertises a brand icon (SEP-973) as a PNG data URI", () => {
    const r = buildInitializeResult("2025-11-25");
    const icons = (
      r.serverInfo as {
        icons?: { src: string; mimeType?: string; sizes?: string[] }[];
      }
    ).icons;
    expect(Array.isArray(icons)).toBe(true);
    expect(icons?.[0]?.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(icons?.[0]?.mimeType).toBe("image/png");
    expect(icons?.[0]?.sizes).toEqual(["128x128"]);
  });
});

describe("TOOLS catalogue", () => {
  it("exposes exactly the five read tools with valid schemas", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_document",
      "get_research",
      "get_transcript",
      "list_documents",
      "search_documents",
    ]);
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });
  it("marks required args", () => {
    const search = TOOLS.find((t) => t.name === "search_documents")!;
    expect((search.inputSchema as { required?: string[] }).required).toEqual([
      "query",
    ]);
    const get = TOOLS.find((t) => t.name === "get_document")!;
    expect((get.inputSchema as { required?: string[] }).required).toEqual([
      "id",
    ]);
  });
});

describe("searchDocuments", () => {
  it("matches title or body, case-insensitively, ranked by recency", () => {
    const hits = searchDocuments(DOCS, "milk", 50);
    expect(hits.map((d) => d.id)).toEqual(["a"]);
    const mcp = searchDocuments(DOCS, "MCP", 50);
    expect(mcp.map((d) => d.id)).toEqual(["b"]);
  });
  it("requires every term to appear (AND semantics)", () => {
    expect(searchDocuments(DOCS, "milk butter", 50).map((d) => d.id)).toEqual([
      "a",
    ]);
    expect(searchDocuments(DOCS, "milk mcp", 50)).toEqual([]);
  });
  it("returns [] for an empty query and respects limit", () => {
    expect(searchDocuments(DOCS, "   ", 50)).toEqual([]);
    const many: McpDoc[] = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      title: `dup ${i}`,
      content: "keyword",
      updatedAt: i,
    }));
    expect(searchDocuments(many, "keyword", 3).length).toBe(3);
  });
});

describe("snippet", () => {
  it("windows around the first hit", () => {
    const s = snippet(
      "prefix ".repeat(30) + "TARGET " + "suffix ".repeat(30),
      "target",
    );
    expect(s).toContain("TARGET");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });
  it("returns head of body when query is not in content", () => {
    expect(snippet("short body", "missing")).toBe("short body");
  });
  it("handles empty content", () => {
    expect(snippet("", "x")).toBe("(empty document)");
  });
});

describe("formatting", () => {
  it("formatDocList shows count, ids and truncation note", () => {
    const out = formatDocList(DOCS, 2);
    expect(out).toContain("Showing 2 of 3");
    expect(out).toContain("id: a");
    expect(out).toContain("id: b");
    expect(out).not.toContain("id: c");
  });
  it("formatDocList handles empty", () => {
    expect(formatDocList([], 10)).toBe("No documents found.");
  });
  it("formatDocFull includes metadata and full body", () => {
    const out = formatDocFull(DOCS[1]);
    expect(out).toContain("Title: Project plan");
    expect(out).toContain("Id: b");
    expect(out).toContain("Ship the MCP connector");
  });
  it("formatSearchResults reports no match", () => {
    expect(formatSearchResults([], "zzz")).toContain(
      'No documents match "zzz"',
    );
  });
});

describe("callTool", () => {
  it("list_documents clamps limit into range", async () => {
    const r = await callTool("list_documents", { limit: 9999 }, depsFor(DOCS));
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("3 documents");
  });
  it("search_documents requires a query", async () => {
    const r = await callTool("search_documents", {}, depsFor(DOCS));
    expect(r.isError).toBe(true);
  });
  it("get_document returns full content", async () => {
    const r = await callTool("get_document", { id: "b" }, depsFor(DOCS));
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("Ship the MCP connector");
  });
  it("get_document errors on unknown id (authorization boundary)", async () => {
    const r = await callTool("get_document", { id: "nope" }, depsFor(DOCS));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("No document found");
  });
  it("rejects unknown tool", async () => {
    const r = await callTool("delete_everything", {}, depsFor(DOCS));
    expect(r.isError).toBe(true);
  });
});

describe("clampLimit via MAX", () => {
  it("MAX_LIST_LIMIT bounds are sane", () => {
    expect(MAX_LIST_LIMIT).toBeGreaterThanOrEqual(DEFAULT_LIST_LIMIT);
  });
});

describe("handleMcpMessage", () => {
  const deps = depsFor(DOCS);
  it("answers initialize with negotiated version", async () => {
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      },
      deps,
    );
    expect(res?.result).toMatchObject({ protocolVersion: "2025-11-25" });
  });
  it("returns null for initialized notification", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      deps,
    );
    expect(res).toBeNull();
  });
  it("lists tools", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      deps,
    );
    expect((res?.result as { tools: unknown[] }).tools.length).toBe(5);
  });
  it("dispatches tools/call", async () => {
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_document", arguments: { id: "a" } },
      },
      deps,
    );
    const result = res?.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("Grocery list");
  });
  it("tools/call with missing name → invalid params", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: {} },
      deps,
    );
    expect(res?.error?.code).toBe(-32602);
  });
  it("unknown request method → method not found", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 5, method: "wat" },
      deps,
    );
    expect(res?.error?.code).toBe(-32601);
  });
  it("unknown notification → swallowed", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", method: "notifications/wat" },
      deps,
    );
    expect(res).toBeNull();
  });
  it("responds to ping", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 6, method: "ping" },
      deps,
    );
    expect(res?.result).toEqual({});
  });
  it("tool exceptions surface as in-band isError, not transport errors", async () => {
    const boom: McpDeps = {
      listDocs: async () => {
        throw new Error("firestore down");
      },
      getDoc: async () => null,
    };
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "list_documents", arguments: {} },
      },
      boom,
    );
    expect(res?.error).toBeUndefined();
    const result = res?.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    // The internal cause must NOT leak to the client; only a generic message.
    expect(result.content[0].text).not.toContain("firestore down");
    expect(result.content[0].text).toContain("Tool execution failed");
  });
});

describe("JSON-RPC helpers", () => {
  it("isRequest detects a method field", () => {
    expect(isRequest({ jsonrpc: "2.0", method: "x" })).toBe(true);
    expect(isRequest({ jsonrpc: "2.0" })).toBe(false);
    expect(isRequest(null)).toBe(false);
  });
  it("hasId distinguishes requests from notifications", () => {
    expect(hasId({ jsonrpc: "2.0", id: 0, method: "x" })).toBe(true);
    expect(hasId({ jsonrpc: "2.0", method: "x" })).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Write surface — create_document (create-only import "inbox")
// ---------------------------------------------------------------------

// A deps object WITH a createDoc spy → write-enabled connection. The spy echoes a
// synthetic McpDoc so callTool's success path (formatCreatedDoc) can be asserted.
function depsForWrite(
  docs: McpDoc[],
  createImpl?: (input: CreateDocInput) => Promise<CreateDocResult>,
): McpDeps & { createDoc: ReturnType<typeof vi.fn> } {
  const createDoc = vi.fn(
    createImpl ??
      (async (input: CreateDocInput): Promise<CreateDocResult> => ({
        ok: true,
        doc: {
          id: "new-id",
          title: input.title,
          content: input.content,
          updatedAt: 5000,
          createdAt: 5000,
          folder: "/Claude",
          tags: input.tags,
          docType: "markdown",
        },
      })),
  );
  return {
    listDocs: async () => [...docs].sort((x, y) => y.updatedAt - x.updatedAt),
    getDoc: async (id) => docs.find((d) => d.id === id) || null,
    createDoc,
  };
}

describe("toolsFor (write tool advertised only when write-enabled)", () => {
  it("read-only → exactly the five read tools, no create_document", () => {
    const names = toolsFor(false).map((t) => t.name);
    expect(names).toEqual([
      "list_documents",
      "search_documents",
      "get_document",
      "get_transcript",
      "get_research",
    ]);
    expect(names).not.toContain("create_document");
  });
  it("write-enabled → read tools plus create_document (6 total)", () => {
    const names = toolsFor(true).map((t) => t.name);
    expect(names).toContain("create_document");
    expect(names.length).toBe(6);
    // Read tools are still present + unchanged.
    expect(names).toEqual(
      expect.arrayContaining([
        "list_documents",
        "search_documents",
        "get_document",
      ]),
    );
  });
});

describe("CREATE_DOCUMENT_TOOL schema + hints", () => {
  it("requires only content, rejects unknown args (additionalProperties:false)", () => {
    expect(CREATE_DOCUMENT_TOOL.name).toBe("create_document");
    const schema = CREATE_DOCUMENT_TOOL.inputSchema as {
      required?: string[];
      additionalProperties?: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["content"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "content",
      "tags",
      "title",
    ]);
  });
  it("declares accurate mutating-but-additive annotations", () => {
    const a = CREATE_DOCUMENT_TOOL.annotations as Record<string, boolean>;
    expect(a.readOnlyHint).toBe(false); // it writes
    expect(a.destructiveHint).toBe(false); // never overwrites/deletes
    expect(a.idempotentHint).toBe(false); // each call creates another doc
    expect(a.openWorldHint).toBe(false);
  });
});

describe("callTool create_document", () => {
  it("is refused when the connection is read-only (no deps.createDoc)", async () => {
    const r = await callTool(
      "create_document",
      { content: "hello" },
      depsFor(DOCS),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("not enabled");
  });

  it("rejects missing/empty/whitespace content without calling createDoc", async () => {
    const deps = depsForWrite(DOCS);
    for (const args of [{}, { content: "" }, { content: "   \n\t  " }]) {
      const r = await callTool("create_document", args, deps);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("content");
    }
    expect(deps.createDoc).not.toHaveBeenCalled();
  });

  it("rejects content over the size cap without calling createDoc", async () => {
    const deps = depsForWrite(DOCS);
    const huge = "x".repeat(MAX_CREATE_CONTENT_CHARS + 1);
    const r = await callTool("create_document", { content: huge }, deps);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("too large");
    expect(deps.createDoc).not.toHaveBeenCalled();
  });

  it("creates with a derived title when none is supplied, returns confirmation", async () => {
    const deps = depsForWrite(DOCS);
    const r = await callTool(
      "create_document",
      { content: "# My Heading\n\nbody text" },
      deps,
    );
    expect(r.isError).toBeFalsy();
    expect(deps.createDoc).toHaveBeenCalledTimes(1);
    const passed = deps.createDoc.mock.calls[0][0] as CreateDocInput;
    expect(passed.title).toBe("My Heading");
    expect(passed.content).toBe("# My Heading\n\nbody text");
    expect(r.content[0].text).toContain("Created a new document");
    expect(r.content[0].text).toContain("My Heading");
  });

  it("uses an explicit title (trimmed + capped)", async () => {
    const deps = depsForWrite(DOCS);
    const longTitle = "T".repeat(MAX_CREATE_TITLE_CHARS + 50);
    await callTool(
      "create_document",
      { content: "body", title: `   ${longTitle}   ` },
      deps,
    );
    const passed = deps.createDoc.mock.calls[0][0] as CreateDocInput;
    expect(passed.title.length).toBe(MAX_CREATE_TITLE_CHARS);
    expect(passed.title).toBe(longTitle.slice(0, MAX_CREATE_TITLE_CHARS));
  });

  it("normalizes tags: trims, drops blanks/non-strings, de-dupes, caps count + length", async () => {
    const deps = depsForWrite(DOCS);
    const many = Array.from(
      { length: MAX_CREATE_TAGS + 10 },
      (_, i) => `tag${i}`,
    );
    await callTool(
      "create_document",
      {
        content: "body",
        tags: [
          "  alpha  ",
          "alpha", // duplicate → dropped
          "", // blank → dropped
          42 as unknown as string, // non-string → dropped
          "z".repeat(MAX_CREATE_TAG_CHARS + 20), // over-long → capped
          ...many,
        ],
      },
      deps,
    );
    const passed = deps.createDoc.mock.calls[0][0] as CreateDocInput;
    expect(passed.tags.length).toBeLessThanOrEqual(MAX_CREATE_TAGS);
    expect(passed.tags).toContain("alpha");
    // de-dup: "alpha" appears once
    expect(passed.tags.filter((t) => t === "alpha").length).toBe(1);
    // no blank / non-string leaked
    expect(passed.tags).not.toContain("");
    // each tag within the per-tag cap
    for (const t of passed.tags) {
      expect(t.length).toBeLessThanOrEqual(MAX_CREATE_TAG_CHARS);
    }
  });

  it("surfaces a createDoc failure ({ok:false}) as an in-band tool error", async () => {
    const deps = depsForWrite(DOCS, async () => ({
      ok: false,
      message: "Rate limit exceeded. Try again later.",
    }));
    const r = await callTool("create_document", { content: "body" }, deps);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Rate limit exceeded");
  });
});

describe("handleMcpMessage tools/list reflects write-eligibility", () => {
  it("lists 6 tools including create_document for a write-enabled connection", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 20, method: "tools/list" },
      depsForWrite(DOCS),
    );
    const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBe(6);
    expect(tools.map((t) => t.name)).toContain("create_document");
  });
  it("still lists only the 5 read tools for a read-only connection", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 21, method: "tools/list" },
      depsFor(DOCS),
    );
    const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBe(5);
    expect(tools.map((t) => t.name)).not.toContain("create_document");
  });
  it("dispatches a create_document tools/call end-to-end", async () => {
    const deps = depsForWrite(DOCS);
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "create_document",
          arguments: { content: "hello world" },
        },
      },
      deps,
    );
    const result = res?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Created a new document");
    expect(deps.createDoc).toHaveBeenCalledTimes(1);
  });
});

describe("deriveTitleFromMarkdown", () => {
  it("prefers the first ATX heading", () => {
    expect(deriveTitleFromMarkdown("## Section Two\n\nbody")).toBe(
      "Section Two",
    );
    expect(deriveTitleFromMarkdown("intro line\n# Real Title\nmore")).toBe(
      "intro line",
    ); // first non-blank wins when it precedes the heading
  });
  it("uses the first non-blank line and strips list/quote markers", () => {
    expect(deriveTitleFromMarkdown("- bullet point")).toBe("bullet point");
    expect(deriveTitleFromMarkdown("> quoted")).toBe("quoted");
    expect(deriveTitleFromMarkdown("1. numbered")).toBe("numbered");
    expect(deriveTitleFromMarkdown("\n\n   spaced   \n")).toBe("spaced");
  });
  it("falls back to 'Untitled' for empty/whitespace content", () => {
    expect(deriveTitleFromMarkdown("")).toBe("Untitled");
    expect(deriveTitleFromMarkdown("   \n\t\n  ")).toBe("Untitled");
  });
  it("caps the derived title length", () => {
    const long = "w".repeat(MAX_CREATE_TITLE_CHARS + 100);
    expect(deriveTitleFromMarkdown(long).length).toBe(MAX_CREATE_TITLE_CHARS);
  });
});

describe("formatCreatedDoc", () => {
  it("includes title, id, folder and tags", () => {
    const out = formatCreatedDoc({
      id: "xyz",
      title: "Imported note",
      content: "…",
      updatedAt: 1,
      folder: "/Claude",
      tags: ["a", "b"],
    });
    expect(out).toContain("Created a new document");
    expect(out).toContain("Title: Imported note");
    expect(out).toContain("Id: xyz");
    expect(out).toContain("Folder: /Claude");
    expect(out).toContain("Tags: a, b");
  });
});

// ---------------------------------------------------------------------
// get_transcript / get_research
// ---------------------------------------------------------------------

const TX_DOC: McpDoc = {
  id: "v",
  title: "Kickoff",
  content: "## Summary\n- structured body",
  updatedAt: 5000,
  transcriptChars: 0, // filled below
};
const TX_TEXT = "ネクストゲートの件です。".repeat(3000); // 36,000 chars
TX_DOC.transcriptChars = TX_TEXT.length;

const SESSIONS: McpResearchSession[] = [
  {
    id: "s1",
    startedAt: Date.UTC(2026, 8, 16, 8, 5),
    endedAt: Date.UTC(2026, 8, 16, 9, 28),
    cards: [
      {
        type: "topic",
        query: "hacomono とは",
        summary: "フィットネス向け会員管理システム。",
        sources: [{ title: "hacomono", url: "https://www.hacomono.jp/" }],
        integrated: true,
      },
      {
        type: "question",
        query: "API連携の許可は誰が出す？",
        summary: "先方に確認する。",
        sources: [],
        integrated: false,
      },
    ],
  },
];

const BIG: McpResearchSession[] = [
  {
    id: "s-a",
    startedAt: 1,
    endedAt: null,
    cards: Array.from({ length: 30 }, (_, i) => ({
      type: "topic",
      query: `q${i}`,
      summary: "z".repeat(2000),
      sources: [],
    })),
  },
  {
    id: "s-b",
    startedAt: 2,
    endedAt: null,
    cards: Array.from({ length: 10 }, (_, i) => ({
      type: "topic",
      query: `q${30 + i}`,
      summary: "z".repeat(2000),
      sources: [],
    })),
  },
];
const HUGE_CARDS: McpResearchSession[] = [
  {
    id: "s-h",
    startedAt: 1,
    endedAt: null,
    cards: Array.from({ length: 3 }, (_, i) => ({
      type: "topic",
      query: `h${i}`,
      summary: "y".repeat(MAX_RESEARCH_OUTPUT_CHARS * 0.6),
      sources: [],
    })),
  },
];

function depsWithVoice(
  overrides: Partial<McpDeps> = {},
  opts: { tx?: string; sessions?: McpResearchSession[] | null } = {},
): McpDeps {
  const tx = opts.tx ?? TX_TEXT;
  const docs = [TX_DOC, ...DOCS];
  return {
    listDocs: async () => docs,
    getDoc: async (id) => docs.find((d) => d.id === id) || null,
    getTranscript: async (id): Promise<McpTranscript | null> =>
      id === "v"
        ? { id, title: "Kickoff", text: tx, recordedAt: 6000, audioStored: true }
        : docs.some((d) => d.id === id)
          ? { id, title: "x", text: "", audioStored: false }
          : null,
    getResearch: async (id) =>
      id === "v"
        ? opts.sessions === undefined
          ? SESSIONS
          : opts.sessions
        : docs.some((d) => d.id === id)
          ? []
          : null,
    ...overrides,
  };
}

describe("sliceTranscript", () => {
  it("pages from offset and reports the continuation offset", () => {
    const r = sliceTranscript("abcdefghij", 2, 5);
    expect(r).toEqual({ chunk: "cdefg", start: 2, end: 7, total: 10 });
  });
  it("backs the cut off to a sentence end inside the last 10% of the page", () => {
    const text = "a".repeat(95) + "。" + "b".repeat(50);
    const r = sliceTranscript(text, 0, 100);
    expect(r.end).toBe(96); // right after 。
    expect(r.chunk.endsWith("。")).toBe(true);
  });
  it("does not back off when no boundary is near the cut", () => {
    const text = "。" + "a".repeat(200);
    expect(sliceTranscript(text, 0, 100).end).toBe(100);
  });
  it("never splits a surrogate pair at either edge", () => {
    const text = "ab😀cd😀ef"; // 😀 is 2 UTF-16 units
    const cutInside = sliceTranscript(text, 0, 3); // would end between the pair
    expect(cutInside.chunk).toBe("ab");
    const startInside = sliceTranscript(text, 3, 10); // starts on a low surrogate
    expect(startInside.chunk.startsWith("😀")).toBe(true);
  });
  it("clamps an offset past the end to an empty page", () => {
    const r = sliceTranscript("abc", 99, 10);
    expect(r).toEqual({ chunk: "", start: 3, end: 3, total: 3 });
  });
});

describe("formatTranscriptPage", () => {
  const t: McpTranscript = {
    id: "v",
    title: "Kickoff",
    text: "x".repeat(2500),
    recordedAt: Date.UTC(2026, 8, 16, 9, 28),
    audioStored: false,
  };
  it("shows metadata, the range and a continuation hint", () => {
    const out = formatTranscriptPage(t, 0, 1000);
    expect(out).toContain("Title: Kickoff");
    expect(out).toContain("Recorded: 2026-09-16 18:28"); // Asia/Tokyo
    expect(out).toContain("Audio stored: no");
    expect(out).toContain("Transcript: 2,500 chars — showing 0–1,000");
    expect(out).toContain('get_transcript {"id": "v", "offset": 1000}');
    expect(out).toContain("misheard");
  });
  it("marks the last page as the end", () => {
    const out = formatTranscriptPage(t, 2000, 1000);
    expect(out).toContain("showing 2,000–2,500");
    expect(out).toContain("End of transcript.");
    expect(out).not.toContain("Continue with");
  });
});

describe("formatResearch", () => {
  it("renders sessions, labels question cards and integration status", () => {
    const out = formatResearch({ id: "v", title: "Kickoff" }, SESSIONS);
    expect(out).toContain("1 research session, 2 cards");
    expect(out).toContain("## Session 2026-09-16 17:05 – 2026-09-16 18:28");
    expect(out).toContain("### #1 [topic] hacomono とは");
    expect(out).toContain("(woven into the document)");
    expect(out).toContain("- hacomono — https://www.hacomono.jp/");
    expect(out).toContain("### #2 [follow-up question (not a fact)] API連携の許可は誰が出す？");
    expect(out).toContain("(not in the document)");
  });
  it("says so when there are no cards", () => {
    expect(formatResearch({ id: "v", title: "K" }, [])).toContain(
      "No research cards for this document.",
    );
  });
  it("switches to a numbered index when the full rendering is too large", () => {
    const out = formatResearch({ id: "v", title: "K" }, BIG);
    expect(out.length).toBeLessThan(MAX_RESEARCH_OUTPUT_CHARS);
    expect(out).toContain("40 cards — too many to show in full, so this is an index.");
    expect(out).toContain('get_research {"id": "v", "cards": [numbers]}');
    // every card is listed, numbered, without its summary
    expect(out).toContain("#1 [topic] q0");
    expect(out).toContain("#40 [topic] q39");
    expect(out).not.toContain("zzzz");
    // numbering continues across sessions
    expect(out).toContain("## Session");
  });
  it("renders only the picked cards, keeping their global numbers", () => {
    const out = formatResearch({ id: "v", title: "K" }, BIG, [2, 31]);
    expect(out).toContain("40 cards — showing 2");
    expect(out).toContain("### #2 [topic] q1");
    expect(out).toContain("### #31 [topic] q30");
    expect(out).not.toContain("### #3 ");
  });
  it("reports unknown card numbers and cards cut by the size cap", () => {
    const out = formatResearch({ id: "v", title: "K" }, HUGE_CARDS, [1, 2, 3, 99]);
    expect(out).toContain("No such card number(s): 99 (valid: 1–3).");
    expect(out).toMatch(/Not shown \(output size limit\) — request again: \d/);
    expect(out.length).toBeLessThan(MAX_RESEARCH_OUTPUT_CHARS * 2 + 1000);
  });
});

describe("callTool get_transcript", () => {
  it("returns the first page by default", async () => {
    const r = await callTool("get_transcript", { id: "v" }, depsWithVoice());
    expect(r.isError).toBeUndefined();
    const text = r.content[0].text;
    expect(text).toContain("Transcript: 36,000 chars");
    expect(text).toContain("Audio stored: yes");
    expect(text).toContain("Continue with get_transcript");
    // default page size (± boundary back-off)
    const body = text.split("\n\n---\n\n")[1];
    expect(body.length).toBeLessThanOrEqual(DEFAULT_TRANSCRIPT_CHARS);
    expect(body.length).toBeGreaterThan(DEFAULT_TRANSCRIPT_CHARS * 0.9);
  });
  it("honours offset and clamps max_chars into range", async () => {
    const huge = await callTool(
      "get_transcript",
      { id: "v", offset: 0, max_chars: 10_000_000 },
      depsWithVoice(),
    );
    const body = huge.content[0].text.split("\n\n---\n\n")[1];
    expect(body.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    const tail = await callTool(
      "get_transcript",
      { id: "v", offset: 35_000, max_chars: 5000 },
      depsWithVoice(),
    );
    expect(tail.content[0].text).toContain("End of transcript.");
  });
  it("rejects an offset past the end", async () => {
    const r = await callTool(
      "get_transcript",
      { id: "v", offset: 99_999 },
      depsWithVoice(),
    );
    expect(r.isError).toBe(true);
  });
  it("reports a document without a transcript (not an error)", async () => {
    const r = await callTool("get_transcript", { id: "a" }, depsWithVoice());
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("This document has no transcript.");
  });
  it("errors for an unknown / non-personal id (authorization boundary)", async () => {
    const r = await callTool("get_transcript", { id: "nope" }, depsWithVoice());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('No document found with id "nope"');
  });
  it("requires an id and is refused when the deps don't provide it", async () => {
    expect((await callTool("get_transcript", {}, depsWithVoice())).isError).toBe(true);
    const r = await callTool("get_transcript", { id: "v" }, depsFor(DOCS));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("not enabled");
  });
});

describe("callTool get_research", () => {
  it("renders the document's research cards", async () => {
    const r = await callTool("get_research", { id: "v" }, depsWithVoice());
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("### #1 [topic] hacomono とは");
  });
  it("passes picked card numbers through and validates them", async () => {
    const r = await callTool("get_research", { id: "v", cards: [2] }, depsWithVoice());
    expect(r.content[0].text).toContain("showing 1");
    expect(r.content[0].text).toContain("### #2 ");
    expect(r.content[0].text).not.toContain("### #1 ");
    const bad = await callTool("get_research", { id: "v", cards: "2" }, depsWithVoice());
    expect(bad.isError).toBe(true);
    const empty = await callTool("get_research", { id: "v", cards: [] }, depsWithVoice());
    expect(empty.isError).toBe(true);
    const tooMany = await callTool(
      "get_research",
      { id: "v", cards: Array.from({ length: MAX_RESEARCH_CARDS_PER_CALL + 1 }, (_, i) => i + 1) },
      depsWithVoice(),
    );
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content[0].text).toContain("Too many cards");
  });
  it("errors for an unknown / non-personal id", async () => {
    const r = await callTool("get_research", { id: "nope" }, depsWithVoice());
    expect(r.isError).toBe(true);
  });
  it("does not read research when the parent doc is not visible", async () => {
    const getResearch = vi.fn(async () => SESSIONS);
    const r = await callTool(
      "get_research",
      { id: "hidden" },
      depsWithVoice({ getResearch }),
    );
    expect(r.isError).toBe(true);
    expect(getResearch).not.toHaveBeenCalled();
  });
});

describe("get_document surfaces transcript / research availability", () => {
  it("adds transcript size and research count to the header only", async () => {
    const r = await callTool("get_document", { id: "v" }, depsWithVoice());
    const text = r.content[0].text;
    expect(text).toContain("Transcript: 36,000 chars (read with get_transcript)");
    expect(text).toContain("Research: 2 cards (read with get_research)");
    // the transcript itself is NOT inlined
    expect(text).not.toContain("ネクストゲートの件です。");
  });
  it("omits both lines for a plain document", async () => {
    const r = await callTool("get_document", { id: "a" }, depsWithVoice());
    expect(r.content[0].text).not.toContain("Transcript:");
    expect(r.content[0].text).not.toContain("Research:");
  });
  it("list_documents flags documents that have a transcript", () => {
    const out = formatDocList([TX_DOC, ...DOCS], 10);
    expect(out).toContain("transcript: 36,000 chars");
    expect(out.match(/transcript:/g)?.length).toBe(1);
  });
});
