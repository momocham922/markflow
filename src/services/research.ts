import { auth } from "./firebase";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";

async function getToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");
  return user.getIdToken();
}

export interface AnalyzeSearch {
  query: string;
  type: "topic" | "fact-check" | "financial" | "explicit-request";
  researchAngle: string;
  desiredOutput: string;
  claim?: string;
}

export async function analyzeTranscript(params: {
  transcriptDiff: string;
  fullContext: string;
  documentContext: string;
  searchedTopics: string[];
}): Promise<{ searches: AnalyzeSearch[] }> {
  const token = await getToken();
  const res = await fetch(`${AI_PROXY_URL}/v1/research/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Research analyze failed: ${res.status}`);
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
  const res = await fetch(`${AI_PROXY_URL}/v1/research/grounded-search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, type, researchAngle, desiredOutput, claim }),
  });
  if (!res.ok) throw new Error(`Grounded search failed: ${res.status}`);
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
