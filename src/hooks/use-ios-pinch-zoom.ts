import { useEffect, useRef } from "react";
import { isIOS } from "@/platform";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3.0;

/**
 * Handle pinch-to-zoom on iOS via CSS zoom (not native viewport zoom).
 * Returns nothing — directly mutates the target element's style.zoom for performance.
 */
export function useIOSPinchZoom(
  containerRef: React.RefObject<HTMLElement | null>,
  zoomLevel: number,
  setZoomLevel: (z: number) => void,
) {
  const baseDistRef = useRef(0);
  const baseZoomRef = useRef(1);

  useEffect(() => {
    if (!isIOS) return;
    const el = containerRef.current;
    if (!el) return;

    // Apply current zoom
    el.style.zoom = String(zoomLevel);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      baseDistRef.current = Math.hypot(dx, dy);
      baseZoomRef.current = zoomLevel;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || baseDistRef.current === 0) return;
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const dist = Math.hypot(dx, dy);
      const scale = dist / baseDistRef.current;
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, baseZoomRef.current * scale));
      el.style.zoom = String(newZoom);
      // Prevent native scroll/zoom during pinch
      e.preventDefault();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (baseDistRef.current === 0) return;
      if (e.touches.length < 2) {
        // Commit final zoom
        const current = parseFloat(el.style.zoom || "1");
        if (current !== zoomLevel) {
          setZoomLevel(current);
        }
        baseDistRef.current = 0;
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [containerRef, zoomLevel, setZoomLevel]);
}
