import { isMobile } from "@/platform";

/**
 * Hardware back-button router for the mobile app (Android).
 *
 * The Tauri Android shell (auto-generated WryActivity) wires the OS Back button
 * to: `if (webView.canGoBack()) webView.goBack() else finish()`. MarkFlow is a
 * single-page app with no router history, so `canGoBack()` is always false and
 * every Back press exits the whole app — even when only a drawer, panel, sheet
 * or modal is open. Users expect Back to dismiss that topmost surface first.
 *
 * Fix without touching the generated native code: give the WebView something to
 * "go back" to. Every time a dismissable surface opens we push a sentinel entry
 * onto the browser history stack (so `canGoBack()` becomes true) and register a
 * closer. Back → `webView.goBack()` → a `popstate` here → we pop the topmost
 * closer and dismiss that surface. When nothing is registered we're back at the
 * base entry, `canGoBack()` is false again, and the next Back exits the app —
 * exactly the desired behavior.
 *
 * A single popstate listener drives a LIFO stack, so multiple stacked surfaces
 * (e.g. a dialog opened over the editor) dismiss one Back press at a time in the
 * right order. `pushBackHandler` returns an unregister to call when the surface
 * closes via its OWN UI (X button, backdrop, selecting an item); that path pops
 * the sentinel it pushed so the history stack stays balanced.
 */

interface Entry {
  id: number;
  close: () => void;
}

let stack: Entry[] = [];
let nextId = 1;
let initialized = false;
// Set true right before we call history.back() ourselves (UI-driven close) so
// the resulting popstate doesn't also fire a closer and double-dismiss.
let suppressNextPop = false;

function ensureInit() {
  if (initialized) return;
  initialized = true;
  window.addEventListener("popstate", () => {
    if (suppressNextPop) {
      suppressNextPop = false;
      return;
    }
    const top = stack[stack.length - 1];
    if (!top) return; // at base entry — let the shell exit on the next Back
    // The sentinel this entry pushed has already been consumed by the browser
    // going back, so just drop it from the stack (no history.back() here) and
    // dismiss the surface.
    stack = stack.filter((e) => e.id !== top.id);
    top.close();
  });
}

/**
 * Register a closer for a surface that just opened. Pushes a history sentinel so
 * the hardware Back button dismisses this surface instead of exiting the app.
 * Returns an unregister function to call when the surface closes via in-app UI.
 * No-op off mobile.
 */
export function pushBackHandler(close: () => void): () => void {
  if (!isMobile) return () => {};
  ensureInit();
  const id = nextId++;
  stack.push({ id, close });
  window.history.pushState({ mfOverlay: id }, "");
  return () => {
    const idx = stack.findIndex((e) => e.id === id);
    if (idx === -1) return; // already removed by a popstate (Back) dismiss
    stack.splice(idx, 1);
    // Our sentinel is still on the history stack — pop it so history stays
    // balanced, and suppress the closer for the popstate it triggers.
    suppressNextPop = true;
    window.history.back();
  };
}
