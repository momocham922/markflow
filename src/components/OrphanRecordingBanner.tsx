import { useCallback, useEffect, useState } from "react";
import { Mic, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isMobile, isTauri } from "@/platform";
import { useAuthStore } from "@/stores/auth-store";
import {
  describeOrphan,
  dismissOrphan,
  getOrphanVoiceArchive,
  isOrphanDismissed,
  type OrphanVoiceArchive,
} from "@/lib/voice-archive";

// =====================================================================
// "Previous recording found" notice.
// ---------------------------------------------------------------------
// A recording whose in-memory archive path was lost (app crashed / was killed
// / restarted) used to vanish without a trace: the audio was still on disk but
// "Refine" never appeared. The native side now re-adopts the newest orphaned
// archive; this bar tells the signed-in user it exists and how to turn it into
// minutes. Shown once per file (closing it records the file as dismissed);
// re-checked on resume and every minute so it disappears after Refine uploads
// the audio. Only orphans from the last 14 days are announced.
// =====================================================================

const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

export function OrphanRecordingBanner() {
  const user = useAuthStore((s) => s.user);
  const [orphan, setOrphan] = useState<OrphanVoiceArchive | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri || !useAuthStore.getState().user) {
      setOrphan(null);
      return;
    }
    try {
      const o = await getOrphanVoiceArchive();
      if (
        o &&
        !isOrphanDismissed(o.key) &&
        Date.now() - o.modifiedMs < MAX_AGE_MS
      ) {
        setOrphan(o);
      } else {
        setOrphan(null);
      }
    } catch (e) {
      console.warn("[voice] orphan archive check failed:", e);
      setOrphan(null);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setOrphan(null);
      return;
    }
    void refresh();
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [user, refresh]);

  if (!orphan || !user) return null;

  return (
    <div
      className={cn(
        "fixed inset-x-0 z-90 flex justify-center px-3",
        isMobile ? "safe-left safe-right" : "bottom-4",
      )}
      style={
        isMobile
          ? { bottom: "calc(0.75rem + var(--safe-area-bottom))" }
          : undefined
      }
      role="region"
      aria-live="polite"
      aria-label="前回の録音"
    >
      <div className="flex w-full max-w-xl items-start gap-3 rounded-lg border border-border bg-popover p-4 shadow-lg">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Mic className="h-4 w-4 text-primary" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm font-medium text-foreground">
            前回の録音が見つかりました
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {describeOrphan(orphan)}
            が、文字起こしされないまま残っています。新しいドキュメントを開き、マイクのボタンで音声パネルを開いて「Refine」を押すと、録音全体を文字起こし・構造化できます。
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 -mt-1 h-7 w-7 shrink-0 text-muted-foreground"
          onClick={() => {
            dismissOrphan(orphan.key);
            setOrphan(null);
          }}
          aria-label="閉じる"
          title="閉じる"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
