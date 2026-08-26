import { useEffect, useState } from "react";
import { isIOS } from "@/platform";

/**
 * Track the iOS visual viewport height to handle soft keyboard.
 * When the keyboard opens, visualViewport.height shrinks while
 * window.innerHeight stays constant. We use this to dynamically
 * resize the app container so the editor and toolbar remain visible.
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

  return { viewportHeight, keyboardVisible, offsetTop };
}
