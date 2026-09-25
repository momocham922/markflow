import { describe, it, expect } from "vitest";
import { probeWindow, type McpToolInfo } from "./context-slots";
import {
  scoreToolForSlot,
  rankCandidates,
  buildProbeArgs,
  probeServer,
  type CallTool,
} from "./context-probe";

// Tool descriptors copied verbatim from a real MCP aggregator's tools/list
// (2026-09-24). The argument builder has to work against these exactly — this is
// the schema shape it will actually meet, not a tidied-up version of one.
const QUERY_EVENTS: McpToolInfo = {
  name: "query_events",
  description:
    "検索語なしで窓/源/型の条件でイベントを時系列取得する(例: ある源の直近の記録一覧)。各行は源/型/時刻/タイトル/本文抜粋/id。",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      order: { type: "string" },
      sinceMs: { type: "number" },
      source: { type: "string" },
      type: { type: "string" },
      untilMs: { type: "number" },
    },
  },
};

const SEARCH_EVENTS: McpToolInfo = {
  name: "search_events",
  description: "史料ハブを日本語対応の全文検索(bigram 部分一致)で引く。",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      query: { type: "string" },
      sinceMs: { type: "number" },
      source: { type: "string" },
      untilMs: { type: "number" },
    },
    required: ["query"],
  },
};

// The shape a calendar server tends to use: ISO strings, not epoch ms.
const LIST_CAL_EVENTS: McpToolInfo = {
  name: "list_calendar_events",
  description: "List calendar events and their attendees in a time range.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {
      timeMin: { type: "string", format: "date-time" },
      timeMax: { type: "string", format: "date-time" },
      maxResults: { type: "integer" },
    },
  },
};

