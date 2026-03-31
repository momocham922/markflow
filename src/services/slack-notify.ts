import * as db from "@/services/database";
import { useAuthStore } from "@/stores/auth-store";
import { saveUserSettingsToFirestore } from "@/services/firebase";

export interface SlackNotifyConfig {
  webhookUrl: string;
  channel?: string;
  enabled: boolean;
  events: {
    onEdit: boolean;
    onShare: boolean;
    onComment: boolean;
  };
}

const DEFAULT_CONFIG: SlackNotifyConfig = {
  webhookUrl: "",
  channel: "",
  enabled: false,
  events: { onEdit: true, onShare: true, onComment: true },
};

/** Load Slack notification config from local DB */
export async function loadSlackNotifyConfig(): Promise<SlackNotifyConfig> {
  try {
    const raw = await db.getSetting("slack_notify_config");
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}

/** Save Slack notification config (local + cloud) */
export async function saveSlackNotifyConfig(config: SlackNotifyConfig): Promise<void> {
  const json = JSON.stringify(config);
  await db.setSetting("slack_notify_config", json);
  // Cloud sync
  const uid = useAuthStore.getState().user?.uid;
  if (uid) {
    saveUserSettingsToFirestore(uid, { slack_notify_config: json }).catch(() => {});
  }
}

/** Send a notification to Slack about a document event */
export async function notifySlack(
  event: "edit" | "share" | "delete",
  data: {
    docTitle: string;
    authorName?: string;
    detail?: string;
    shareUrl?: string;
  },
): Promise<void> {
  const config = await loadSlackNotifyConfig();
  if (!config.enabled || !config.webhookUrl) return;

  // Check if this event type is enabled
  if (event === "edit" && !config.events.onEdit) return;
  if (event === "share" && !config.events.onShare) return;

  const emoji = event === "edit" ? "✏️" : event === "share" ? "🔗" : "🗑️";
  const action =
    event === "edit" ? "updated" : event === "share" ? "shared" : "deleted";

  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${data.docTitle}* was ${action}${data.authorName ? ` by ${data.authorName}` : ""}`,
      },
    },
  ];

  if (data.detail) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: data.detail }],
    });
  }

  if (data.shareUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open Document" },
          url: data.shareUrl,
        },
      ],
    });
  }

  const body: Record<string, unknown> = { blocks };
  if (config.channel) body.channel = config.channel;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("send_slack_webhook", {
      webhookUrl: config.webhookUrl,
      body: JSON.stringify(body),
    });
  } catch {
    // Silently fail — notifications shouldn't break the app
  }
}
