import { cn } from "@/lib/utils";
import {
  useEntitlementStore,
  featureLabel,
  planLabel,
  billingSourceGuidance,
  formatExpiryDate,
  type Feature,
} from "@/stores/entitlement-store";

// =====================================================================
// Usage meter (flat per-feature monthly call-count model — MONETIZATION §1.2)
// ---------------------------------------------------------------------
// Renders the current plan's live usage as "X / Y" per metered feature with a
// progress bar, straight from the entitlement store (the single UI source of
// truth = the ai-proxy /v1/me/entitlement snapshot). This is also what gives a
// FREE user context inside the paywall: they see exactly which meter they've
// exhausted before being asked to upgrade.
//
// - limits === null  → unlimited (internal/owner) — shown as "無制限".
// - limit    <  0    → that feature is unlimited on this plan — "無制限".
// - unit: batchMin is minutes; everything else is a plain count.
// =====================================================================

// Fixed display order (highest-signal first).
const FEATURE_ORDER: Feature[] = ["aiCalls", "sttCalls", "batchMin", "images"];

function unitOf(feature: Feature): string {
  return feature === "batchMin" ? "分" : "回";
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("ja-JP");
}

function MeterRow({
  feature,
  used,
  limit,
  highlight,
}: {
  feature: Feature;
  used: number;
  limit: number;
  highlight: boolean;
}) {
  const unlimited = limit < 0;
  const pct = unlimited
    ? 0
    : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const over = !unlimited && used >= limit;
  const near = !unlimited && !over && pct >= 80;

  return (
    <div
      className={cn(
        "rounded-md px-2.5 py-2",
        highlight ? "bg-primary/[0.06] ring-1 ring-primary/30" : "",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-foreground">{featureLabel(feature)}</span>
        <span
          className={cn(
            "text-[11px] tabular-nums",
            over
              ? "font-semibold text-red-600"
              : near
                ? "font-medium text-amber-600"
                : "text-muted-foreground",
          )}
        >
          {unlimited ? (
            "無制限"
          ) : (
            <>
              {fmt(used)}
              <span className="text-muted-foreground/70">
                {" "}
                / {fmt(limit)}
                {unitOf(feature)}
              </span>
            </>
          )}
        </span>
      </div>
      {!unlimited && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              over ? "bg-red-500" : near ? "bg-amber-500" : "bg-primary",
            )}
            style={{ width: `${Math.max(pct, used > 0 ? 4 : 0)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Compact per-feature usage panel for the current effective plan.
 * `highlight` visually emphasizes the meter that triggered the paywall.
 */
export function UsageMeter({
  highlight = null,
}: {
  highlight?: Feature | null;
}) {
  const effectivePlan = useEntitlementStore((s) => s.effectivePlan);
  const limits = useEntitlementStore((s) => s.limits);
  const usage = useEntitlementStore((s) => s.usage);
  const seats = useEntitlementStore((s) => s.seats);
  const loaded = useEntitlementStore((s) => s.loaded);
  const source = useEntitlementStore((s) => s.source);
  const expiresDate = useEntitlementStore((s) => s.expiresDate);

  if (!loaded || !effectivePlan) return null;

  const unlimited = limits === null; // internal/owner
  const isPaid = effectivePlan === "pro" || effectivePlan === "team";
  // `source` records where a subscription WAS billed and can linger as
  // "app_store"/"play" on the entitlement doc after a cancel/expiry downgrades
  // the user to Free (the server does not clear it, and the read-time expiry
  // backstop returns effectivePlan=free without rewriting source). Only surface
  // the store-management guidance ("このプランはiOSアプリ経由でご購入…") when the
  // user actually HOLDS a paid plan — otherwise a Free user is told they have an
  // active iOS purchase they no longer have.
  const guidance = isPaid ? billingSourceGuidance(source) : "";
  const renewOn = isPaid ? formatExpiryDate(expiresDate) : "";

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs font-medium text-foreground">
          今月のご利用状況
        </span>
        <span className="text-[11px] text-muted-foreground">
          {planLabel(effectivePlan)}プラン
          {effectivePlan === "team" && seats > 1 ? `・${seats}席` : ""}
        </span>
      </div>
      {unlimited ? (
        <p className="px-1 py-1 text-[11px] text-muted-foreground">
          このプランでは利用上限はありません。
        </p>
      ) : (
        <div className="space-y-1.5">
          {FEATURE_ORDER.map((f) => (
            <MeterRow
              key={f}
              feature={f}
              used={usage[f] ?? 0}
              limit={limits[f] ?? 0}
              highlight={highlight === f}
            />
          ))}
        </div>
      )}
      <p className="mt-2 px-1 text-[10px] text-muted-foreground/80">
        毎月1日（日本時間）にリセットされます。
        {renewOn ? `　次回更新日: ${renewOn}` : ""}
      </p>
      {guidance ? (
        <p className="mt-2 rounded-md bg-muted/60 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          {guidance}
        </p>
      ) : null}
    </div>
  );
}
