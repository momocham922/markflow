import { useEffect, useRef, useCallback, useState } from "react";

const SIDEBAR_WIDTH = 280;
const EDGE_THRESHOLD = 30; // px from left edge to start open gesture
const SWIPE_THRESHOLD = 80; // px to commit open/close
const VELOCITY_THRESHOLD = 0.3; // px/ms — fast flick commits regardless of distance

interface SwipeSidebarState {
  /** Current sidebar translate offset (0 = hidden, SIDEBAR_WIDTH = fully open) */
  offset: number;
  /** Whether a swipe gesture is in progress */
  swiping: boolean;
}

export function useSwipeSidebar(
  isOpen: boolean,
  toggle: () => void,
) {
  const [state, setState] = useState<SwipeSidebarState>({
    offset: isOpen ? SIDEBAR_WIDTH : 0,
    swiping: false,
  });

  const touchRef = useRef({
    startX: 0,
    startY: 0,
    startTime: 0,
    startOffset: 0,
    tracking: false,
    directionLocked: false,
    isHorizontal: false,
  });

  // Sync offset when open/close state changes externally (button tap, backdrop tap)
  useEffect(() => {
    setState({ offset: isOpen ? SIDEBAR_WIDTH : 0, swiping: false });
  }, [isOpen]);

  const onTouchStart = useCallback(
    (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      const t = touchRef.current;
      t.startX = touch.clientX;
      t.startY = touch.clientY;
      t.startTime = Date.now();
      t.directionLocked = false;
      t.isHorizontal = false;

      if (isOpen) {
        // Can swipe to close from anywhere
        t.tracking = true;
        t.startOffset = SIDEBAR_WIDTH;
      } else if (touch.clientX < EDGE_THRESHOLD) {
        // Only start open gesture from left edge
        t.tracking = true;
        t.startOffset = 0;
      } else {
        t.tracking = false;
      }
    },
    [isOpen],
  );

  const onTouchMove = useCallback(
    (e: TouchEvent) => {
      const t = touchRef.current;
      if (!t.tracking) return;
      const touch = e.touches[0];
      if (!touch) return;

      const dx = touch.clientX - t.startX;
      const dy = touch.clientY - t.startY;

      // Lock direction after first significant movement
      if (!t.directionLocked) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        t.directionLocked = true;
        t.isHorizontal = Math.abs(dx) > Math.abs(dy);
        if (!t.isHorizontal) {
          t.tracking = false;
          return;
        }
      }

      if (!t.isHorizontal) return;

      // Prevent vertical scroll while swiping horizontally
      e.preventDefault();

      const newOffset = Math.max(0, Math.min(SIDEBAR_WIDTH, t.startOffset + dx));
      setState({ offset: newOffset, swiping: true });
    },
    [],
  );

  const onTouchEnd = useCallback(
    (e: TouchEvent) => {
      const t = touchRef.current;
      if (!t.tracking || !t.isHorizontal) {
        t.tracking = false;
        return;
      }
      t.tracking = false;

      const touch = e.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - t.startX;
      const elapsed = Date.now() - t.startTime;
      const velocity = Math.abs(dx) / Math.max(1, elapsed);

      const shouldOpen = velocity > VELOCITY_THRESHOLD
        ? dx > 0
        : (t.startOffset + dx) > SWIPE_THRESHOLD;

      setState({ offset: shouldOpen ? SIDEBAR_WIDTH : 0, swiping: false });

      if (shouldOpen !== isOpen) {
        toggle();
      }
    },
    [isOpen, toggle],
  );

  useEffect(() => {
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [onTouchStart, onTouchMove, onTouchEnd]);

  return {
    sidebarTranslateX: state.offset - SIDEBAR_WIDTH, // -280 = hidden, 0 = visible
    swiping: state.swiping,
    backdropOpacity: state.offset / SIDEBAR_WIDTH, // 0..1
  };
}
