import { useEffect, useRef } from "react";
import { pushBackHandler } from "@/lib/back-button";

/**
 * Dismiss a mobile surface (drawer / panel / sheet / modal) with the hardware
 * Back button. While `isOpen` is true this registers a closer with the shared
 * back-button router (see lib/back-button.ts): Back pops the topmost registered
 * surface instead of exiting the app. Closing via in-app UI unregisters and
 * rebalances the history stack. No-op off mobile.
 */
export function useBackClose(isOpen: boolean, onClose: () => void) {
  // Keep the latest onClose without re-registering (which would churn the
  // history sentinel on every parent render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const unregister = pushBackHandler(() => onCloseRef.current());
    return unregister;
  }, [isOpen]);
}
