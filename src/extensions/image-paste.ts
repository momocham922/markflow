import { EditorView } from "@codemirror/view";
import { auth } from "@/services/firebase";
import { useAuthStore } from "@/stores/auth-store";
import { getPlatform } from "@/platform";

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

const STORAGE_BUCKET = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "";

async function getFirebaseToken(): Promise<string> {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) throw new Error("Firebase auth not ready");
  return firebaseUser.getIdToken();
}

/**
 * Upload image from a file path — Rust reads and uploads (no byte IPC).
 */
async function uploadFromPath(uid: string, path: string): Promise<string> {
  const token = await getFirebaseToken();
  const platform = await getPlatform();
  return platform.uploadImageFromPath(path, uid, token, STORAGE_BUCKET);
}

/**
 * Upload image from raw bytes — base64 encode to avoid JSON array overhead.
 */
async function uploadFromBytes(
  uid: string,
  data: Uint8Array,
  ext: string,
): Promise<string> {
  const token = await getFirebaseToken();
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  const base64Data = btoa(binary);
  const platform = await getPlatform();
  return platform.uploadImageFromBase64(
    base64Data,
    ext,
    uid,
    token,
    STORAGE_BUCKET,
  );
}

/**
 * Cloud-only image processing for pasted images (raw bytes).
 */
export async function processImageFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const ext = file.name
    ? file.name.split(".").pop()?.toLowerCase() || "png"
    : extFromMime(file.type);
  const altText = file.name?.replace(/\.[^.]+$/, "") || "image";

  const user = useAuthStore.getState().user;
  if (!user) throw new Error("ログインが必要です");

  const cloudUrl = await uploadFromBytes(user.uid, bytes, ext);
  return `![${altText}](${cloudUrl})`;
}

/**
 * Cloud-only image processing for file paths (D&D, file picker).
 * Everything happens in Rust — no byte transfer over IPC.
 */
export async function processImagePath(path: string): Promise<string> {
  const name =
    path
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") || "image";

  const user = useAuthStore.getState().user;
  if (!user) throw new Error("ログインが必要です");

  const cloudUrl = await uploadFromPath(user.uid, path);
  return `![${name}](${cloudUrl})`;
}

/**
 * Build a placeholder whose token is embedded in the (unused) URL so the
 * alt-text stays clean while `indexOf()` still matches THIS placeholder even
 * when several uploads run concurrently or the document already contains an
 * identical "Uploading..." literal. Without the unique token, indexOf would
 * match the first occurrence and swap the wrong image in.
 */
export function makeUploadPlaceholder(label = "Uploading image..."): string {
  return `![${label}](uploading:${crypto.randomUUID()})`;
}

/**
 * Replace a previously-inserted placeholder with final text, re-reading the
 * live doc so concurrent edits/uploads don't desync positions. Returns false
 * when the placeholder is no longer present (user deleted it mid-upload).
 */
export function replaceUploadPlaceholder(
  view: EditorView,
  placeholder: string,
  insert: string,
): boolean {
  const doc = view.state.doc.toString();
  const idx = doc.indexOf(placeholder);
  if (idx < 0) return false;
  view.dispatch({
    changes: { from: idx, to: idx + placeholder.length, insert },
  });
  return true;
}

/**
 * CodeMirror extension that handles image paste and drag-and-drop.
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
        const placeholder = makeUploadPlaceholder("Uploading...");
        view.dispatch({
          changes: { from: pos, insert: placeholder },
        });

        processImageFile(file)
          .then((md) => {
            replaceUploadPlaceholder(view, placeholder, md);
          })
          .catch((err) => {
            const errMsg = `![Upload failed: ${err instanceof Error ? err.message : String(err)}]()`;
            replaceUploadPlaceholder(view, placeholder, errMsg);
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
    const pos =
      view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
      view.state.selection.main.head;

    // Insert a placeholder so a slow/failed upload is visible instead of
    // silently doing nothing (empty catch previously swallowed all errors).
    const placeholder = makeUploadPlaceholder();
    view.dispatch({
      changes: { from: pos, insert: placeholder + "\n" },
    });

    Promise.all(imageFiles.map(processImageFile))
      .then((markdowns) => {
        replaceUploadPlaceholder(view, placeholder, markdowns.join("\n"));
      })
      .catch((err) => {
        const errMsg = `![Upload failed: ${err instanceof Error ? err.message : String(err)}]()`;
        replaceUploadPlaceholder(view, placeholder, errMsg);
      });

    return true;
  },
});
