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
