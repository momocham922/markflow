import { useEffect, useState } from "react";
import { Check, Loader2, Sparkles, Users, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isMobile } from "@/platform";
import {
  useEntitlementStore,
  featureLabel,
  BILLING_ENABLED,
  type BillingInterval,
  type ViewAsPlan,
} from "@/stores/entitlement-store";
import { PRICING, yen } from "@/lib/pricing";
import { UsageMeter } from "@/components/UsageMeter";

interface PlanFeature {
  label: string;
}

const PLAN_INFO: Record<
  Exclude<ViewAsPlan, "free">,
  {
    name: string;
    tagline: string;
    icon: typeof Sparkles;
    unit: string;
    features: PlanFeature[];
    recommended?: boolean;
  }
> = {
  pro: {
    name: "Pro",
    tagline: "個人の執筆・リサーチを本格的に",
    icon: Sparkles,
    unit: "",
    features: [
      { label: "AIリクエスト 月2,000回" },
      { label: "音声認識 月6,000回" },
      { label: "文字起こし 月3,000分" },
      { label: "画像生成 月500枚" },
      { label: "ライブリサーチ（会議中の自動リサーチ）" },
    ],
    recommended: true,
  },
  team: {
    name: "Team",
    tagline: "チームでの共同編集と共有に",
    icon: Users,
    // Per-seat billing: the price below is for ONE seat and the shared AI pool
    // scales with the seat count (base × seats). The metered allowances shown
    // here are PER SEAT.
    unit: "／席",
    features: [
      { label: "Proのすべての機能" },
      { label: "AIリクエスト 月4,000回／席" },
      { label: "音声認識 月12,000回／席" },
      { label: "文字起こし 月6,000分／席" },
      { label: "画像生成 月1,000枚／席" },
      { label: "チーム共有フォルダ・共同編集" },
    ],
  },
};

function PlanCard({
  plan,
  interval,
  currentPlan,
  busy,
  onSubscribe,
  onManage,
  purchasable,
  ctaLabel,
  manageLabel = "契約を管理",
  ctaShowsExternal = true,
}: {
  plan: Exclude<ViewAsPlan, "free">;
  interval: BillingInterval;
  currentPlan: string | null;
  busy: boolean;
  onSubscribe: (plan: Exclude<ViewAsPlan, "free">) => void;
  onManage: () => void;
  purchasable: boolean;
  /** Primary CTA label; defaults to "{name}にアップグレード". */
  ctaLabel?: string;
  /** Manage-button label (shown when this is the current plan). */
  manageLabel?: string;
  /** Whether the CTA shows the external-link glyph (false for in-app routing). */
  ctaShowsExternal?: boolean;
}) {
  const info = PLAN_INFO[plan];
  const Icon = info.icon;
  const price = PRICING[plan][interval];
  const perSeat = plan === "team";
  const isCurrent = currentPlan === plan;
  // year list price = month × 12; show the saving vs paying monthly.
  const monthlyEquivalent = PRICING[plan].month * 12;
  const yearSaving = monthlyEquivalent - PRICING[plan].year;

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-lg border p-4 sm:p-5",
        info.recommended
          ? "border-primary/60 bg-primary/[0.03] shadow-sm"
          : "border-border",
      )}
    >
      {info.recommended && (
        <span className="absolute -top-2.5 left-5 rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
          おすすめ
        </span>
      )}
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-base font-semibold">{info.name}</h3>
        {isCurrent && (
          <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            現在のプラン
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{info.tagline}</p>

      <div className="mt-3 sm:mt-4 flex items-baseline gap-1">
        <span className="text-2xl font-bold tracking-tight">
          {yen(interval === "year" ? Math.round(price / 12) : price)}
        </span>
        <span className="text-xs text-muted-foreground">
          {perSeat ? "/席・月" : "/月"}
          {interval === "year" && "（年払い）"}
        </span>
      </div>
      {interval === "year" ? (
        <p className="mt-0.5 text-[11px] text-emerald-600">
          {perSeat ? "1席あたり年額 " : "年額 "}
          {yen(price)} — {yen(yearSaving)}お得
        </p>
      ) : (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          年払いなら{perSeat ? "1席あたり" : ""} {yen(yearSaving)}お得
        </p>
      )}
      {perSeat && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          席数分のお支払い（合計 = 席単価 × 席数）
        </p>
      )}

      <ul className="mt-3 sm:mt-4 flex-1 space-y-1.5 sm:space-y-2">
        {info.features.map((f) => (
          <li key={f.label} className="flex items-start gap-2 text-xs">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <span>{f.label}</span>
          </li>
        ))}
      </ul>

      <div className="mt-4 sm:mt-5">
        {isCurrent ? (
          <Button
            variant="outline"
            className="w-full"
            disabled={busy || !purchasable}
            onClick={onManage}
          >
            {manageLabel}
          </Button>
        ) : purchasable ? (
          <Button
            variant={info.recommended ? "default" : "outline"}
            className="w-full"
            disabled={busy}
            onClick={() => onSubscribe(plan)}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                {ctaLabel ?? `${info.name}にアップグレード`}
                {ctaShowsExternal && <ExternalLink className="h-3.5 w-3.5" />}
              </>
            )}
          </Button>
        ) : (
          <Button variant="outline" className="w-full" disabled>
            近日対応予定
          </Button>
        )}
      </div>
    </div>
  );
}

