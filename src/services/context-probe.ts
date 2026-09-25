// =====================================================================
// Probing an MCP server for the context slots
// ---------------------------------------------------------------------
// The rule from context-slots.ts is "verify, don't trust the description", so
// candidate selection here is deliberately cheap and generous: rank the
// read-only tools by how much their names and descriptions look like an answer to a slot, then
// CALL them and let evaluateProbe judge the result. A weak ranking costs one
// extra call; a wrong guess is caught by the evidence check, not by the score.
//
// No model is involved. Ranking is a pure function, argument construction is a
// pure function, and the only IO is a `callTool` the caller injects — so the
// whole decision path is testable against real server schemas.
// =====================================================================

import {
  SLOTS,
  type SlotId,
  type McpToolInfo,
  type ProbeVerdict,
  type ProbeWindow,
  type ServerDecision,
  isProbeSafe,
  evaluateProbe,
  decideServer,
} from "./context-slots";

// ---------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------

/** Words that suggest a tool answers a given slot, in both languages. */
const SLOT_KEYWORDS: Record<SlotId, string[]> = {
  messages: [
    "message",
    "chat",
    "mail",
    "thread",
    "conversation",
    "history",
    "event",
    "activity",
    "timeline",
    "メッセージ",
    "チャット",
    "メール",
    "やりとり",
    "履歴",
    "発言",
    "イベント",
    "時系列",
  ],
};

/**
 * Tools that clearly write something never score, whatever they are called.
 *
 * Matched against name TOKENS, not with `\b`: an underscore is a word character
 * in JavaScript, so `/\bsend\b/` does not match `send_message` — and snake_case
 * is the prevailing convention for MCP tool names, which would have let every
 * write tool through unpenalised.
 */
const WRITE_WORDS = new Set([
  "send",
  "create",
  "update",
  "delete",
  "remove",
  "post",
  "write",
  "add",
  "set",
  "move",
  "archive",
]);

const nameTokens = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // sendMessage → send Message
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * A cheap relevance score. Only used to decide what to TRY FIRST — the verdict
 * comes from the actual response, so a mediocre score is not a rejection.
 */
export function scoreToolForSlot(tool: McpToolInfo, slot: SlotId): number {
  // Disqualifying, not a deduction. A deduction loses to a pile-up of keyword
  // matches — `postMessage` described as "message chat" still came out positive
  // with a -5 penalty — and "probably safe enough" is not a basis for calling a
  // stranger's tool.
  if (nameTokens(tool.name).some((t) => WRITE_WORDS.has(t))) return -1;
  const hay = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  let score = 0;
  for (const kw of SLOT_KEYWORDS[slot]) {
    if (hay.includes(kw.toLowerCase())) score += 1;
  }
  // A tool whose NAME mentions the subject is a better bet than one that only
  // mentions it in prose.
  const nameHay = tool.name.toLowerCase();
  for (const kw of SLOT_KEYWORDS[slot]) {
    if (nameHay.includes(kw.toLowerCase())) score += 2;
  }
  return score;
}

