/** Detect if content is HTML (from old Tiptap editor) */
export function isHtmlContent(content: string): boolean {
  return /^\s*<[a-z][\s\S]*>/i.test(content);
}

/** Extract YouTube video ID from various URL formats */
export function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// CJK ranges (hiragana, katakana, halfwidth katakana, CJK ideographs +
// extension A + compatibility, hangul). These scripts don't separate words
// with spaces, so each character is counted as one word.
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ]/g;

/**
 * Count words in a way that's meaningful for both space-delimited scripts
 * (Latin, etc.) and CJK. Latin words are counted by whitespace splitting;
 * each CJK character counts as one word. `"日本語 test"` → 3 + 1 = 4.
 */
export function countWords(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  const cjk = t.match(CJK_RE)?.length ?? 0;
  const rest = t.replace(CJK_RE, " ").trim();
  const latin = rest ? rest.split(/\s+/).length : 0;
  return cjk + latin;
}

/** Escape HTML special characters to prevent XSS */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
