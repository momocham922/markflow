import { describe, it, expect } from "vitest";
import {
  negotiateProtocolVersion,
  LATEST_PROTOCOL_VERSION,
  buildInitializeResult,
  TOOLS,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  searchDocuments,
  formatDocList,
  formatDocFull,
  formatSearchResults,
  snippet,
  callTool,
  handleMcpMessage,
  isRequest,
  hasId,
  isPersonalDocData,
  type McpDoc,
  type McpDeps,
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
        icons?: { src: string; mimeType?: string; sizes?: string }[];
      }
    ).icons;
    expect(Array.isArray(icons)).toBe(true);
    expect(icons?.[0]?.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(icons?.[0]?.mimeType).toBe("image/png");
    expect(icons?.[0]?.sizes).toBe("128x128");
  });
});

describe("TOOLS catalogue", () => {
  it("exposes exactly the three read tools with valid schemas", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_document",
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
    expect((res?.result as { tools: unknown[] }).tools.length).toBe(3);
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
