/**
 * Platform detection and adapter export.
 *
 * Detects whether we're running inside Tauri or a plain browser,
 * and exports the appropriate platform adapter.
 */
import type { PlatformAdapter } from "./types";

function detectTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Detect iOS (both Tauri iOS and mobile Safari) */
function detectIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** True when running on iOS (Tauri iOS or Safari) — cached after first call */
export const isIOS = detectIOS();

/** True when running inside Tauri (desktop or iOS) */
export const isTauri = detectTauri();

let _adapter: PlatformAdapter | null = null;

export async function getPlatform(): Promise<PlatformAdapter> {
  if (_adapter) return _adapter;

  if (detectTauri()) {
    const { tauriAdapter } = await import("./tauri");
    _adapter = tauriAdapter;
  } else {
    const { webAdapter } = await import("./web");
    _adapter = webAdapter;
  }
  return _adapter;
}

/** Synchronous check — returns cached adapter or null if not yet initialized */
export function getPlatformSync(): PlatformAdapter | null {
  return _adapter;
}

export type { PlatformAdapter, OgpData, SaveFileOptions, OpenFileOptions, FileDialogFilter } from "./types";
