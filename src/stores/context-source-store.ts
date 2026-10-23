// =====================================================================
// Context sources — MCP servers Refine may consult
// ---------------------------------------------------------------------
// A source is only stored once a live probe proved it can answer the `messages`
// slot (see context-slots.ts), so everything in this store has been verified
// against a real recording rather than accepted on the strength of a
// description.
//
// WHERE THINGS ARE KEPT
//   url / name / verification result → Firestore `user_settings/{uid}`, so the
//     set of sources follows the user between devices.
//   bearer token                     → this device only, via the local settings
//     table. A user's credential for a third-party server has no business being
//     copied into our database, and the project keeps secrets out of app storage
//     as a matter of course. The consequence is deliberate and surfaced in the
//     UI: a source added on the desktop has to be given its token again on the
//     phone.
// =====================================================================

import { create } from "zustand";
import { getSetting, setSetting } from "@/services/database";
import {
  saveUserSettingsToFirestore,
  fetchUserSettings,
} from "@/services/firebase";
import { probeWindow, type SlotId } from "@/services/context-slots";
import {
  probeServer,
  rankCandidates,
  buildProbeArgs,
  buildSearchArgs,
  rankSearchCandidates,
  COLLECT_LIMIT,
  type ProbeReport,
  type JsonSchema,
} from "@/services/context-probe";
import { McpHttpClient, McpHttpError } from "@/services/mcp-http";

/** Firestore key inside user_settings. */
const FIELD = "context_sources";
/** Local settings key for one source's token. */
const tokenKey = (id: string) => `context_source_token_${id}`;

export interface ContextSource {
  id: string;
  /** The server's own `serverInfo.name`, or the URL host as a fallback. */
  name: string;
  url: string;
  /** Slots the probe proved this server can answer. */
  filled: SlotId[];
  /** When it was verified, for display. */
  verifiedAt: number;
}

export interface AddOutcome {
  ok: boolean;
  /** Shown verbatim: on success what it can do, on failure why it was refused. */
  message: string;
  report?: ProbeReport;
}

/**
 * What one source produced on a `collect` for Refine. The point is to tell the
 * two kinds of empty apart — "reachable, nothing relevant in the window" vs
 * "could not connect / token rejected" — so the result is never a silent zero
 * (プロジェクト規則: サイレントフォールバック禁止).
 */
export interface SourceOutcome {
  id: string;
  name: string;
  /**
   * ok: records returned. empty: reachable but nothing in the window.
   * auth: token missing on this device or rejected — needs re-connecting.
   * error: unreachable / moved / network.
   */
  status: "ok" | "empty" | "auth" | "error";
  records: number;
}

export interface CollectResult {
  records: Array<{ source: string; text: string }>;
  outcomes: SourceOutcome[];
}

interface ContextSourceState {
  sources: ContextSource[];
  loaded: boolean;
  /** True while a probe is running, so the dialog can disable its button. */
  testing: boolean;
  /** Per-source result of the most recent collect, for badges + the banner. */
  lastOutcomes: SourceOutcome[];
  /** Which document that collect was for, so the banner scopes itself. */
  lastOutcomesDocId: string | null;
  load: (uid: string) => Promise<void>;
  /** Probe a candidate server and keep it only if it answers a required slot. */
  add: (
    uid: string,
    url: string,
    token: string,
    recordedAtMs: number,
  ) => Promise<AddOutcome>;
  remove: (uid: string, id: string) => Promise<void>;
  /** The token for a source, from this device. */
  tokenFor: (id: string) => Promise<string | null>;
  /**
   * Ask every configured source what was said around a recording. Used by
   * Refine; never throws, because a source being unreachable must not stop a
   * refinement that would otherwise succeed. Returns the gathered records AND a
   * per-source outcome so the caller can tell "nothing relevant" from "could
   * not connect" and surface the latter instead of swallowing it.
   */
  collect: (
    recordedAtMs: number,
    topicTerms?: string[],
  ) => Promise<CollectResult>;
  /** Record a collect's outcomes against a document (drives the banner/badges). */
  noteCollect: (docId: string, outcomes: SourceOutcome[]) => void;
  /** Dismiss the banner (clears the doc scope but keeps outcomes for badges). */
  dismissOutcomes: () => void;
  reset: () => void;
}

/** The text blocks of an MCP tool result, joined. */
function textOf(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const block = b as { type?: unknown; text?: unknown };
      return block?.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Stable id from the URL so re-adding the same server replaces it. */
function idFor(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 120);
}

function parseStored(value: unknown): ContextSource[] {
  if (!Array.isArray(value)) return [];
  const out: ContextSource[] = [];
  for (const raw of value) {
    const s = raw as Partial<ContextSource>;
    if (typeof s?.id !== "string" || typeof s?.url !== "string") continue;
    out.push({
      id: s.id,
      url: s.url,
      name: typeof s.name === "string" ? s.name : hostOf(s.url),
      filled: Array.isArray(s.filled) ? (s.filled as SlotId[]) : [],
      verifiedAt: typeof s.verifiedAt === "number" ? s.verifiedAt : 0,
    });
  }
  return out;
}

