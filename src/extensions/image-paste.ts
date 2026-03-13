import { EditorView } from "@codemirror/view";
import { uploadImage } from "@/services/firebase";
import { useAuthStore } from "@/stores/auth-store";

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
  };
  return map[mime] || "png";
}

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Upload timeout")), ms)),
  ]);
}

/**
 * Cloud-only image processing for pasted images (raw bytes).
 * Uploads to Firebase Storage — fails with error if upload fails.
 */
export async function processImageFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const ext = file.name
    ? file.name.split(".").pop()?.toLowerCase() || "png"
    : extFromMime(file.type);
  const altText = file.name?.replace(/\.[^.]+$/, "") || "image";

  const user = useAuthStore.getState().user;
  if (!user) {
    throw new Error("ログインが必要です");
  }

  const cloudUrl = await withTimeout(uploadImage(user.uid, bytes, ext), 15_000);
  return `![${altText}](${cloudUrl})`;
}

/**
 * Cloud-only image processing for file paths (D&D, file picker).
 * Reads file bytes and uploads to Firebase Storage — fails with error if upload fails.
 */
export async function processImagePath(path: string): Promise<string> {
  const name = path.split("/").pop()?.replace(/\.[^.]+$/, "") || "image";
  const ext = path.split(".").pop()?.toLowerCase() || "png";

  const user = useAuthStore.getState().user;
  if (!user) {
    throw new Error("ログインが必要です");
  }

  const { readFile } = await import("@tauri-apps/plugin-fs");
  const bytes = await readFile(path);
  const cloudUrl = await withTimeout(uploadImage(user.uid, bytes, ext), 15_000);
  return `![${name}](${cloudUrl})`;
}

/**
 * CodeMirror extension that handles image paste and drag-and-drop.
 * Uploads images to Firebase Storage (cloud-only) and inserts markdown image syntax.
 */
export const imagePaste = EditorView.domEventHandlers({
  paste(event, view) {
    const items = event.clipboardData?.items;
    if (!items) return false;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) return true;

        const pos = view.state.selection.main.head;
        const placeholder = "![Uploading...]()";
        view.dispatch({
          changes: { from: pos, insert: placeholder },
        });

        processImageFile(file)
          .then((md) => {
            const doc = view.state.doc.toString();
            const idx = doc.indexOf(placeholder);
            if (idx >= 0) {
              view.dispatch({
                changes: { from: idx, to: idx + placeholder.length, insert: md },
              });
            }
          })
          .catch((err) => {
            const doc = view.state.doc.toString();
            const idx = doc.indexOf(placeholder);
            if (idx >= 0) {
              const errMsg = `![Upload failed: ${err?.message || "Unknown error"}]()`;
              view.dispatch({
                changes: { from: idx, to: idx + placeholder.length, insert: errMsg },
              });
            }
          });

        return true;
      }
    }
    return false;
  },

  drop(event, view) {
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return false;

    const imageFiles = Array.from(files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (imageFiles.length === 0) return false;

    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;

    Promise.all(imageFiles.map(processImageFile))
      .then((markdowns) => {
        const insert = markdowns.join("\n");
        view.dispatch({
          changes: { from: pos, insert: insert + "\n" },
        });
      })
      .catch(() => {});

    return true;
  },
});
