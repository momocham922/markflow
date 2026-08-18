import { auth } from "./firebase";
import { aiProxyHeaders, reportIfQuota } from "./ai-proxy";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";
const REQUEST_TIMEOUT_MS = 30_000;

async function getToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");
  return user.getIdToken();
}

/**
 * fetch with a hard timeout. Without this, a stalled request leaves the
 * pipeline's `pendingRef` stuck true forever, silently killing all further
 * research analysis for the rest of a long recording session.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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

export async function analyzeTranscript(params: {
  transcriptDiff: string;
  fullContext: string;
  documentContext: string;
  searchedTopics: string[];
}): Promise<{
  searches: AnalyzeSearch[];
  questions?: AnalyzeQuestions | null;
}> {
  const token = await getToken();
  const res = await fetchWithTimeout(`${AI_PROXY_URL}/v1/research/analyze`, {
    method: "POST",
    headers: aiProxyHeaders(token),
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    reportIfQuota(res.status, await res.text().catch(() => ""));
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
