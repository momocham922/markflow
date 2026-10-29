/**
 * Confirmation dialog that behaves correctly in BOTH the browser and the Tauri app.
 *
 * WHY THIS EXISTS (data-loss trap):
 * `tauri-plugin-dialog` injects an init script that REPLACES the global
 * `window.confirm` with an *async* function returning `Promise<boolean>`
 * (it resolves `true` only when the user presses OK). A natural,
 * synchronous-looking `if (window.confirm(...)) { destroy() }` therefore tests
 * a Promise object — which is ALWAYS truthy — so the guarded action runs even
 * when the user presses Cancel. This silently deleted documents/folders and
 * reset the cloud on Cancel.
 *
 * ALWAYS `await confirmDialog(...)`. Returning the (possibly-thenable) value
 * from this async function awaits it in the Tauri app; in a plain browser
 * `window.confirm` is the native synchronous boolean, which `await` passes
 * through unchanged. One call site, one behavior, both platforms.
 *
 * Do NOT call the bare global `confirm`/`window.confirm` for anything gated —
 * use this helper so the await is never forgotten again.
 */
export async function confirmDialog(message: string): Promise<boolean> {
  return window.confirm(message);
}