export const useContextSourceStore = create<ContextSourceState>((set, get) => ({
  sources: [],
  loaded: false,
  testing: false,
  lastOutcomes: [],
  lastOutcomesDocId: null,

  load: async (uid) => {
    try {
      const settings = await fetchUserSettings(uid);
      set({ sources: parseStored(settings?.[FIELD]), loaded: true });
    } catch (e) {
      console.error("[context-source] load failed:", e);
      set({ loaded: true });
    }
  },

  add: async (uid, url, token, recordedAtMs) => {
    const trimmed = url.trim();
    if (!trimmed) return { ok: false, message: "URL を入力してください。" };
    set({ testing: true });
    try {
      const client = new McpHttpClient({ url: trimmed, bearer: token.trim() });
      let name = hostOf(trimmed);
      try {
        const info = await client.initialize();
        if (info.name) name = info.name;
      } catch (e) {
        // A server that cannot even shake hands is reported as-is: the message
        // already distinguishes a rejected token from a wrong path.
        return {
          ok: false,
          message:
            e instanceof McpHttpError
              ? `接続できませんでした: ${e.message}`
              : `接続できませんでした: ${String(e)}`,
        };
      }

      const tools = await client.listTools();
      const report = await probeServer(
        tools,
        probeWindow(recordedAtMs),
        (toolName, args) => client.callTool(toolName, args),
      );
      if (!report.decision.keep)
        return { ok: false, message: report.decision.message, report };

      const source: ContextSource = {
        id: idFor(trimmed),
        name,
        url: trimmed,
        filled: report.decision.filled,
        verifiedAt: Date.now(),
      };
      // Token first: a source listed without its token would fail on next use.
      await setSetting(tokenKey(source.id), token.trim());
      const sources = [
        ...get().sources.filter((s) => s.id !== source.id),
        source,
      ];
      set({ sources });
      await saveUserSettingsToFirestore(uid, { [FIELD]: sources });
      return { ok: true, message: report.decision.message, report };
    } catch (e) {
      return {
        ok: false,
        message:
          e instanceof McpHttpError
            ? `接続できませんでした: ${e.message}`
            : `検証に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      };
    } finally {
      set({ testing: false });
    }
  },

  remove: async (uid, id) => {
    const sources = get().sources.filter((s) => s.id !== id);
    set({ sources });
    await setSetting(tokenKey(id), "");
    await saveUserSettingsToFirestore(uid, { [FIELD]: sources });
  },

  tokenFor: async (id) => {
    const v = await getSetting(tokenKey(id));
    return v && v.trim() ? v : null;
  },

  collect: async (recordedAtMs, topicTerms = []) => {
    const window = probeWindow(recordedAtMs);
    const records: Array<{ source: string; text: string }> = [];
    const outcomes: SourceOutcome[] = [];
    for (const source of get().sources) {
      let got = 0;
      try {
        const token = await get().tokenFor(source.id);
        if (!token) {
          // Sources follow the user between devices; their tokens do not. A
          // missing token here is "re-connect on this device", not a silent 0.
          outcomes.push({
            id: source.id,
            name: source.name,
            status: "auth",
            records: 0,
          });
          continue;
        }
        const client = new McpHttpClient({ url: source.url, bearer: token });
        await client.initialize();
        const tools = await client.listTools();
        // Same ranking the probe used, so Refine calls the tool that was
        // actually verified rather than re-deciding on different grounds.
        for (const tool of rankCandidates(tools, "messages")) {
          const { args, unfilledRequired } = buildProbeArgs(
            tool.inputSchema as JsonSchema | undefined,
            window,
            COLLECT_LIMIT,
          );
          if (unfilledRequired.length > 0) continue;
          const result = await client.callTool(tool.name, args);
          const text = textOf(result);
          if (text.trim()) {
            records.push({ source: source.name, text });
            got++;
          }
          break;
        }

        // Second pass: look past the window by topic. The window says what
        // happened around the meeting; this is where "what we agreed last time"
        // lives, which no amount of widening the window would reach.
        const searchTools = rankSearchCandidates(tools, "messages");
        if (searchTools.length > 0 && topicTerms.length > 0) {
          const tool = searchTools[0];
          for (const term of topicTerms) {
            const { args, unfilledRequired } = buildSearchArgs(
              tool.inputSchema as JsonSchema | undefined,
              term,
              window,
            );
            if (unfilledRequired.length > 0) continue;
            const result = await client.callTool(tool.name, args);
            const text = textOf(result);
            if (text.trim()) {
              records.push({
                source: `${source.name}（「${term}」で検索）`,
                text,
              });
              got++;
            }
          }
        }
        outcomes.push({
          id: source.id,
          name: source.name,
          status: got > 0 ? "ok" : "empty",
          records: got,
        });
      } catch (e) {
        // A token that expired, a server that moved, no network — none of these
        // fail the refinement, but they are reported (not swallowed) so the user
        // learns the context was missing and can re-connect.
        const auth = e instanceof McpHttpError && e.code === "auth";
        console.error(`[context-source] ${source.name} unavailable:`, e);
        outcomes.push({
          id: source.id,
          name: source.name,
          status: auth ? "auth" : "error",
          records: got,
        });
      }
    }
    return { records, outcomes };
  },

  noteCollect: (docId, outcomes) =>
    set({ lastOutcomes: outcomes, lastOutcomesDocId: docId }),

  dismissOutcomes: () => set({ lastOutcomesDocId: null }),

  reset: () =>
    set({
      sources: [],
      loaded: false,
      testing: false,
      lastOutcomes: [],
      lastOutcomesDocId: null,
    }),
}));
