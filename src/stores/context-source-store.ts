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
import { probeServer, type ProbeReport } from "@/services/context-probe";
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

interface ContextSourceState {
  sources: ContextSource[];
  loaded: boolean;
  /** True while a probe is running, so the dialog can disable its button. */
  testing: boolean;
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
  reset: () => void;
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

  reset: () => set({ sources: [], loaded: false, testing: false }),
}));
