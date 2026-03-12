import { EditorView } from "@codemirror/view";
import { uploadImage } from "@/services/firebase";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Extract file extension from a MIME type or filename.
 */
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

function extFromName(name: string): string {
  const parts = name.split(".");
  if (parts.length > 1) return parts[parts.length - 1].toLowerCase();
  return "png";
}

/**
 * Upload an image to Firebase Storage and return the markdown to insert.
 * Falls back to local save via Tauri if not logged in.
 */
async function processImageFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const ext = file.name ? extFromName(file.name) : extFromMime(file.type);
  const altText = file.name?.replace(/\.[^.]+$/, "") || "image";

  // Cloud-first: upload to Firebase Storage if logged in
  const user = useAuthStore.getState().user;
  if (user) {
    const url = await uploadImage(user.uid, bytes, ext);
    return `![${altText}](${url})`;
  }

  // Fallback: save locally via Tauri backend
  const { invoke } = await import("@tauri-apps/api/core");
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  const data = Array.from(bytes);
  const savedPath = await invoke<string>("save_image", { data, ext });
  const assetUrl = convertFileSrc(savedPath);
  return `![${altText}](${assetUrl})`;
}

/**
 * CodeMirror extension that handles image paste and drag-and-drop.
 * Uploads images to Firebase Storage (cloud-first) and inserts markdown image syntax.
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
          .catch(() => {
            const doc = view.state.doc.toString();
            const idx = doc.indexOf(placeholder);
            if (idx >= 0) {
              view.dispatch({
                changes: { from: idx, to: idx + placeholder.length, insert: "" },
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
