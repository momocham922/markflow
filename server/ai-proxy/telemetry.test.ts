import { describe, it, expect } from "vitest";
import {
  sanitizeEventName,
  sanitizePropValue,
  sanitizeProps,
  clampClientTs,
  deriveEventId,
  cleanEvent,
  cleanBatch,
  buildInsertRows,
  tsToIso,
  consentRegionFor,
  consentModeFor,
  defaultConsent,
  MAX_EVENTS_PER_BATCH,
  MAX_PROPS_PER_EVENT,
  MAX_STRING_VALUE_LEN,
  type TelemetryServerMeta,
} from "./telemetry";

describe("sanitizeEventName", () => {
  it("snake_cases and lowercases", () => {
    expect(sanitizeEventName("Doc Create")).toBe("doc_create");
    expect(sanitizeEventName("AI.Request")).toBe("ai.request");
  });
  it("collapses and trims separators", () => {
    expect(sanitizeEventName("  __voice__start__  ")).toBe("voice_start");
  });
  it("rejects too-short / empty names", () => {
    expect(sanitizeEventName("")).toBeNull();
    expect(sanitizeEventName("!")).toBeNull();
    expect(sanitizeEventName(null)).toBeNull();
  });
  it("bounds length", () => {
    expect(
      (sanitizeEventName("a".repeat(100)) || "").length,
    ).toBeLessThanOrEqual(48);
  });
});

describe("sanitizePropValue", () => {
  it("keeps scalars", () => {
    expect(sanitizePropValue(true)).toBe(true);
    expect(sanitizePropValue(42)).toBe(42);
    expect(sanitizePropValue("hello")).toBe("hello");
  });
  it("drops non-finite numbers and non-scalars", () => {
    expect(sanitizePropValue(NaN)).toBeNull();
    expect(sanitizePropValue(Infinity)).toBeNull();
    expect(sanitizePropValue({ a: 1 })).toBeNull();
    expect(sanitizePropValue([1, 2])).toBeNull();
    expect(sanitizePropValue(null)).toBeNull();
    expect(sanitizePropValue(undefined)).toBeNull();
  });
  it("redacts PII inside string values", () => {
    expect(sanitizePropValue("mail a@b.com")).toBe("mail [email]");
  });
  it("clamps long strings", () => {
    expect((sanitizePropValue("x".repeat(2000)) as string).length).toBe(
      MAX_STRING_VALUE_LEN,
    );
  });
});

describe("sanitizeProps", () => {
  it("snake_cases keys and keeps scalar values", () => {
    expect(sanitizeProps({ "Doc Count": 3, OK: true })).toEqual({
      doc_count: 3,
      ok: true,
    });
  });
  it("drops non-object input", () => {
    expect(sanitizeProps(null)).toEqual({});
    expect(sanitizeProps([1, 2])).toEqual({});
    expect(sanitizeProps("x")).toEqual({});
  });
  it("caps the number of props", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 100; i++) big[`k${i}`] = i;
    expect(Object.keys(sanitizeProps(big)).length).toBe(MAX_PROPS_PER_EVENT);
  });
  it("drops nested/invalid values but keeps valid ones", () => {
    expect(sanitizeProps({ a: 1, b: { x: 1 }, c: "ok" })).toEqual({
      a: 1,
      c: "ok",
    });
  });
});

describe("clampClientTs", () => {
  const now = 1_700_000_000_000;
  it("keeps a recent timestamp", () => {
    expect(clampClientTs(now - 1000, now)).toBe(now - 1000);
  });
  it("clamps a far-future timestamp to now", () => {
    expect(clampClientTs(now + 60 * 60 * 1000, now)).toBe(now);
  });
  it("rejects an absurdly old timestamp", () => {
    expect(clampClientTs(now - 60 * 24 * 60 * 60 * 1000, now)).toBeNull();
  });
  it("rejects garbage", () => {
    expect(clampClientTs("nope", now)).toBeNull();
    expect(clampClientTs(undefined, now)).toBeNull();
  });
});

