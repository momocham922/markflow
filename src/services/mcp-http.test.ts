import { describe, it, expect } from "vitest";
import {
  parseSseMessages,
  parseRpcResponse,
  parseToolsList,
  type McpHttpRaw,
} from "./mcp-http";

const raw = (over: Partial<McpHttpRaw>): McpHttpRaw => ({
  status: 200,
  contentType: "application/json",
  body: "",
  sessionId: null,
  ...over,
});

describe("parseSseMessages", () => {
  it("reads the JSON-RPC messages out of a Streamable-HTTP stream", () => {
    const body =
      "event: message\n" +
      'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n' +
      "\n";
    expect(parseSseMessages(body)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    ]);
  });
  it("skips comment lines, keepalives and unparsable payloads", () => {
    const body =
      ": keepalive\n" +
      "data: not json\n" +
      "data: [DONE]\n" +
      'data: {"jsonrpc":"2.0","id":2,"result":{}}\n';
    expect(parseSseMessages(body)).toEqual([
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });
});

describe("parseRpcResponse", () => {
  it("accepts a plain JSON body", () => {
    const out = parseRpcResponse(
      raw({ body: '{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}' }),
      7,
    );
    expect(out).toEqual({ ok: true, result: { tools: [] } });
  });

  it("accepts the same answer delivered as SSE", () => {
    const out = parseRpcResponse(
      raw({
        contentType: "text/event-stream; charset=utf-8",
        body: 'data: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n',
      }),
      7,
    );
    expect(out).toEqual({ ok: true, result: { tools: [] } });
  });

  it("picks the message answering this request id", () => {
    const out = parseRpcResponse(
      raw({
        contentType: "text/event-stream",
        body:
          'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n' +
          'data: {"jsonrpc":"2.0","id":3,"result":{"mine":true}}\n' +
          'data: {"jsonrpc":"2.0","id":4,"result":{"mine":false}}\n',
      }),
      3,
    );
    expect(out).toEqual({ ok: true, result: { mine: true } });
  });

  // Status is read before the body: a 401 carrying prose must still say
  // "your token was rejected", which is the thing the user can act on.
  it("reports a rejected token rather than the body's wording", () => {
    const out = parseRpcResponse(
      raw({ status: 401, body: '{"error":{"message":"nope"}}' }),
      1,
    );
    expect(out).toMatchObject({ ok: false, code: "auth" });
  });

  it("explains a 404 as a wrong endpoint path", () => {
    const out = parseRpcResponse(raw({ status: 404, body: "" }), 1);
    expect(out).toMatchObject({ ok: false, code: "not_found" });
  });

  // The Rust side refuses to follow redirects so the bearer is never replayed
  // to another host; the user has to be told why nothing happened.
  it("explains a refused redirect", () => {
    const out = parseRpcResponse(raw({ status: 302, body: "" }), 1);
    expect(out).toMatchObject({ ok: false, code: "redirect" });
    expect((out as { message: string }).message).toContain("トークン");
  });

  it("surfaces a JSON-RPC error message", () => {
    const out = parseRpcResponse(
      raw({
        body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}',
      }),
      1,
    );
    expect(out).toMatchObject({ ok: false, code: "rpc" });
    expect((out as { message: string }).message).toContain("Method not found");
  });

  it("does not mistake an HTML error page for an answer", () => {
    const out = parseRpcResponse(
      raw({ status: 500, contentType: "text/html", body: "<html>oops</html>" }),
      1,
    );
    expect(out).toMatchObject({ ok: false, code: "http" });
  });

  it("reports an empty 200 instead of pretending it succeeded", () => {
    expect(parseRpcResponse(raw({ body: "" }), 1)).toMatchObject({
      ok: false,
      code: "empty",
    });
  });
});

describe("parseToolsList", () => {
  // Shaped like a real tools/list reply, including a tool that declares nothing.
  it("keeps the read-only annotation and drops nameless entries", () => {
    const tools = parseToolsList({
      tools: [
        {
          name: "query_events",
          description: "イベントを時系列取得する",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        { name: "send_message", inputSchema: {} },
        { description: "no name at all" },
      ],
    });
    expect(tools.map((t) => t.name)).toEqual(["query_events", "send_message"]);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true });
    // Absent annotations must stay absent — not defaulted to read-only.
    expect(tools[1].annotations).toBeUndefined();
  });

  it("ignores a non-boolean readOnlyHint rather than trusting it", () => {
    const tools = parseToolsList({
      tools: [{ name: "x", annotations: { readOnlyHint: "true" } }],
    });
    expect(tools[0].annotations).toBeUndefined();
  });

  it("survives a result with no tools array", () => {
    expect(parseToolsList({})).toEqual([]);
  });
});
