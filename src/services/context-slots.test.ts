import { describe, it, expect } from "vitest";
import {
  SLOTS,
  PROBE_BEFORE_MS,
  PROBE_AFTER_MS,
  probeWindow,
  isProbeSafe,
  extractSignals,
  evaluateProbe,
  decideServer,
} from "./context-slots";

// Verbatim responses captured from a real MCP aggregator on 2026-09-24, probing
// the DROM meeting recorded 2026-09-18 15:00. Everything below is measured
// output, not invented fixtures — the validators exist to survive these exactly.
const REAL_CHATWORK = {
  content: [
    {
      type: "text",
      text: `イベント時系列 10件 源=chatwork(古い順)

• 三田 遼平さん 堀ノ上陽太_AVALINKさん https://us02web.zoom.us/j/88065846313?pwd=hqFlbHAMevRcFlaOeEASEaG6VVVNbG.1 こちらからお願いいたします。
  chatwork/message.mention · 2026-09-18 14:54 · 場所: ゲンダイ×DROM · 相手: 齋藤 和也
  id: chatwork:message:444468684:2152673084455661568

• https://www.facebook.com/profile.php?id=61594662142745
  chatwork/message.received · 2026-09-18 15:02 · 場所: ゲンダイ×DROM · 相手: 齋藤 和也
  id: chatwork:message:444468684:2152675234476863488`,
    },
  ],
};

// The same aggregator's calendar source. Note what is NOT here: the producer
// keeps only {start, end, allDay, summary, typeLabel} and discards the
// attendees the Calendar API returned, so there is no participant anywhere.
const REAL_CALENDAR = {
  content: [
    {
      type: "text",
      text: `イベント時系列 2件 源=rakumo(古い順)

• 絆システムブレスト
  rakumo/meeting · 2026-09-18 15:00 · 場所: カレンダー
  id: rakumo:meeting:09t7m7q0lpmc0gp4c47cvcgje0

• DROM様
  rakumo/meeting · 2026-09-18 15:00 · 場所: カレンダー
  id: rakumo:meeting:spam1d0dv0madp4ervcb20dflg`,
    },
  ],
};

describe("probeWindow", () => {
  it("reaches back before and well past the recording", () => {
    // 2026-09-18 15:00 JST
    const recordedAt = Date.parse("2026-09-18T06:00:00Z");
    const w = probeWindow(recordedAt);
    expect(w.sinceMs).toBe(recordedAt - PROBE_BEFORE_MS);
    expect(w.untilMs).toBe(recordedAt + PROBE_AFTER_MS);
    // The invitation naming all three participants (14:54) and the report that
    // the X pre-authorisation was filed (16:01) both have to land inside it.
    expect(w.sinceMs).toBeLessThan(Date.parse("2026-09-18T05:54:00Z"));
    expect(w.untilMs).toBeGreaterThan(Date.parse("2026-09-18T07:01:00Z"));
  });
});

describe("isProbeSafe", () => {
  it("only invokes tools that declare themselves read-only", () => {
    expect(
      isProbeSafe({
        name: "query_events",
        annotations: { readOnlyHint: true },
      }),
    ).toBe(true);
    // An unannotated tool is never called: "testing" send_message would send.
    expect(isProbeSafe({ name: "send_message" })).toBe(false);
    expect(isProbeSafe({ name: "send_message", annotations: {} })).toBe(false);
    expect(
      isProbeSafe({
        name: "delete_thing",
        annotations: { readOnlyHint: false },
      }),
    ).toBe(false);
  });
});

