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
