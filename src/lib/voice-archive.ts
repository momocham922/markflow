// Orphaned-recording rescue (frontend side).
//
// The full-session recording is kept in a native temp file whose path lives
// only in memory. If the app process dies, that path is lost and "Refine"
// silently disappears even though the audio is still on disk (2026-11-09: an
// iPhone recording made while signed out was stranded this way). The native
// side now re-adopts the newest orphaned file; these helpers expose it to the
// UI on every platform.
import { isAndroid, isTauri } from "@/platform";

export interface OrphanVoiceArchive {
  /** Stable key for "dismissed" bookkeeping (native file name). */
  key: string;
  bytes: number;
  /** Last write time ≈ end of the recording (ms since epoch). */
  modifiedMs: number;
  durationSec: number;
}

interface AndroidArchiveBridge {
  hasArchive?: () => boolean;
  getOrphanArchiveInfo?: () => string | null;
}

function androidBridge(): AndroidArchiveBridge | undefined {
  return (window as unknown as Record<string, unknown>).AndroidAudio as
    AndroidArchiveBridge | undefined;
}

/** True when a recording archive (this session's or an adopted orphan) exists. */
export async function checkVoiceArchive(): Promise<boolean> {
  if (!isTauri) return false;
  if (isAndroid) {
    const bridge = androidBridge();
    if (bridge?.hasArchive) {
      try {
        return !!bridge.hasArchive();
      } catch {
        return false;
      }
    }
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("check_voice_archive");
}

/** The orphaned recording from an earlier app run, if any (null otherwise). */
export async function getOrphanVoiceArchive(): Promise<OrphanVoiceArchive | null> {
  if (!isTauri) return null;
  if (isAndroid) {
    const raw = androidBridge()?.getOrphanArchiveInfo?.();
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as {
        key: string;
        bytes: number;
        modifiedMs: number;
      };
      if (!o.key || !(o.bytes > 0)) return null;
      return {
        key: o.key,
        bytes: o.bytes,
        modifiedMs: o.modifiedMs,
        durationSec: o.bytes / 32000,
      };
    } catch {
      return null;
    }
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const info = await invoke<{
    key: string;
    bytes: number;
    modified_ms: number;
    duration_sec: number;
  } | null>("voice_archive_info");
  if (!info || !info.key) return null;
  return {
    key: info.key,
    bytes: info.bytes,
    modifiedMs: info.modified_ms,
    durationSec: info.duration_sec,
  };
}

/** "11月9日 21:34ごろからの録音（約16分）" — start ≈ last write − duration. */
export function describeOrphan(o: OrphanVoiceArchive): string {
  const startMs = o.modifiedMs - Math.round(o.durationSec * 1000);
  const d = new Date(startMs > 0 ? startMs : o.modifiedMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const minutes = Math.max(1, Math.round(o.durationSec / 60));
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}ごろからの録音（約${minutes}分）`;
}

const DISMISSED_KEY = "markflow.orphanVoiceDismissed";

export function isOrphanDismissed(key: string): boolean {
  try {
    const list = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
    return Array.isArray(list) && list.includes(key);
  } catch {
    return false;
  }
}

export function dismissOrphan(key: string): void {
  try {
    const list = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
    const next = Array.isArray(list) ? list.filter((k) => k !== key) : [];
    next.push(key);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next.slice(-50)));
  } catch {
    // storage unavailable — the notice just shows again next time
  }
}
