import { describe, it, expect } from "vitest";
import { cleanTopicTerms, isPlaceholderTitle } from "./text-utils";

describe("isPlaceholderTitle", () => {
  it("matches the titles the user never set, case/space-insensitively", () => {
    expect(isPlaceholderTitle("Untitled")).toBe(true);
    expect(isPlaceholderTitle("  無題 ")).toBe(true);
    expect(isPlaceholderTitle("名称未設定")).toBe(true);
    expect(isPlaceholderTitle("イオンバイク様 初回打ち合わせ")).toBe(false);
  });
});

describe("cleanTopicTerms", () => {
  it("drops a honorific fragment split off a company name", () => {
    expect(cleanTopicTerms(["様提案"])).toEqual([]);
    expect(cleanTopicTerms(["御中"])).toEqual([]);
  });

  it("strips a leading middle-dot a katakana run swallowed", () => {
    expect(cleanTopicTerms(["・プログラマティック"])).toEqual([
      "プログラマティック",
    ]);
  });

  it("drops placeholder titles and too-short remnants", () => {
    expect(cleanTopicTerms(["Untitled", "ー", "・"])).toEqual([]);
  });

  it("keeps real terms and dedupes case-insensitively, preserving order", () => {
    expect(
      cleanTopicTerms(["イオンバイク", "LIPS", "lips", "世田谷自然食品"]),
    ).toEqual(["イオンバイク", "LIPS", "世田谷自然食品"]);
  });

  it("leaves a clean list untouched", () => {
    expect(cleanTopicTerms(["サーバーサイドGTM", "GA4"])).toEqual([
      "サーバーサイドGTM",
      "GA4",
    ]);
  });
});
