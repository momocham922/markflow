import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Send, Link, Copy, Check, MessageSquare } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { sendToSlack, type SlackConfig } from "@/services/slack";
import * as db from "@/services/database";

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareDialog({ open, onOpenChange }: ShareDialogProps) {
  const { activeDocId, documents } = useAppStore();
  const { user } = useAuthStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);

  const [slackWebhook, setSlackWebhook] = useState("");
  const [slackChannel, setSlackChannel] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    db.getSetting("slack_webhook").then((v) => {
      if (v) setSlackWebhook(v);
    }).catch(() => {});
    db.getSetting("slack_channel").then((v) => {
      if (v) setSlackChannel(v);
    }).catch(() => {});
  }, []);

  const handleSaveSlackConfig = async () => {
    try {
      await db.setSetting("slack_webhook", slackWebhook);
      if (slackChannel) await db.setSetting("slack_channel", slackChannel);
    } catch {}
  };

  const handleShareToSlack = async () => {
    if (!activeDoc || !slackWebhook) return;
    setSending(true);
    setError("");
    setSent(false);

    try {
      await handleSaveSlackConfig();
      const config: SlackConfig = {
        webhookUrl: slackWebhook,
        defaultChannel: slackChannel || undefined,
      };
      await sendToSlack(config, {
        title: activeDoc.title,
        content: activeDoc.content,
        channel: slackChannel || undefined,
        authorName: user?.displayName || user?.email || undefined,
      });
      setSent(true);
      setTimeout(() => setSent(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  };

  const handleCopyLink = async () => {
    if (!activeDocId) return;
    const link = `markflow://doc/${activeDocId}`;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyMarkdown = async () => {
    if (!activeDoc) return;
    const div = document.createElement("div");
    div.innerHTML = activeDoc.content;
    await navigator.clipboard.writeText(div.textContent || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            Share Document
          </DialogTitle>
          <DialogDescription>
            Share "{activeDoc?.title || "Untitled"}" with your team
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Copy actions */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Quick Share</Label>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-2"
                onClick={handleCopyLink}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Link className="h-3.5 w-3.5" />}
                Copy Link
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-2"
                onClick={handleCopyMarkdown}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy Text
              </Button>
            </div>
          </div>

          <Separator />

          {/* Slack integration */}
          <div className="space-y-3">
            <Label className="text-xs text-muted-foreground flex items-center gap-1">
              <MessageSquare className="h-3 w-3" />
              Share to Slack
            </Label>
            <div className="space-y-2">
              <Input
                placeholder="Slack Webhook URL"
                value={slackWebhook}
                onChange={(e) => setSlackWebhook(e.target.value)}
                className="text-xs"
                type="url"
              />
              <Input
                placeholder="#channel (optional)"
                value={slackChannel}
                onChange={(e) => setSlackChannel(e.target.value)}
                className="text-xs"
              />
            </div>
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
            <Button
              size="sm"
              className="w-full gap-2"
              onClick={handleShareToSlack}
              disabled={sending || !slackWebhook || !activeDoc}
            >
              {sent ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  Sent!
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  {sending ? "Sending..." : "Send to Slack"}
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
