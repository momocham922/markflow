import { useState, useCallback, useEffect, useMemo } from "react";
import { Loader2, Plug, Trash2, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import {
  useContextSourceStore,
  type AddOutcome,
} from "@/stores/context-source-store";
import {
  SLOTS,
  PROBE_BEFORE_MS,
  PROBE_AFTER_MS,
} from "@/services/context-slots";

/**
 * Add an MCP server that Refine may consult when filling gaps in a recording.
 *
 * Nothing is taken on trust: adding a server calls one of its read-only tools
 * for the window around a real recording and keeps it only if the answer carries
 * a speaker, a timestamp and a body. A server that cannot do that is refused,
 * and the refusal spells out what was tried and what was missing — that message
 * is how people learn what MarkFlow can actually use.
 */
export function ContextSourceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const uid = useAuthStore((s) => s.user?.uid ?? null);
  const documents = useAppStore((s) => s.documents);
  const { sources, loaded, testing, load, add, remove } =
    useContextSourceStore();

  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [outcome, setOutcome] = useState<AddOutcome | null>(null);

  useEffect(() => {
    if (open && uid && !loaded) void load(uid);
  }, [open, uid, loaded, load]);

  // Option C: probe with the most recent real recording, so a non-empty answer
  // proves the server can answer the question Refine will actually ask. No
  // recording yet means there is nothing honest to probe with.
  const recordedAtMs = useMemo(() => {
    let latest = 0;
    for (const d of documents) {
      const t = d.voiceRecordedAt ?? 0;
      if (t > latest) latest = t;
    }
    return latest;
  }, [documents]);

  const windowLabel = useMemo(() => {
    if (!recordedAtMs) return "";
    const f = (ms: number) =>
      new Date(ms).toLocaleString("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    return `${f(recordedAtMs - PROBE_BEFORE_MS)} 〜 ${f(recordedAtMs + PROBE_AFTER_MS)}`;
  }, [recordedAtMs]);

  const onAdd = useCallback(async () => {
    if (!uid || !recordedAtMs) return;
    setOutcome(null);
    const result = await add(uid, url, token, recordedAtMs);
    setOutcome(result);
    if (result.ok) {
      setUrl("");
      setToken("");
    }
  }, [uid, url, token, recordedAtMs, add]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="h-4 w-4" />
            議事録の補完に使う情報源
          </DialogTitle>
          <DialogDescription>
            Refine
            が録音だけでは分からないこと（発言者の氏名、担当の向き、打合せ後の
            進捗）を補うために参照する MCP サーバです。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="rounded-md border border-border/60 p-3">
            <div className="font-medium">MarkFlow が使えるのは次の情報です</div>
            <div className="mt-1 text-muted-foreground">
              ・{SLOTS.messages.question}
              <br />
              　必要な項目: {SLOTS.messages.needs.join("・")}
            </div>
          </div>

          {sources.length > 0 && (
            <div className="space-y-2">
              <div className="font-medium">追加済み</div>
              {sources.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-medium">
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                      {s.name}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {s.url}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => uid && void remove(uid, s.id)}
                    aria-label={`${s.name} を削除`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <div className="font-medium">サーバを追加</div>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="https://example.com/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="アクセストークン（任意）"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              トークンはこの端末にのみ保存され、MarkFlow
              のサーバには送信されません。
              別の端末では入力し直す必要があります。
            </p>
          </div>

          {recordedAtMs ? (
            <p className="text-xs text-muted-foreground">
              追加時に、直近の録音の前後（{windowLabel}）を実際に問い合わせて、
              使える形の答えが返るかを確認します。読み取り専用と明示されたツール
              だけを呼びます。
            </p>
          ) : (
            <p className="text-xs text-amber-600">
              音声の録音が1件もないため、実際に確認できません。先に録音を1件作って
              ください。
            </p>
          )}

          {outcome && (
            <div
              className={
                "whitespace-pre-wrap rounded-md border p-3 text-xs " +
                (outcome.ok
                  ? "border-emerald-600/40 bg-emerald-600/5"
                  : "border-amber-600/40 bg-amber-600/5")
              }
            >
              {outcome.message}
              {outcome.report && outcome.report.attempts.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-muted-foreground">
                    試した内容を表示
                  </summary>
                  <ul className="mt-1 space-y-1">
                    {outcome.report.attempts.map((a, i) => (
                      <li key={i} className="text-muted-foreground">
                        <code>{a.tool}</code>
                        {a.args ? ` ${JSON.stringify(a.args)}` : ""} →{" "}
                        {a.skipped ?? a.error ?? a.verdict?.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            閉じる
          </Button>
          <Button
            onClick={() => void onAdd()}
            disabled={testing || !url.trim() || !recordedAtMs}
          >
            {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {testing ? "確認中…" : "接続して確認"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
