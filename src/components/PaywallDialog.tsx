import { useState } from "react";
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
  type BillingInterval,
  type ViewAsPlan,
} from "@/stores/entitlement-store";

// =====================================================================
// Displayed pricing (JPY, tax-inclusive). These MUST equal the amounts on
// the corresponding Stripe Prices — the server resolves the priceId and
// Stripe charges its OWN configured amount, so any mismatch here is only a
// display bug, never an overcharge. Keep in sync with the Stripe dashboard
// (see MONETIZATION.md → owner runbook).
// =====================================================================
const PRICING: Record<
  Exclude<ViewAsPlan, "free">,
  { month: number; year: number }
> = {
  pro: { month: 1280, year: 11760 },
  team: { month: 1980, year: 19800 },
};

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

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
    // Checkout currently bills a flat quantity:1 (single subscription), so the
    // price is NOT per-seat. Show no "／人" unit to avoid over-charging
    // expectations. Per-seat billing is a deferred product decision.
    unit: "",
    features: [
      { label: "Proのすべての機能" },
      { label: "AIリクエスト 月4,000回" },
      { label: "音声認識 月12,000回" },
      { label: "文字起こし 月6,000分" },
      { label: "画像生成 月1,000枚" },
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
}: {
  plan: Exclude<ViewAsPlan, "free">;
  interval: BillingInterval;
  currentPlan: string | null;
  busy: boolean;
  onSubscribe: (plan: Exclude<ViewAsPlan, "free">) => void;
  onManage: () => void;
  purchasable: boolean;
}) {
  const info = PLAN_INFO[plan];
  const Icon = info.icon;
  const price = PRICING[plan][interval];
  const isCurrent = currentPlan === plan;
  // year list price = month × 12; show the saving vs paying monthly.
  const monthlyEquivalent = PRICING[plan].month * 12;
  const yearSaving = monthlyEquivalent - PRICING[plan].year;

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-lg border p-5",
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

      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-2xl font-bold tracking-tight">
          {yen(interval === "year" ? Math.round(price / 12) : price)}
        </span>
        <span className="text-xs text-muted-foreground">
          /月{info.unit}
          {interval === "year" && "（年払い）"}
        </span>
      </div>
      {interval === "year" ? (
        <p className="mt-0.5 text-[11px] text-emerald-600">
          年額 {yen(price)}
          {info.unit} — {yen(yearSaving)}お得
        </p>
      ) : (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          年払いなら {yen(yearSaving)}お得
        </p>
      )}

      <ul className="mt-4 flex-1 space-y-2">
        {info.features.map((f) => (
          <li key={f.label} className="flex items-start gap-2 text-xs">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <span>{f.label}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5">
        {isCurrent ? (
          <Button
            variant="outline"
            className="w-full"
            disabled={busy || !purchasable}
            onClick={onManage}
          >
            契約を管理
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
                {info.name}にアップグレード
                <ExternalLink className="h-3.5 w-3.5" />
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
    billingBusy,
    billingError,
  } = useEntitlementStore();
  const [interval, setInterval] = useState<BillingInterval>("month");

  // Anti-steering: Apple/Google forbid routing IN-APP users to an external
  // web purchase. On mobile we show the plans for information only (IAP is a
  // separate, later track); the actual purchase happens on desktop/web.
  const purchasable = !isMobile;

  return (
    <Dialog open={paywallOpen} onOpenChange={(o) => !o && closePaywall()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>プランをアップグレード</DialogTitle>
          <DialogDescription>
            {paywallReason
              ? `「${featureLabel(paywallReason)}」が今月の上限に達しました。上位プランで大幅に上限が広がります。`
              : "より多くのAI・音声・リサーチ機能をご利用いただけます。"}
          </DialogDescription>
        </DialogHeader>

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

        <div className="grid gap-4 sm:grid-cols-2">
          <PlanCard
            plan="pro"
            interval={interval}
            currentPlan={effectivePlan}
            busy={billingBusy}
            onSubscribe={(p) => startCheckout(p, interval)}
            onManage={openBillingPortal}
            purchasable={purchasable}
          />
          <PlanCard
            plan="team"
            interval={interval}
            currentPlan={effectivePlan}
            busy={billingBusy}
            onSubscribe={(p) => startCheckout(p, interval)}
            onManage={openBillingPortal}
            purchasable={purchasable}
          />
        </div>

        {billingError && (
          <p className="text-center text-xs text-red-500">{billingError}</p>
        )}

        <p className="text-center text-[11px] text-muted-foreground">
          {purchasable
            ? "お支払いはStripeの安全な決済ページで行われます。いつでもキャンセルできます。"
            : "モバイルアプリでのご購入は近日対応予定です。デスクトップ版またはWebからアップグレードいただけます。"}
        </p>
      </DialogContent>
    </Dialog>
  );
}
