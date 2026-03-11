import { useRef, useCallback } from "react";

/**
 * Returns input props that reliably block Enter/Escape during IME composition.
 *
 * WebKit (Tauri/WKWebView) fires `compositionend` BEFORE `keydown` for the
 * confirming Enter, so `e.nativeEvent.isComposing` is already `false` by then.
 * We track composition state manually and keep the flag `true` for one tick
 * after `compositionend` to cover the subsequent `keydown`.
 */
export function useIMEGuard() {
  const composing = useRef(false);

  const onCompositionStart = useCallback(() => {
    composing.current = true;
  }, []);

  const onCompositionEnd = useCallback(() => {
    // Delay clearing — the keydown for the confirming Enter fires
    // synchronously after compositionend in WebKit.
    setTimeout(() => {
      composing.current = false;
    }, 20);
  }, []);

  const isComposing = useCallback(() => composing.current, []);

  return { onCompositionStart, onCompositionEnd, isComposing };
}
