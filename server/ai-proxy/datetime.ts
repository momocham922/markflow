// =====================================================================
// Current-date grounding for prompts
// ---------------------------------------------------------------------
// A model has no clock: left to itself it answers "this year" with the year it
// was trained in. The research prompts ask for search queries that include a
// year ("年号含む"), so without a date the queries came out stamped with a stale
// year — and a calendar fact-check computed weekdays from the wrong year and
// declared a correct statement wrong (observed 2026-09-18: a card computed
// "10/9 は木曜" from the 2025 calendar; in 2026 it is Friday).
//
// Every prompt that can reason about "now" gets this line. Asia/Tokyo is the
// project timezone.
// =====================================================================

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** Parts of `now` in Asia/Tokyo (calendar date + weekday). */
export function tokyoDateParts(now: Date): {
  year: number;
  month: number;
  day: number;
  weekday: string;
} {
  // sv-SE renders as "YYYY-MM-DD HH:mm:ss", so the date part is ISO-like.
  const iso = now
    .toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" })
    .slice(0, 10);
  const [year, month, day] = iso.split("-").map(Number);
  // Weekday of that calendar date (UTC noon avoids any DST/rounding edge).
  const weekday = WEEKDAY_JA[new Date(`${iso}T12:00:00Z`).getUTCDay()] ?? "日";
  return { year, month, day, weekday };
}

/** "2026年9月18日（金）" in Asia/Tokyo. */
export function tokyoDateJa(now: Date): string {
  const { year, month, day, weekday } = tokyoDateParts(now);
  return `${year}年${month}月${day}日（${weekday}）`;
}

/**
 * The block prepended to prompts that may reason about dates: it pins "today",
 * forbids using the training-time year, and requires date/weekday arithmetic to
 * be done from this date.
 */
export function currentDateBlock(now: Date = new Date()): string {
  return `## 現在の日時（必ずこれを基準にする）
本日は ${tokyoDateJa(now)}（日本時間）です。
- 「最新」「今年」「来年」「直近」は、すべてこの日付を基準に解釈する。学習時点の年を使ってはならない。
- 検索クエリに年号を入れる場合も、この日付を基準にした年を使う（例: 今年 = ${tokyoDateParts(now).year}年）。
- 日付・曜日・営業日数の計算は、この日付が属する年のカレンダーで行う。推測で曜日を書かない。`;
}
