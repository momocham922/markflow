import { useState } from "react";
import { BarChart3, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTelemetryStore } from "@/stores/telemetry-store";
import { isMobile } from "@/platform";

// =====================================================================
// Regional consent surface for product analytics.
// ---------------------------------------------------------------------
// Shown once, until the user makes an explicit choice. The wording + default
// action branch on the detected region (see services/consent-region.ts):
//   - eu    (opt_in) : collection is OFF by default; ask for permission.
//   - jp    (opt_out): collection is ON by default; give a clear notice + a
//                       one-tap way to turn it off.
//   - other (notice) : same as jp — notice + easy opt-out.
// The banner NEVER blocks the app; it is a dismissible bar. Document contents
// are never part of telemetry — the copy says so explicitly. Lucide icons only.
// =====================================================================

export function TelemetryConsentBanner() {
  const ready = useTelemetryStore((s) => s.ready);
  const decided = useTelemetryStore((s) => s.decided);
  const mode = useTelemetryStore((s) => s.mode);
  const setConsent = useTelemetryStore((s) => s.setConsent);
  const [busy, setBusy] = useState(false);

  if (!ready || decided) return null;

  const isOptIn = mode === "opt_in";

  const choose = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await setConsent(on);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "fixed inset-x-0 z-90 flex justify-center px-3",
        isMobile ? "safe-left safe-right" : "bottom-4",
      )}
      // Mobile: lift the banner above the OS navigation bar (Android) / home
      // indicator (iOS) using the measured safe-area inset, same as the other
      // bottom-anchored surfaces.
      style={
        isMobile
          ? { bottom: "calc(0.75rem + var(--safe-area-bottom))" }
          : undefined
      }
      role="region"
      aria-live="polite"
      aria-label="プライバシー設定"
    >
      <div className="flex w-full max-w-xl flex-col gap-3 rounded-lg border border-border bg-popover p-4 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <BarChart3 className="h-4 w-4 text-primary" />
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">
              利用状況データについて
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {isOptIn
                ? "製品改善のため、匿名の利用状況データの収集を許可しますか？ 文書の内容やタイトルは一切送信されません。設定からいつでも変更できます。"
                : "MarkFlow は製品改善のため、匿名の利用状況データを収集します。文書の内容やタイトルは一切送信されません。設定からいつでもオフにできます。"}
            </p>
          </div>
          {!isOptIn && (
            <Button
              variant="ghost"
              size="icon"
              className="-mr-1 -mt-1 h-7 w-7 shrink-0 text-muted-foreground"
              onClick={() => choose(true)}
              disabled={busy}
              title="閉じる"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          {isOptIn ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => choose(false)}
                disabled={busy}
              >
                許可しない
              </Button>
              <Button size="sm" onClick={() => choose(true)} disabled={busy}>
                許可する
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => choose(false)}
                disabled={busy}
              >
                オフにする
              </Button>
              <Button size="sm" onClick={() => choose(true)} disabled={busy}>
                OK
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
