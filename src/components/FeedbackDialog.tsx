import { useState, useEffect } from "react";
import { Bug, Lightbulb, MessageSquare, Loader2, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { submitFeedback, type FeedbackKind } from "@/services/feedback";
import { useAppStore } from "@/stores/app-store";

const KINDS: {
  value: FeedbackKind;
  label: string;
  icon: typeof Bug;
  placeholder: string;
}[] = [
  {
    value: "bug",
    label: "バグ報告",
    icon: Bug,
    placeholder:
      "どんな操作で、何が起きましたか？ 再現手順があれば助かります。",
  },
  {
    value: "idea",
    label: "要望・アイデア",
    icon: Lightbulb,
    placeholder: "あったら嬉しい機能や改善のアイデアを教えてください。",
  },
  {
    value: "other",
    label: "その他",
    icon: MessageSquare,
    placeholder: "ご意見・ご感想など、自由にお書きください。",
  },
];

const MAX = 5000;

/**
 * In-app feedback (bug report / feature request). Posts to ai-proxy /v1/feedback,
 * which is authoritative for identity + PII redaction. Only a NON-PII diagnostic
 * context (app version / platform / active doc id) is attached — never the
 * document body. When opened from a captured crash, `prefillError` seeds the
 * report and defaults the kind to "bug".
 */
export function FeedbackDialog({
  open,
  onOpenChange,
  prefillError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefillError?: string | null;
}) {
  const activeDocId = useAppStore((s) => s.activeDocId);
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Seed from a crash when the dialog opens; reset when it closes.
  useEffect(() => {
    if (open) {
      setKind(prefillError ? "bug" : "bug");
      setMessage("");
      setError(null);
      setDone(false);
      setSubmitting(false);
    }
  }, [open, prefillError]);

  const active = KINDS.find((k) => k.value === kind) ?? KINDS[0];
  const armed = message.trim().length >= 3 && !submitting;

  const handleClose = (next: boolean) => {
    if (submitting) return; // never dismiss mid-submit
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    if (!armed) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitFeedback(kind, message, {
        activeDocId,
        error: prefillError || undefined,
      });
      setDone(true);
      // Brief success confirmation, then auto-close.
      setTimeout(() => onOpenChange(false), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました。");
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>問題を報告・フィードバック</DialogTitle>
          <DialogDescription>
            不具合のご報告や機能のご要望をお寄せください。開発の改善に役立てます。
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
              <Check className="h-6 w-6 text-green-500" />
            </div>
            <p className="text-sm text-muted-foreground">
              送信しました。ありがとうございます。
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* kind segmented control */}
            <div className="grid grid-cols-3 gap-1.5">
              {KINDS.map((k) => {
                const Icon = k.icon;
                const selected = k.value === kind;
                return (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => setKind(k.value)}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-md border px-2 py-3 text-xs transition-colors",
                      selected
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {k.label}
                  </button>
                );
              })}
            </div>

            {prefillError && (
              <div className="rounded-md border border-border bg-muted/40 p-2">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                  添付されるエラー情報
                </p>
                <pre className="max-h-20 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
                  {prefillError.slice(0, 500)}
                </pre>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, MAX))}
                placeholder={active.placeholder}
                rows={6}
                autoFocus
                className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  個人情報や機密情報は自動で除去されます。文書の本文は送信されません。
                </span>
                <span className="tabular-nums">
                  {message.length}/{MAX}
                </span>
              </div>
            </div>

            {error && (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        {!done && (
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => handleClose(false)}
              disabled={submitting}
            >
              キャンセル
            </Button>
            <Button onClick={handleSubmit} disabled={!armed}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              送信
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