/** Read-only tools worth trying for a slot, best first. */
export function rankCandidates(
  tools: McpToolInfo[],
  slot: SlotId,
): McpToolInfo[] {
  return tools
    .filter(isProbeSafe)
    .map((t) => ({ t, s: scoreToolForSlot(t, slot) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
    .map((x) => x.t);
}

// ---------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema & { description?: string }>;
  required?: string[];
  format?: string;
  default?: unknown;
}

// An explicit allowlist of parameter names, not prefix matching: `fromUser` and
// `toChannel` are not time bounds, and guessing wrong means probing with a
// nonsense window and blaming the server for the empty answer.
const norm = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

const SINCE_NAMES = new Set([
  "since",
  "sincems",
  "sinceat",
  "sincetime",
  "start",
  "startms",
  "startat",
  "starttime",
  "startdate",
  "from",
  "fromms",
  "fromdate",
  "fromtime",
  "after",
  "afterms",
  "begin",
  "beginat",
  "timemin",
  "mintime",
  "mindate",
]);
const UNTIL_NAMES = new Set([
  "until",
  "untilms",
  "untilat",
  "untiltime",
  "end",
  "endms",
  "endat",
  "endtime",
  "enddate",
  "to",
  "toms",
  "todate",
  "totime",
  "before",
  "beforems",
  "timemax",
  "maxtime",
  "maxdate",
]);
const LIMIT_NAMES = new Set([
  "limit",
  "maxresult",
  "maxresults",
  "count",
  "pagesize",
  "top",
  "perpage",
]);

function timeValue(prop: JsonSchema, ms: number): number | string {
  const t = prop.type;
  if (t === "number" || t === "integer") return ms;
  // Strings default to ISO-8601, which is what calendar APIs take.
  return new Date(ms).toISOString();
}

export interface ProbeArgs {
  args: Record<string, unknown>;
  /** Parameters the tool requires that could not be filled sensibly. */
  unfilledRequired: string[];
}

/**
 * Build arguments for a probe call from the tool's own schema.
 *
 * Only parameters we can fill HONESTLY are set: the time bounds, and a small
 * limit so a probe never drags back a huge page. A tool that requires anything
 * else — a free-text query, a channel id — is reported as unfillable rather
 * than called with a made-up value, because a probe answered from an invented
 * argument proves nothing about the real question.
 */
export function buildProbeArgs(
  schema: JsonSchema | undefined,
  window: ProbeWindow,
  probeLimit = 20,
): ProbeArgs {
  const args: Record<string, unknown> = {};
  const props = schema?.properties ?? {};
  for (const [name, prop] of Object.entries(props)) {
    const key = norm(name);
    if (SINCE_NAMES.has(key)) args[name] = timeValue(prop, window.sinceMs);
    else if (UNTIL_NAMES.has(key)) args[name] = timeValue(prop, window.untilMs);
    else if (
      LIMIT_NAMES.has(key) &&
      (prop.type === "number" || prop.type === "integer")
    )
      args[name] = probeLimit;
  }
  const unfilledRequired = (schema?.required ?? []).filter((r) => !(r in args));
  return { args, unfilledRequired };
}

// ---------------------------------------------------------------------
// Running the probe
// ---------------------------------------------------------------------

export interface ProbeAttempt {
  slot: SlotId;
  tool: string;
  /** Present when the tool was never called, with the reason why. */
  skipped?: string;
  args?: Record<string, unknown>;
  verdict?: ProbeVerdict;
  error?: string;
}

export interface ProbeReport {
  attempts: ProbeAttempt[];
  verdicts: ProbeVerdict[];
  decision: ServerDecision;
}

export type CallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** How many tools to try per slot before giving up. */
export const MAX_ATTEMPTS_PER_SLOT = 3;

/**
 * Probe one server for every slot and decide whether to keep it.
 *
 * Every attempt is recorded — tool, arguments, and what came back — because the
 * rejection message is the product: someone running their own server has to be
 * able to see exactly which call was made and what was missing from the answer.
 */
export async function probeServer(
  tools: McpToolInfo[],
  window: ProbeWindow,
  callTool: CallTool,
  maxPerSlot = MAX_ATTEMPTS_PER_SLOT,
): Promise<ProbeReport> {
  const attempts: ProbeAttempt[] = [];
  const verdicts: ProbeVerdict[] = [];

  for (const slot of Object.keys(SLOTS) as SlotId[]) {
    let tried = 0;
    let best: ProbeVerdict | null = null;
    for (const tool of rankCandidates(tools, slot)) {
      if (tried >= maxPerSlot) break;
      const { args, unfilledRequired } = buildProbeArgs(
        tool.inputSchema as JsonSchema | undefined,
        window,
      );
      if (unfilledRequired.length > 0) {
        attempts.push({
          slot,
          tool: tool.name,
          skipped: `必須パラメータ ${unfilledRequired.join("・")} を推測なしで埋められないため呼び出しませんでした。`,
        });
        continue;
      }
      tried += 1;
      try {
        const result = await callTool(tool.name, args);
        const verdict = evaluateProbe(slot, result);
        attempts.push({ slot, tool: tool.name, args, verdict });
        // Keep the strongest outcome seen for this slot.
        if (verdict.status === "pass") {
          best = verdict;
          break;
        }
        if (!best || best.status === "unusable") best = verdict;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        attempts.push({ slot, tool: tool.name, args, error });
      }
    }
    if (best) verdicts.push(best);
  }

  return { attempts, verdicts, decision: decideServer(verdicts) };
}
