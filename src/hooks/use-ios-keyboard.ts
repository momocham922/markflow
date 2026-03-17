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
      setKeyboardVisible(kbVisible);
      // When keyboard is hidden, use innerHeight (avoids mismatch with safe areas)
      // When keyboard is visible, use visualViewport height (actual visible area)
      setViewportHeight(kbVisible ? vvHeight : window.innerHeight);
      // Prevent iOS from scrolling the page when keyboard opens
      window.scrollTo(0, 0);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return { viewportHeight, keyboardVisible };
}