describe("extractSignals", () => {
  it("finds the dates in a real message listing", () => {
    const s = extractSignals(REAL_CHATWORK);
    expect(s.isError).toBe(false);
    expect(s.timestamps).toBe(2); // 14:54 and 15:02
    expect(s.emails).toBe(0);
    expect(s.chars).toBeGreaterThan(200);
  });
  it("reads structuredContent as well as text blocks", () => {
    const s = extractSignals({
      content: [],
      structuredContent: {
        attendees: [{ email: "A@Example.com" }, { email: "b@example.com" }],
      },
    });
    expect(s.emails).toBe(2);
  });
  it("de-duplicates repeated addresses", () => {
    const s = extractSignals({
      content: [{ type: "text", text: "a@x.com a@x.com A@X.COM" }],
    });
    expect(s.emails).toBe(1);
  });
  it("reports an errored result", () => {
    const s = extractSignals({ isError: true, content: [] });
    expect(s.isError).toBe(true);
  });
});

describe("evaluateProbe — messages (required slot)", () => {
  it("passes on the real aggregator output", () => {
    const v = evaluateProbe("messages", REAL_CHATWORK);
    expect(v.status).toBe("pass");
    expect(v.reason).toContain("2 件");
  });
  it("rejects undated prose — an answer that cannot be placed in time", () => {
    const v = evaluateProbe("messages", {
      content: [
        {
          type: "text",
          text:
            "相手: 齋藤 和也 ここ最近は広告の審査について何度かやりとりがありました。" +
            "媒体ごとの通過状況や、今後の進め方についても話題に出ています。",
        },
      ],
    });
    expect(v.status).toBe("unusable");
    expect(v.reason).toContain("日時");
  });
  it("separates a working-but-quiet window from a broken tool", () => {
    expect(evaluateProbe("messages", { isError: true }).status).toBe(
      "unusable",
    );
    expect(
      evaluateProbe("messages", {
        content: [{ type: "text", text: "0件 2026-09-18 15:00" }],
      }).status,
    ).toBe("empty");
  });
});

describe("decideServer", () => {
  it("keeps a server that fills the required slot", () => {
    const d = decideServer([evaluateProbe("messages", REAL_CHATWORK)]);
    expect(d.keep).toBe(true);
    expect(d.filled).toEqual(["messages"]);
    expect(d.message).toContain(SLOTS.messages.question);
  });

  // A calendar listing is not a set of minutes' worth of context: it has no
  // speaker and no body, so it must not qualify a server on its own.
  it("refuses a server that only returns calendar entries", () => {
    const d = decideServer([evaluateProbe("messages", REAL_CALENDAR)]);
    expect(d.keep).toBe(false);
  });

  it("explains what was needed instead of just saying no", () => {
    const d = decideServer([
      evaluateProbe("messages", {
        content: [{ type: "text", text: "ページを3件見つけました。" }],
      }),
    ]);
    expect(d.keep).toBe(false);
    expect(d.message).toContain("追加しませんでした");
    expect(d.message).toContain("発言者");
    expect(d.message).toContain("日時");
  });

  it("says so when nothing could even be probed safely", () => {
    const d = decideServer([]);
    expect(d.keep).toBe(false);
    expect(d.message).toContain("読み取り専用");
  });
});

// Third false positive of the same family, caught against a live server: a
// timestamp alone does not make a row a message. The aggregator's calendar
// source is dated and substantial and has no speaker anywhere in it.
describe("attribution is required, not just a date", () => {
  it("refuses a dated list of meeting titles", () => {
    const v = evaluateProbe("messages", REAL_CALENDAR);
    expect(v.status).toBe("unusable");
    expect(v.reason).toContain("発言者");
    expect(v.signals.authors).toBe(0);
  });
  it("counts a 相手: label as attribution", () => {
    expect(extractSignals(REAL_CHATWORK).authors).toBeGreaterThan(0);
  });
  it.each([
    'From: "林千咲" <chisaki.hayashi@example.co.jp>\n2026-09-18 14:09 本文がここに入ります。十分な長さの本文。',
    "@saito 2026-09-18 15:02 こちらの資料を共有します。よろしくお願いいたします。",
    "sender: alice\n2026-09-18 15:02 本文がここに入ります。十分な長さの本文です。",
  ])("accepts other attribution conventions", (text) => {
    expect(
      evaluateProbe("messages", { content: [{ type: "text", text }] }).status,
    ).toBe("pass");
  });
});
