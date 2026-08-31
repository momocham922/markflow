import { auth } from "./firebase";
import { aiProxyHeaders, reportIfQuota } from "./ai-proxy";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";

// The Research Director model (opus-5) generates the analyze JSON at ~60 tok/s,
// and a full brief (0-3 searches + speaker questions) runs ~2000-2800 output
// tokens, so a real analyze call takes 40-47s end-to-end (measured live against
// Vertex on 2026-08-25: 41,107ms). The previous shared 30s ceiling aborted
// EVERY analyze before it returned: fetchWithTimeout's AbortController fired at
// 30s, analyzeTranscript threw AbortError, and the pipeline never reached
// grounded-search — so cards stayed stuck as loading placeholders and the panel
// looked broken while the server (which kept running to completion) logged a
// healthy 200 with "N searches". Give analyze generous headroom; grounded-search
// (Gemini grounded web search, faster) keeps a tighter bound.
const ANALYZE_TIMEOUT_MS = 90_000;
const SEARCH_TIMEOUT_MS = 60_000;

async function getToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");
  return user.getIdToken();
}

/**
 * fetch with a hard timeout. Without this, a stalled request leaves the
 * pipeline's `pendingRef` stuck true forever, silently killing all further
 * research analysis for the rest of a long recording session. The timeout MUST
 * exceed the real upstream latency (see ANALYZE_TIMEOUT_MS above) — too short a
 * bound turns a slow-but-successful response into a fatal AbortError.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = SEARCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface AnalyzeSearch {
  query: string;
  type: "topic" | "fact-check" | "financial" | "explicit-request";
  researchAngle: string;
  desiredOutput: string;
  claim?: string;
}

/** A candidate follow-up question the user can ASK the speaker (no web search). */
export interface AnalyzeQuestionItem {
  question: string;
  intent?: string;
}

export interface AnalyzeQuestions {
  topic?: string;
  items: AnalyzeQuestionItem[];
}

/**
 * Thrown when the server blocks a research call by plan capability (not quota).
 * Currently only automatic live research on Free (MONETIZATION.md §1.3). The
 * pipeline treats this as "silently stop auto research" rather than an error.
 */
export class FeatureGatedError extends Error {
  feature: string;
  constructor(feature: string) {
    super(`feature_gated: ${feature}`);
    this.name = "FeatureGatedError";
    this.feature = feature;
  }
}

export async function analyzeTranscript(params: {
  transcriptDiff: string;
  fullContext: string;
  documentContext: string;
  searchedTopics: string[];
  /** True for automatic (interval) runs; false/omitted for a manual trigger.
   * The server gates automatic research to Pro+ (Free is manual-only). */
  auto?: boolean;
}): Promise<{
  searches: AnalyzeSearch[];
  questions?: AnalyzeQuestions | null;
}> {
  const token = await getToken();
  const res = await fetchWithTimeout(
    `${AI_PROXY_URL}/v1/research/analyze`,
    {
      method: "POST",
      headers: aiProxyHeaders(token),
      body: JSON.stringify(params),
    },
    ANALYZE_TIMEOUT_MS,
  );
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    reportIfQuota(res.status, bodyText);
    if (res.status === 403 && bodyText.includes("feature_gated")) {
      let feature = "autoResearch";
      try {
        feature = JSON.parse(bodyText).feature || feature;
      } catch {
        /* keep default */
      }
      throw new FeatureGatedError(feature);
    }
    throw new Error(`Research analyze failed: ${res.status}`);
  }
  return res.json();
}

export async function groundedSearch(
  query: string,
  type: string,
  researchAngle: string,
  desiredOutput: string,
  claim?: string,
): Promise<{
  summary: string;
  sources: Array<{
    url: string;
    title: string;
    domain: string;
    credibility: string;
  }>;
  webSearchQueries: string[];
}> {
  const token = await getToken();
  const res = await fetchWithTimeout(
    `${AI_PROXY_URL}/v1/research/grounded-search`,
    {
      method: "POST",
      headers: aiProxyHeaders(token),
      body: JSON.stringify({
        query,
        type,
        researchAngle,
        desiredOutput,
        claim,
      }),
    },
  );
  if (!res.ok) {
    reportIfQuota(res.status, await res.text().catch(() => ""));
    throw new Error(`Grounded search failed: ${res.status}`);
  }
  return res.json();
}

export function searchUserDocuments(
  documents: Array<{ id: string; title: string; content: string }>,
  query: string,
  excludeDocId?: string,
): Array<{ id: string; title: string; snippet: string; relevance: number }> {
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (queryTerms.length === 0) return [];

  const results: Array<{
    id: string;
    title: string;
    snippet: string;
    relevance: number;
  }> = [];

  for (const doc of documents) {
    if (doc.id === excludeDocId) continue;
    const text = (doc.title + " " + doc.content).toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      const count = (text.match(new RegExp(term, "gi")) || []).length;
      score += count;
      if (doc.title.toLowerCase().includes(term)) score += 5;
    }
    if (score > 0) {
      const idx = text.indexOf(queryTerms[0]);
      const start = Math.max(0, idx - 40);
      const end = Math.min(doc.content.length, idx + 120);
      const snippet = doc.content
        .substring(start, end)
        .replace(/\n/g, " ")
        .trim();
      results.push({
        id: doc.id,
        title: doc.title,
        snippet: "..." + snippet + "...",
        relevance: score,
      });
    }
  }

  return results.sort((a, b) => b.relevance - a.relevance).slice(0, 5);
}
