import { useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/stores/auth-store";

// Word the user must type to arm the irreversible delete. Kept in Japanese to
// match the app's locale and to make an accidental confirmation unlikely.
const CONFIRM_WORD = "削除";

/**
 * In-app account deletion (Apple App Store Guideline 5.1.1(v)). Explains exactly
 * what is removed, requires typing a confirmation word, then calls the server
 * cascade via auth-store.deleteAccount(). On success the user is signed out and
 * every local trace is wiped, so the app returns to the sign-in screen.
 */
export function DeleteAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteAccount = useAuthStore((s) => s.deleteAccount);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = confirmText.trim() === CONFIRM_WORD && !deleting;

  const reset = () => {
    setConfirmText("");
    setError(null);
    setDeleting(false);
  };

  const handleClose = (next: boolean) => {
    if (deleting) return; // never dismiss mid-deletion
    if (!next) reset();
    onOpenChange(next);
  };

  const handleDelete = async () => {
    if (!armed) return;
    setDeleting(true);
    setError(null);
    const res = await deleteAccount();
    if (res.ok) {
      // The store already cleared the session + local data; App.tsx swaps to the
      // sign-in screen. Close the dialog.
      reset();
      onOpenChange(false);
      return;
    }
    setError(res.error || "アカウントの削除に失敗しました。");
    setDeleting(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <TriangleAlert className="h-5 w-5" />
            アカウントを削除
          </DialogTitle>
          <DialogDescription>
            この操作は取り消せません。アカウントと、それに紐づくすべてのデータが完全に削除されます。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">削除される内容:</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>すべてのドキュメントと編集履歴</li>
            <li>あなたが作成したチームと共有設定</li>
            <li>公開ページ・アップロードした画像・音声データ</li>
            <li>
              プラン・お支払い情報（有効なサブスクリプションは解約されます）
            </li>
          </ul>
          <p className="text-muted-foreground">
            続行するには
            <span className="mx-1 font-semibold text-foreground">
              「{CONFIRM_WORD}」
            </span>
            と入力してください。
          </p>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={CONFIRM_WORD}
            disabled={deleting}
            autoComplete="off"
            aria-label="削除の確認"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleClose(false)}
            disabled={deleting}
          >
            キャンセル
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!armed}
          >
            {deleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                削除中…
              </>
            ) : (
              "アカウントを完全に削除"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
