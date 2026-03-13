/**
 * Web (iOS/PWA) platform adapter.
 *
 * Provides browser-native fallbacks for Tauri APIs.
 * Used when running as a web app (iOS, PWA, or dev without Tauri).
 */
import type { PlatformAdapter, OgpData, SaveFileOptions, OpenFileOptions } from "./types";

export const webAdapter: PlatformAdapter = {
  isTauri: false,

  async showSaveDialog(options: SaveFileOptions): Promise<string | null> {
    // Use browser download API as fallback
    // Return a dummy path — actual file saving happens via blob download
    const ext = options.filters?.[0]?.extensions?.[0] || "txt";
    const name = options.defaultPath || `document.${ext}`;
    return name;
  },

  async showOpenDialog(options: OpenFileOptions): Promise<string[] | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = options.multiple ?? false;
      if (options.filters) {
        input.accept = options.filters
          .flatMap((f) => f.extensions.map((e) => `.${e}`))
          .join(",");
      }
      input.onchange = () => {
        if (input.files && input.files.length > 0) {
          // For web, we return object URLs that can be fetched
          const urls = Array.from(input.files).map((f) => URL.createObjectURL(f));
          resolve(urls);
        } else {
          resolve(null);
        }
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },

  async writeTextFile(path: string, content: string): Promise<void> {
    // Browser fallback: trigger a download
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = path.split("/").pop() || "file.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  async openExternal(url: string): Promise<void> {
    window.open(url, "_blank", "noopener,noreferrer");
  },

  async fetchOgp(url: string): Promise<OgpData> {
    // Web fallback: use a CORS proxy or return minimal data
    // In production, this would call a cloud function
    return { title: "", description: "", image: "", site_name: "", url };
  },

  async printHtml(html: string): Promise<void> {
    const win = window.open("", "_blank");
    if (win) {
      win.document.write(html);
      win.document.close();
      win.print();
    }
  },

  async uploadImageFromPath(): Promise<string> {
    throw new Error("uploadImageFromPath is not available on web. Use uploadImageFromBase64.");
  },

  async uploadImageFromBase64(data: string, ext: string, uid: string, token: string, bucket: string): Promise<string> {
    // Web fallback: upload directly via Firebase Storage REST API
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const uuid = crypto.randomUUID();
    const path = `images/${uid}/${uuid}.${ext}`;
    const uploadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}`;

    const response = await fetch(`${uploadUrl}?uploadType=media`, {
      method: "POST",
      headers: {
        "Content-Type": `image/${ext}`,
        Authorization: `Bearer ${token}`,
      },
      body: bytes,
    });

    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    return `${uploadUrl}?alt=media`;
  },

  async startOAuthListener(): Promise<number> {
    // Web: OAuth uses redirect flow, no local listener needed
    return 0;
  },

  async onOAuthCallback(): Promise<() => void> {
    // Web: handled by Firebase auth redirect
    return () => {};
  },

  async onOAuthError(): Promise<() => void> {
    return () => {};
  },

  async onWindowClose(): Promise<(() => void) | null> {
    // Web: use beforeunload
    return null;
  },

  async onDragDrop(): Promise<(() => void) | null> {
    // Web: native HTML5 drag-drop handled separately
    return null;
  },

  async checkForUpdate(): Promise<null> {
    // Web: no auto-update mechanism
    return null;
  },

  async relaunch(): Promise<void> {
    window.location.reload();
  },
};
