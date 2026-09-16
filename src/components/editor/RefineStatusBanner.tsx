import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryRefineJob } from "@/services/refine-runner";
import { useRefineStore, type RefineDocState } from "@/stores/refine-store";

const APPLIED_NOTICE_MS = 8000;

interface Props {
  docId: string;
  state: RefineDocState | undefined;
  /** The voice panel shows its own progress row; don't repeat it. */
  voiceOpen: boolean;
  onApply: () => void;
  onDiscard: () => void;
  onDismissError: () => void;
}

/**
 * Document-level status of a server-side Refine: background progress (when the
 * voice panel is closed), a result that needs confirmation, failures, and the
 * one-shot "applied" / "truncated" notices. Lives in the Editor, so it works
 * even when the job was started on another device or before a restart.
 */
export function RefineStatusBanner({
  docId,
  state,
  voiceOpen,
  onApply,
  onDiscard,
  onDismissError,
}: Props) {
  const notice = useRefineStore((s) =>
    s.notice && s.notice.docId === docId ? s.notice : null,
  );
  const setNotice = useRefineStore((s) => s.setNotice);

  useEffect(() => {
    if (!notice || notice.kind !== "applied") return;
    const t = setTimeout(() => setNotice(null), APPLIED_NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice, setNotice]);

  if (state?.phase === "review") {
    return (
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs border-t border-amber-200 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 min-w-[12rem]">
          Refine
          の結果が届きました。開始後にこのドキュメントが編集されているため、まだ反映していません。反映すると今の内容は置き換わります（バージョン履歴から戻せます）。
        </span>
        <Button size="sm" className="h-6 px-2 text-xs" onClick={onApply}>
          反映する
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={onDiscard}
        >
          破棄
        </Button>
      </div>
    );
  }

  if (state?.phase === "error") {
    const canRetry = !!state.jobId;
    return (
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs border-t border-destructive/20 bg-destructive/10 text-destructive">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 min-w-[12rem]">
          {state.message || "Refine に失敗しました。"}
        </span>
        {canRetry && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() => retryRefineJob(docId)}
          >
            再試行
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={onDismissError}
          title="閉じる"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  if (
    !voiceOpen &&
    (state?.phase === "transcribe" ||
      state?.phase === "structure" ||
      state?.phase === "ready")
  ) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-xs border-t text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin shrink-0" />
        <span>
          Refine をサーバーで処理中（
          {state.phase === "transcribe" ? "文字起こし" : "整形"}
          ）です。アプリを閉じても処理は続き、次に開いたときに反映されます。
        </span>
      </div>
    );
  }

  if (notice?.kind === "truncated") {
    return (
      <div
        className="flex items-center gap-2 px-4 py-2 text-xs border-t border-destructive/20 bg-destructive/10 text-destructive cursor-pointer"
        onClick={() => setNotice(null)}
        title="クリックで閉じる"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        整形がモデルの最大出力長に達し、末尾が切り捨てられた可能性があります。ドキュメントが短くなっていたらバージョン履歴から復元してください。会議が長い場合は分割をおすすめします。
      </div>
    );
  }

  if (notice?.kind === "applied") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-xs border-t text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        Refine の結果をドキュメントに反映しました。
      </div>
    );
  }

  return null;
}
