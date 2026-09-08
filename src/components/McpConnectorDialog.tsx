import { useState, useCallback } from "react";
import { Check, Copy, Plug } from "lucide-react";
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

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";
// The MCP server (protected resource) endpoint Claude connects to. The OAuth 2.1
// discovery + login flow is bootstrapped from here automatically by the client.
const MCP_URL = AI_PROXY_URL ? `${AI_PROXY_URL}/mcp` : "";

// Steps reflect Claude's CURRENT connector flow (verified 2026-09 against
// Anthropic's Custom Connectors docs). Claude's UI labels are English; the exact
// Japanese translations are unverified, so each label is shown 原文ママ with a
// Japanese gloss rather than guessed.
const STEPS: { title: string; body: string }[] = [
  {
    title: "「Customize」→「Connectors」を開く",
    body: "Claude web は claude.ai/customize/connectors を開きます（デスクトップアプリは「Customize（カスタマイズ）」→「Connectors（コネクタ）」）。以前の「Settings（設定）」配下ではありません。",
  },
  {
    title: "カスタムコネクタを追加",
    body: "「+」をクリックし、続けて「Add custom connector（カスタムコネクタを追加）」を選びます。",
  },
  {
    title: "URLを入力",
    body: "「Name」に表示名（例: MarkFlow）、「Remote MCP server URL」に下のURLを入力します。認証は自動検出されるので（「Detected」と表示・既定のままでOK）、「Advanced settings」やOAuthの入力は不要です。",
  },
  {
    title: "追加してサインイン",
    body: "「Add（追加）」→「Connect（接続）」の順にクリックし、MarkFlowにログインしているのと同じGoogleアカウントでサインインして、個人ドキュメントへの読み取り専用アクセスを許可します。",
  },
  {
    title: "接続完了",
    body: "接続されると、Claudeがあなたの個人ドキュメントを検索・閲覧できるようになります（読み取り専用・あなた本人のみ）。",
  },
];

/**
 * Instructions for connecting Claude to MarkFlow's remote MCP server. Shown only
 * to allowlisted users (entitlement.mcpEnabled — owner-only during testing); the
 * UserMenu entry that opens it is gated the same way. The server exposes the
 * signed-in user's OWN personal documents, read-only, over an OAuth 2.1 flow that
 * Claude drives automatically from the URL below.
 */
export function McpConnectorDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!MCP_URL) return;
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard API can be unavailable in some WebView contexts; fall back to
      // selecting the text so the user can copy manually.
      const el = document.getElementById(
        "mcp-url-field",
      ) as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="h-4 w-4" />
            ClaudeとMarkFlowを連携（MCP）
          </DialogTitle>
          <DialogDescription>
            Claudeにこのコネクタを追加すると、あなたの個人ドキュメントを
            Claudeから検索・閲覧できるようになります（読み取り専用・あなた本人のみ）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* MCP server URL + copy */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              MCPサーバーURL
            </label>
            {MCP_URL ? (
              <div className="flex items-center gap-2">
                <input
                  id="mcp-url-field"
                  readOnly
                  value={MCP_URL}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={handleCopy}
                  title="URLをコピー"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            ) : (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                このビルドにはサーバーURLが設定されていません。
              </p>
            )}
          </div>

          {/* Steps */}
          <ol className="flex flex-col gap-3">
            {STEPS.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                    "bg-primary/10 text-xs font-semibold text-foreground tabular-nums",
                  )}
                >
                  {i + 1}
                </span>
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm font-medium">{step.title}</p>
                  <p className="text-xs text-muted-foreground">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            共有・チームのドキュメントは連携の対象外です。連携されるのは
            あなたが所有する個人ドキュメントのみで、Claudeからの書き込みはできません。
          </p>

          <p className="text-[11px] text-muted-foreground">
            カスタムコネクタの追加はClaude
            web・デスクトップアプリで行います（モバイルアプリは既製コネクタのみ）。
            Team/Enterpriseでは、まず管理者が「Organization
            settings」→「Connectors」→「Add」→「Custom」→「Web」で追加し、
            その後メンバーが各自「Connect」で認証します。
          </p>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>閉じる</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
