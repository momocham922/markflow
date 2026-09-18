import { describe, it, expect } from "vitest";
import { tokyoDateParts, tokyoDateJa, currentDateBlock } from "./datetime";

describe("tokyoDateParts / tokyoDateJa", () => {
  it("renders the Asia/Tokyo calendar date and weekday", () => {
    // 2026-09-18 03:00 UTC = 2026-09-18 12:00 JST (Friday)
    expect(tokyoDateParts(new Date("2026-09-18T03:00:00Z"))).toEqual({
      year: 2026,
      month: 9,
      day: 18,
      weekday: "金",
    });
    expect(tokyoDateJa(new Date("2026-09-18T03:00:00Z"))).toBe(
      "2026年9月18日（金）",
    );
  });
  it("uses the Tokyo day, not UTC, across the date boundary", () => {
    // 2026-09-17 20:00 UTC = 2026-09-18 05:00 JST
    expect(tokyoDateJa(new Date("2026-09-17T20:00:00Z"))).toBe(
      "2026年9月18日（金）",
    );
    // 2026-09-18 16:00 UTC = 2026-09-19 01:00 JST (Saturday)
    expect(tokyoDateJa(new Date("2026-09-18T16:00:00Z"))).toBe(
      "2026年9月19日（土）",
    );
  });
  it("gets weekdays right across a year boundary", () => {
    expect(tokyoDateJa(new Date("2026-12-31T15:30:00Z"))).toBe(
      "2027年1月1日（金）",
    );
    // the same calendar date in a different year has a different weekday
    expect(tokyoDateJa(new Date("2025-10-09T03:00:00Z"))).toBe(
      "2025年10月9日（木）",
    );
    expect(tokyoDateJa(new Date("2026-10-09T03:00:00Z"))).toBe(
      "2026年10月9日（金）",
    );
  });
});

describe("currentDateBlock", () => {
  it("pins today and forbids the training-time year", () => {
    const block = currentDateBlock(new Date("2026-09-18T03:00:00Z"));
    expect(block).toContain("本日は 2026年9月18日（金）（日本時間）です。");
    expect(block).toContain("学習時点の年を使ってはならない");
    expect(block).toContain("今年 = 2026年");
    expect(block).toContain("推測で曜日を書かない");
  });
});