describe("deriveEventId", () => {
  it("uses a valid client id verbatim (idempotent retries)", () => {
    expect(deriveEventId("abc123-def456", "u1", "doc_create", 1)).toBe(
      "abc123-def456",
    );
  });
  it("hashes when id is missing/invalid, stable per content", () => {
    const a = deriveEventId("", "u1", "doc_create", 1);
    const b = deriveEventId("bad id!", "u1", "doc_create", 1);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveEventId("", "u1", "doc_create", 1)).toBe(a);
  });
});

describe("cleanEvent / cleanBatch", () => {
  const now = 1_700_000_000_000;
  it("normalizes a full event", () => {
    const c = cleanEvent(
      {
        id: "evt_000001",
        event: "Doc Create",
        ts: now - 500,
        sessionId: "sess-1",
        props: { Words: 10, mail: "a@b.com" },
      },
      "u1",
      now,
    );
    expect(c).toEqual({
      eventId: "evt_000001",
      event: "doc_create",
      clientTs: now - 500,
      sessionId: "sess-1",
      props: { words: 10, mail: "[email]" },
    });
  });
  it("drops events with an unusable name", () => {
    expect(cleanEvent({ event: "" }, "u1", now)).toBeNull();
  });
  it("clean batch drops junk and caps count", () => {
    const raw = [
      { event: "ok_one" },
      { event: "" }, // dropped
      { event: "ok_two" },
    ];
    expect(cleanBatch(raw, "u1", now).map((e) => e.event)).toEqual([
      "ok_one",
      "ok_two",
    ]);
  });
  it("caps a huge batch", () => {
    const raw = Array.from({ length: 200 }, (_, i) => ({ event: `e_${i}` }));
    expect(cleanBatch(raw, "u1", now).length).toBe(MAX_EVENTS_PER_BATCH);
  });
  it("returns [] for non-array input", () => {
    expect(cleanBatch({}, "u1", now)).toEqual([]);
    expect(cleanBatch(null, "u1", now)).toEqual([]);
  });
});

describe("tsToIso", () => {
  it("formats epoch ms as ISO", () => {
    expect(tsToIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });
  it("passes through null", () => {
    expect(tsToIso(null)).toBeNull();
  });
});

describe("buildInsertRows", () => {
  const meta: TelemetryServerMeta = {
    uid: "u1",
    plan: "pro",
    appVersion: "0.6.0",
    platform: "macos",
    osVersion: "mac",
    locale: "ja",
    serverTsIso: "2026-08-25T00:00:00.000Z",
  };
  it("maps a cleaned event to a BigQuery row with insertId + JSON props", () => {
    const events = cleanBatch(
      [{ id: "evt_0001", event: "doc_create", ts: 0, props: { n: 2 } }],
      "u1",
      1_700_000_000_000,
    );
    const rows = buildInsertRows(events, meta);
    expect(rows).toHaveLength(1);
    expect(rows[0].insertId).toBe("evt_0001");
    expect(rows[0].json.uid).toBe("u1");
    expect(rows[0].json.plan).toBe("pro");
    expect(rows[0].json.event).toBe("doc_create");
    expect(rows[0].json.server_ts).toBe("2026-08-25T00:00:00.000Z");
    expect(rows[0].json.props).toBe(JSON.stringify({ n: 2 }));
  });
});

describe("consent region logic", () => {
  it("classifies EU/EEA/UK/CH as eu", () => {
    for (const cc of ["DE", "FR", "de", "gb", "CH", "NO"]) {
      expect(consentRegionFor(cc)).toBe("eu");
    }
  });
  it("classifies JP as jp and US/other as other", () => {
    expect(consentRegionFor("JP")).toBe("jp");
    expect(consentRegionFor("US")).toBe("other");
    expect(consentRegionFor("")).toBe("other");
    expect(consentRegionFor(null)).toBe("other");
  });
  it("maps region → mode", () => {
    expect(consentModeFor("eu")).toBe("opt_in");
    expect(consentModeFor("jp")).toBe("opt_out");
    expect(consentModeFor("other")).toBe("notice");
  });
  it("defaults consent OFF only in the EU", () => {
    expect(defaultConsent("eu")).toBe(false);
    expect(defaultConsent("jp")).toBe(true);
    expect(defaultConsent("other")).toBe(true);
  });
});
