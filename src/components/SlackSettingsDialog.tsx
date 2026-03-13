import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, X, Send } from "lucide-react";
import {
  loadSlackNotifyConfig,
  saveSlackNotifyConfig,
  type SlackNotifyConfig,
} from "@/services/slack-notify";

interface SlackSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SlackSettingsDialog({ open, onOpenChange }: SlackSettingsDialogProps) {
  const [config, setConfig] = useState<SlackNotifyConfig>({
    webhookUrl: "",
    channel: "",
    enabled: false,
    events: { onEdit: true, onShare: true, onComment: true },
  });
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "sending" | "ok" | "fail">("idle");

  useEffect(() => {
    if (!open) return;
    loadSlackNotifyConfig().then(setConfig);
    setTestStatus("idle");
  }, [open]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await saveSlackNotifyConfig(config);
      onOpenChange(false);
    } catch (e) {
      console.error("Failed to save Slack config:", e);
    } finally {
      setSaving(false);
    }
  }, [config, onOpenChange]);

  const handleTest = useCallback(async () => {
    if (!config.webhookUrl) return;
    setTestStatus("sending");
    try {
      const body: Record<string, unknown> = {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: ":white_check_mark: *MarkFlow* — Slack連携のテスト通知です",
            },
          },
        ],
      };
      if (config.channel) body.channel = config.channel;
      const res = await fetch(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTestStatus(res.ok ? "ok" : "fail");
    } catch {
      setTestStatus("fail");
    }
  }, [config.webhookUrl, config.channel]);

  const toggleEvent = (key: "onEdit" | "onShare" | "onComment") => {
    setConfig((c) => ({
      ...c,
      events: { ...c.events, [key]: !c.events[key] },
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Slack 通知設定</DialogTitle>
          <DialogDescription>
            ドキュメントの変更をSlackチャンネルに通知
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">通知を有効にする</span>
            <button
              className={`relative h-6 w-11 rounded-full transition-colors ${
                config.enabled ? "bg-primary" : "bg-muted"
              }`}
              onClick={() => setConfig((c) => ({ ...c, enabled: !c.enabled }))}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  config.enabled ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>

          {/* Webhook URL */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Webhook URL</label>
            <Input
              placeholder="https://hooks.slack.com/services/..."
              value={config.webhookUrl}
              onChange={(e) => setConfig((c) => ({ ...c, webhookUrl: e.target.value }))}
            />
            <p className="text-[11px] text-muted-foreground">
              Slack App の Incoming Webhooks で発行した URL
            </p>
          </div>

          {/* Channel override */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              チャンネル <span className="text-muted-foreground font-normal">(任意)</span>
            </label>
            <Input
              placeholder="#general"
              value={config.channel || ""}
              onChange={(e) => setConfig((c) => ({ ...c, channel: e.target.value }))}
            />
          </div>

          {/* Event toggles */}
          <div className="space-y-2">
            <label className="text-sm font-medium">通知するイベント</label>
            <div className="grid grid-cols-3 gap-2">
              {([
                ["onEdit", "編集"],
                ["onShare", "共有"],
                ["onComment", "コメント"],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => toggleEvent(key)}
                  className={`flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    config.events[key]
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/30"
                  }`}
                >
                  {config.events[key] && <Check className="h-3 w-3 text-primary" />}
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Test button */}
          {config.webhookUrl && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={handleTest}
                disabled={testStatus === "sending"}
              >
                <Send className="h-3 w-3" />
                テスト送信
              </Button>
              {testStatus === "ok" && (
                <span className="flex items-center gap-1 text-xs text-emerald-600">
                  <Check className="h-3 w-3" /> 送信成功
                </span>
              )}
              {testStatus === "fail" && (
                <span className="flex items-center gap-1 text-xs text-destructive">
                  <X className="h-3 w-3" /> 送信失敗
                </span>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
