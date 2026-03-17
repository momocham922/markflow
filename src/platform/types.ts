/**
 * Platform abstraction layer.
 *
 * Defines the interface that both Tauri (desktop) and Web (iOS/PWA) must implement.
 * Each platform provides its own adapter; consumers import from `@/platform`.
 */

export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

export interface SaveFileOptions {
  defaultPath?: string;
  filters?: FileDialogFilter[];
}

export interface OpenFileOptions {
  multiple?: boolean;
  filters?: FileDialogFilter[];
}

export interface OgpData {
  title: string;
  description: string;
  image: string;
  site_name: string;
  url: string;
}

export interface PlatformAdapter {
  /** True when running inside Tauri (desktop) */
  isTauri: boolean;

  // --- File dialogs ---
  /** Show save-file dialog, returns chosen path or null */
  showSaveDialog(options: SaveFileOptions): Promise<string | null>;
  /** Show open-file dialog, returns chosen paths or null */
  showOpenDialog(options: OpenFileOptions): Promise<string[] | null>;
  /** Write text content to a file at the given path */
  writeTextFile(path: string, content: string): Promise<void>;

  // --- Shell ---
  /** Open a URL in the system browser */
  openExternal(url: string): Promise<void>;

  // --- OGP ---
  /** Fetch OpenGraph metadata for a URL */
  fetchOgp(url: string): Promise<OgpData>;

  // --- Print ---
  /** Print HTML content */
  printHtml(html: string): Promise<void>;

  // --- Image upload ---
  /** Upload image from a file path (desktop: reads file in Rust) */
  uploadImageFromPath(path: string, uid: string, token: string, bucket: string): Promise<string>;
  /** Upload image from base64 data */
  uploadImageFromBase64(data: string, ext: string, uid: string, token: string, bucket: string): Promise<string>;

  // --- OAuth ---
  /** Start OAuth listener, returns port for callback URL */
  startOAuthListener(): Promise<number>;
  /** Listen for OAuth callback event, returns auth code */
  onOAuthCallback(callback: (code: string) => void): Promise<() => void>;
  /** Listen for OAuth error event */
  onOAuthError(callback: (error: string) => void): Promise<() => void>;

  // --- Window events ---
  /** Listen for window close event */
  onWindowClose(callback: () => Promise<void>): Promise<(() => void) | null>;
  /** Listen for file drag-drop events */
  onDragDrop(callback: (paths: string[], position: { x: number; y: number }) => void): Promise<(() => void) | null>;

  // --- Auto-update ---
  /** Check for app updates, returns update info or null */
  checkForUpdate(channel?: "stable" | "beta"): Promise<{ version: string; body?: string; install: () => Promise<void> } | null>;
  /** Relaunch the app after update */
  relaunch(): Promise<void>;
}
