/**
 * Tauri (desktop) platform adapter.
 *
 * All @tauri-apps/* imports are isolated here.
 * Dynamic imports ensure graceful degradation if Tauri APIs are unavailable.
 */
import type { PlatformAdapter, OgpData, SaveFileOptions, OpenFileOptions } from "./types";

export const tauriAdapter: PlatformAdapter = {
  isTauri: true,

  async showSaveDialog(options: SaveFileOptions): Promise<string | null> {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return await save({
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
  },

  async showOpenDialog(options: OpenFileOptions): Promise<string[] | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      multiple: options.multiple ?? false,
      filters: options.filters,
    });
    if (!result) return null;
    return Array.isArray(result) ? result : [result];
  },

  async writeTextFile(path: string, content: string): Promise<void> {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, content);
  },

  async openExternal(url: string): Promise<void> {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  },

  async fetchOgp(url: string): Promise<OgpData> {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<OgpData>("fetch_ogp", { url });
  },

  async printHtml(html: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("print_html", { html });
  },

  async uploadImageFromPath(path: string, uid: string, token: string, bucket: string): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("upload_image_from_path", { path, uid, token, bucket });
  },

  async uploadImageFromBase64(data: string, ext: string, uid: string, token: string, bucket: string): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("upload_image_from_base64", { base64Data: data, ext, uid, token, bucket });
  },

  async startOAuthListener(): Promise<number> {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<number>("oauth_listen");
  },

  async onOAuthCallback(callback: (code: string) => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<string>("oauth-callback", (event) => {
      callback(event.payload);
    });
    return unlisten;
  },

  async onOAuthError(callback: (error: string) => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<string>("oauth-error", (event) => {
      callback(event.payload);
    });
    return unlisten;
  },

  async onWindowClose(callback: () => Promise<void>): Promise<(() => void) | null> {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const unlisten = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        await callback();
        await win.destroy();
      });
      return unlisten;
    } catch {
      return null;
    }
  },

  async onDragDrop(callback: (paths: string[], position: { x: number; y: number }) => void): Promise<(() => void) | null> {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{ paths: string[]; position: { x: number; y: number } }>(
        "tauri://drag-drop",
        (event) => callback(event.payload.paths, event.payload.position),
      );
      return unlisten;
    } catch {
      return null;
    }
  },

  async checkForUpdate(channel: "stable" | "beta" = "stable"): Promise<{ version: string; body?: string; install: () => Promise<void> } | null> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ version: string; body: string | null } | null>(
        "check_for_update",
        { channel },
      );
      if (!result) return null;
      return {
        version: result.version,
        body: result.body ?? undefined,
        install: async () => {
          await invoke("install_update", { channel });
        },
      };
    } catch {
      return null;
    }
  },

  async relaunch(): Promise<void> {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
};
