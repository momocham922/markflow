export function extractHints(text: string): string[] {
  const hints = new Set<string>();
  const kanji = text.match(/[一-鿿]{3,}/g);
  if (kanji) kanji.forEach((w) => hints.add(w));
  const katakana = text.match(/[゠-ヿ]{4,}/g);
  if (katakana) katakana.forEach((w) => hints.add(w));
  const english = text.match(/[A-Z][a-zA-Z]{3,}/g);
  if (english) english.forEach((w) => hints.add(w));
  return Array.from(hints)
    .sort((a, b) => b.length - a.length)
    .slice(0, 50);
}

/** Titles the user never set — searching for these drags back everything. */
const PLACEHOLDER_TITLES = new Set([
  "untitled",
  "無題",
  "名称未設定",
  "new document",
  "新規ドキュメント",
]);

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(title.trim().toLowerCase());
}

/**
 * Clean the candidate search terms the context probe derives from a document.
 * extractHints() tokenises by script run, which on real titles leaves junk that
 * a keyword search should never be handed: a placeholder title ("Untitled"), an
 * honorific fragment split off a company name ("様提案" out of "…様提案…"), or a
 * katakana run that swallowed a leading middle-dot ("・プログラマティック"). A bad
 * term pulls back unrelated records, so it is better dropped than searched.
 * Kept pure and separate from extractHints, which also feeds the STT vocabulary
 * hints and must not change.
 */
export function cleanTopicTerms(terms: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const t = raw
      .replace(/^[・･ー〜～\-－「」『』（）()、。，,.\s]+/, "")
      .replace(/[・･ー〜～\-－「」『』（）()、。，,.\s]+$/, "")
      .trim();
    if (t.length < 2) continue;
    if (isPlaceholderTitle(t)) continue;
    // Honorific prefixes are split artefacts ("様提案"), never a topic.
    if (/^(様|御中|御)/.test(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