const SEND_MESSAGE: McpToolInfo = {
  name: "send_message",
  description: "Send a chat message to a channel.",
  // no annotations at all — the dangerous case
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

const REAL_CHATWORK_RESULT = {
  content: [
    {
      type: "text",
      text: `イベント時系列 2件 源=chatwork(古い順)

• 三田 遼平さん 堀ノ上陽太_AVALINKさん https://us02web.zoom.us/j/88065846313
  chatwork/message.mention · 2026-09-18 14:54 · 場所: ゲンダイ×DROM · 相手: 齋藤 和也

• https://www.facebook.com/profile.php?id=61594662142745
  chatwork/message.received · 2026-09-18 15:02 · 場所: ゲンダイ×DROM · 相手: 齋藤 和也`,
    },
  ],
};

const WINDOW = probeWindow(Date.parse("2026-09-18T06:00:00Z"));

describe("scoreToolForSlot", () => {
  it("scores a timeline tool for messages", () => {
    expect(scoreToolForSlot(QUERY_EVENTS, "messages")).toBeGreaterThan(0);
  });
  it("pushes writing tools below zero however they are described", () => {
    expect(scoreToolForSlot(SEND_MESSAGE, "messages")).toBeLessThan(0);
  });
  it("is unmoved by a tool about something else entirely", () => {
    expect(
      scoreToolForSlot(
        { name: "search_pages", description: "Search your wiki pages." },
        "messages",
      ),
    ).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("drops every tool that is not declared read-only", () => {
    const ranked = rankCandidates(
      [QUERY_EVENTS, SEND_MESSAGE, LIST_CAL_EVENTS],
      "messages",
    );
    expect(ranked.map((t) => t.name)).not.toContain("send_message");
  });
  it("returns nothing when a server annotates nothing", () => {
    expect(rankCandidates([SEND_MESSAGE], "messages")).toEqual([]);
  });
});

describe("buildProbeArgs", () => {
  it("fills epoch-millisecond bounds from a numeric schema", () => {
    const { args, unfilledRequired } = buildProbeArgs(
      QUERY_EVENTS.inputSchema as never,
      WINDOW,
    );
    expect(args).toEqual({
      sinceMs: WINDOW.sinceMs,
      untilMs: WINDOW.untilMs,
      limit: 20,
    });
    expect(unfilledRequired).toEqual([]);
  });

  it("fills ISO strings when the schema asks for strings", () => {
    const { args } = buildProbeArgs(
      LIST_CAL_EVENTS.inputSchema as never,
      WINDOW,
    );
    expect(args.timeMin).toBe(new Date(WINDOW.sinceMs).toISOString());
    expect(args.timeMax).toBe(new Date(WINDOW.untilMs).toISOString());
    expect(args.maxResults).toBe(20);
  });

  it("reports a required free-text parameter instead of inventing one", () => {
    const { unfilledRequired } = buildProbeArgs(
      SEARCH_EVENTS.inputSchema as never,
      WINDOW,
    );
    expect(unfilledRequired).toEqual(["query"]);
  });

  it("does not mistake fromUser / toChannel for time bounds", () => {
    const { args } = buildProbeArgs(
      {
        type: "object",
        properties: {
          fromUser: { type: "string" },
          toChannel: { type: "string" },
        },
      },
      WINDOW,
    );
    expect(args).toEqual({});
  });
});

describe("probeServer", () => {
  it("keeps a server whose timeline tool actually answers", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool: CallTool = async (name, args) => {
      calls.push({ name, args });
      return REAL_CHATWORK_RESULT;
    };
    const report = await probeServer(
      [QUERY_EVENTS, SEARCH_EVENTS, SEND_MESSAGE],
      WINDOW,
      callTool,
    );
    expect(report.decision.keep).toBe(true);
    expect(report.decision.filled).toContain("messages");
    // send_message must never have been invoked.
    expect(calls.map((c) => c.name)).not.toContain("send_message");
    // and it probed with the real window
    expect(calls[0].args.sinceMs).toBe(WINDOW.sinceMs);
  });

  it("records why a tool was skipped rather than silently ignoring it", async () => {
    const callTool: CallTool = async () => REAL_CHATWORK_RESULT;
    const report = await probeServer([SEARCH_EVENTS], WINDOW, callTool);
    const skipped = report.attempts.find((a) => a.skipped);
    expect(skipped?.tool).toBe("search_events");
    expect(skipped?.skipped).toContain("query");
    expect(report.decision.keep).toBe(false);
  });

  it("refuses a server that offers nothing verifiable", async () => {
    const report = await probeServer(
      [SEND_MESSAGE],
      WINDOW,
      async () => REAL_CHATWORK_RESULT,
    );
    expect(report.decision.keep).toBe(false);
    expect(report.decision.message).toContain("読み取り専用");
  });

  it("survives a tool that throws and reports it", async () => {
    const callTool: CallTool = async (name) => {
      if (name === "query_events") throw new Error("401 unauthorized");
      return REAL_CHATWORK_RESULT;
    };
    const report = await probeServer([QUERY_EVENTS], WINDOW, callTool);
    expect(report.attempts[0].error).toContain("401");
    expect(report.decision.keep).toBe(false);
  });

  it("stops calling a slot's tools once one passes", async () => {
    const other: McpToolInfo = {
      ...QUERY_EVENTS,
      name: "query_messages_alt",
    };
    let n = 0;
    const callTool: CallTool = async () => {
      n += 1;
      return REAL_CHATWORK_RESULT;
    };
    await probeServer([QUERY_EVENTS, other], WINDOW, callTool);
    // the first candidate passes, so the second is never called
    expect(n).toBe(1);
  });
});

// Regression: `\bsend\b` does not match `send_message` because `_` is a word
// character, so every snake_case write tool used to escape the penalty.
describe("write-tool penalty across naming conventions", () => {
  it.each([
    "send_message",
    "sendMessage",
    "create-event",
    "delete_file",
    "postMessage",
  ])("penalises %s", (name) => {
    expect(
      scoreToolForSlot({ name, description: "message chat" }, "messages"),
    ).toBeLessThan(0);
  });
  it("does not penalise a read tool that merely contains a similar word", () => {
    expect(
      scoreToolForSlot(
        { name: "list_messages", description: "List chat messages." },
        "messages",
      ),
    ).toBeGreaterThan(0);
  });
});
