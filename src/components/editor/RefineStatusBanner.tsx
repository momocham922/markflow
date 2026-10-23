import { useEffect } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Waypoints,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryRefineJob } from "@/services/refine-runner";
import {
  isRefineBusy,
  useRefineStore,
  type RefineDocState,
} from "@/stores/refine-store";
import { useContextSourceStore } from "@/stores/context-source-store";
import { useEntitlementStore } from "@/stores/entitlement-store";

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

  // A configured context source that could not contribute to THIS document's
  // last Refine. Shown so the gap is never silent, with a way to re-connect.
  const lastOutcomes = useContextSourceStore((s) => s.lastOutcomes);
  const lastOutcomesDocId = useContextSourceStore((s) => s.lastOutcomesDocId);
  const dismissOutcomes = useContextSourceStore((s) => s.dismissOutcomes);
  const openContextSources = useEntitlementStore((s) => s.openContextSources);
  const contextFailed =
    lastOutcomesDocId === docId
      ? lastOutcomes.filter((o) => o.status === "auth" || o.status === "error")
      : [];

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

  if (contextFailed.length > 0 && !isRefineBusy(state)) {
    const names = contextFailed.map((o) => o.name).join("・");
    const anyAuth = contextFailed.some((o) => o.status === "auth");
    return (
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs border-t border-amber-200 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 min-w-[12rem]">
          情報源「{names}
          」に接続できなかったため、この整形は録音だけで作成しました。
          {anyAuth ? "トークンの再入力が必要かもしれません。" : ""}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={() => openContextSources()}
        >
          <Waypoints className="mr-1 h-3 w-3" />
          再接続
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={() => dismissOutcomes()}
          title="閉じる"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
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