export function PaywallDialog() {
  const {
    paywallOpen,
    paywallReason,
    closePaywall,
    effectivePlan,
    startCheckout,
    openBillingPortal,
    openTeamManage,
    billingBusy,
    billingError,
    fetchEntitlement,
  } = useEntitlementStore();
  const [interval, setInterval] = useState<BillingInterval>("month");

  // Refresh usage/limits when the paywall opens so the meter reflects the exact
  // count that just triggered it (a 429 already refetches, but the paywall can
  // also be opened manually from the StatusBar/UserMenu where usage may be stale).
  useEffect(() => {
    if (paywallOpen) void fetchEntitlement();
  }, [paywallOpen, fetchEntitlement]);

  // Team billing needs a concrete team (teamId) + seat count, which this generic
  // paywall has no context for. Route the Team card into team management, where
  // the buyer picks the team + seats and drives the seat-aware checkout.
  const goToTeamManage = () => openTeamManage();

  // Pro is purchasable on every platform: desktop/web via Stripe, mobile via
  // native IAP (StoreKit/Play). Mobile only lights up once billing is live
  // (BILLING_ENABLED) so pre-GO builds still show "近日対応予定". Team is per-seat
  // and sold on desktop/web only — there is no mobile Team SKU — so it is never
  // purchasable on mobile. Anti-steering compliant: the mobile Pro CTA drives the
  // native IAP sheet (startCheckout → purchaseMobileSubscription), never an
  // external web page (hence no external-link glyph on mobile).
  const proPurchasable = !isMobile || BILLING_ENABLED;
  const teamPurchasable = !isMobile;

  return (
    <Dialog open={paywallOpen} onOpenChange={(o) => !o && closePaywall()}>
      {/* Tighter vertical rhythm on phones (gap-3) so the sheet isn't cramped,
          and hide the (ugly) overflow scrollbar on THIS dialog only — the
          base DialogContent keeps it scrollable, we just don't paint the bar. */}
      <DialogContent className="sm:max-w-2xl gap-3 sm:gap-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <DialogHeader>
          <DialogTitle>プランをアップグレード</DialogTitle>
          <DialogDescription>
            {paywallReason
              ? `「${featureLabel(paywallReason)}」が今月の上限に達しました。上位プランで大幅に上限が広がります。`
              : "より多くのAI・音声・リサーチ機能をご利用いただけます。"}
          </DialogDescription>
        </DialogHeader>

        {/* Current plan + live usage (also gives Free users context on which
            meter they've exhausted before being asked to upgrade). */}
        <UsageMeter highlight={paywallReason} />

        {/* Billing interval toggle */}
        <div className="flex justify-center">
          <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
            <button
              className={cn(
                "rounded px-3 py-1 transition-colors",
                interval === "month"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setInterval("month")}
            >
              月払い
            </button>
            <button
              className={cn(
                "rounded px-3 py-1 transition-colors",
                interval === "year"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setInterval("year")}
            >
              年払い（お得）
            </button>
          </div>
        </div>

        {/* Mobile: Team is not purchasable here (per-seat, desktop/web only), so
            a second full-height card is just wasted vertical space that forces
            the sheet to scroll. Show only the Pro card + a one-line Team pointer.
            Desktop keeps the side-by-side comparison. */}
        {isMobile ? (
          <PlanCard
            plan="pro"
            interval={interval}
            currentPlan={effectivePlan}
            busy={billingBusy}
            onSubscribe={(p) => startCheckout(p, interval)}
            onManage={openBillingPortal}
            purchasable={proPurchasable}
            ctaShowsExternal={false}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <PlanCard
              plan="pro"
              interval={interval}
              currentPlan={effectivePlan}
              busy={billingBusy}
              onSubscribe={(p) => startCheckout(p, interval)}
              onManage={openBillingPortal}
              purchasable={proPurchasable}
              ctaShowsExternal={!isMobile}
            />
            <PlanCard
              plan="team"
              interval={interval}
              currentPlan={effectivePlan}
              busy={billingBusy}
              // Team purchase + seat management both live in the team dialog.
              onSubscribe={goToTeamManage}
              onManage={goToTeamManage}
              purchasable={teamPurchasable}
              ctaLabel="チームを設定して購入"
              manageLabel="チーム席を管理"
              ctaShowsExternal={false}
            />
          </div>
        )}

        {isMobile && (
          <p className="text-center text-[11px] text-muted-foreground">
            Teamプラン（チーム共同編集・共有フォルダ）はデスクトップ版またはWebからご利用いただけます。
          </p>
        )}

        {billingError && (
          <p className="text-center text-xs text-red-500">{billingError}</p>
        )}

        <p className="text-center text-[11px] text-muted-foreground">
          {!isMobile
            ? "お支払いはStripeの安全な決済ページで行われます。いつでもキャンセルできます。"
            : proPurchasable
              ? "Proプランはアプリ内課金でご購入いただけます。Teamプランはデスクトップ版またはWebからご購入ください。"
              : "モバイルアプリでのご購入は近日対応予定です。デスクトップ版またはWebからアップグレードいただけます。"}
        </p>
      </DialogContent>
    </Dialog>
  );
}
