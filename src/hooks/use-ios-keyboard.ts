import { useEffect, useState } from "react";
import { isIOS, isAndroid } from "@/platform";

/**
 * Track the mobile soft-keyboard so the app container can shrink to the visible
 * area (keeping the editor, toolbar, and input rows above the keyboard).
 *
 * iOS: driven by window.visualViewport (height shrinks while innerHeight stays).
 *
 * Android: window.visualViewport is unreliable in the WebView (Tauri #10631) and
 * env(safe-area) never reports the keyboard, so MainActivity measures the IME
 * WindowInsets natively and pushes --android-ime-bottom (CSS px) + a
 * `markflow-android-insets` DOM event. We reconcile that keyboard height with the
 * WebView's own window.innerHeight so the layout is correct WHETHER OR NOT the
 * framework resizes the WebView under enforced edge-to-edge:
 *   visible = min(innerHeight, fullHeight - kbHeight)
 *   - view resized  → innerHeight already dropped → min picks it (no double-shift)
 *   - view NOT resized → innerHeight full → min picks fullHeight - kbHeight
 */
export function useIOSKeyboard() {
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  // How far the visual viewport has been pushed down inside the layout viewport.
  // When iOS scrolls a focused field into view it offsets the visual viewport
  // rather than the (position:fixed) layout, so a fixed overlay pinned at top:0
  // appears to drift upward. Fixed overlays counter this by using top:offsetTop.
  const [offsetTop, setOffsetTop] = useState(0);

  // Lock body position on iOS to prevent viewport scrolling
  useEffect(() => {
    if (!isIOS) return;
    const s = document.body.style;
    s.position = "fixed";
    s.inset = "0";
    s.overflow = "hidden";
    return () => {
      s.position = "";
      s.inset = "";
      s.overflow = "";
    };
  }, []);

  useEffect(() => {
    if (!isIOS) return;

    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const vvHeight = Math.round(vv.height);
      const diff = window.innerHeight - vvHeight;
      const kbVisible = diff > 100;
      // Only push state when it actually changes. visualViewport fires `scroll`
      // continuously while the keyboard animates and while a focused field grows;
      // re-rendering on every tick is what makes the input wobble on iOS.
      setKeyboardVisible((prev) => (prev === kbVisible ? prev : kbVisible));
      // When keyboard is hidden, use innerHeight (avoids mismatch with safe areas)
      // When keyboard is visible, use visualViewport height (actual visible area)
      const nextHeight = kbVisible ? vvHeight : window.innerHeight;
      setViewportHeight((prev) => (prev === nextHeight ? prev : nextHeight));
      // Track the visual-viewport offset so fixed overlays can re-pin to the
      // actually-visible region instead of drifting when iOS shifts it.
      const nextOffset = kbVisible ? Math.round(vv.offsetTop) : 0;
      setOffsetTop((prev) => (prev === nextOffset ? prev : nextOffset));
      // Keep iOS from scrolling the layout viewport when the keyboard opens — but
      // only correct it when it has actually drifted. Calling scrollTo(0,0) on
      // every `scroll` event re-enters this handler and fights the browser's own
      // focus-scroll, which is the root of the focus jank.
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // Android soft-keyboard, driven by the natively-measured --android-ime-bottom
  // (see MainActivity). No visualViewport / body-position-lock here — the app
  // shell is already position:fixed and the height shrink is the sole correction.
  useEffect(() => {
    if (!isAndroid) return;

    // Last known keyboard-DOWN inner height. innerHeight is the reliable measure
    // of the WebView's own size on Android; re-baseline it whenever the keyboard
    // is down so an intervening rotation / resize is picked up.
    let fullHeight = window.innerHeight;

    const readKb = (): number => {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--android-ime-bottom")
        .trim();
      const px = parseInt(raw, 10);
      return Number.isFinite(px) && px > 0 ? px : 0;
    };

    const update = () => {
      const kb = readKb();
      const inner = window.innerHeight;
      if (kb <= 0) {
        // Keyboard down: innerHeight is the true full height — re-baseline.
        fullHeight = inner;
        setKeyboardVisible((prev) => (prev === false ? prev : false));
        setViewportHeight((prev) => (prev === inner ? prev : inner));
        return;
      }
      // Keyboard up. min() reconciles the two possible framework behaviours:
      // if the WebView resized, `inner` already excludes the keyboard; if it did
      // not, `fullHeight - kb` shrinks the shell to sit above the keyboard.
      const visible = Math.min(inner, fullHeight - kb);
      setKeyboardVisible((prev) => (prev === true ? prev : true));
      setViewportHeight((prev) => (prev === visible ? prev : visible));
    };

    update();
    document.addEventListener("markflow-android-insets", update);
    window.addEventListener("resize", update);

    return () => {
      document.removeEventListener("markflow-android-insets", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return { viewportHeight, keyboardVisible, offsetTop };
}
