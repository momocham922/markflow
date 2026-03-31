import { getFirestore, doc, getDoc, updateDoc } from "firebase/firestore";

export interface SlackNotifyConfig {
  webhookUrl: string;
  channel?: string;
  enabled: boolean;
  events: {
    onEdit: boolean;
    onShare: boolean;
  };
}

const DEFAULT_CONFIG: SlackNotifyConfig = {
  webhookUrl: "",
  channel: "",
  enabled: false,
  events: { onEdit: true, onShare: true },
};

/** Load Slack notification config from Firestore document */
export async function loadSlackNotifyConfig(docId: string): Promise<SlackNotifyConfig> {
  try {
    const firestore = getFirestore();
    const snap = await getDoc(doc(firestore, "documents", docId));
    const data = snap.data();
    if (data?.slackConfig) {
      return { ...DEFAULT_CONFIG, ...data.slackConfig };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

/** Save Slack notification config to Firestore document */
export async function saveSlackNotifyConfig(docId: string, config: SlackNotifyConfig): Promise<void> {
  const firestore = getFirestore();
  await updateDoc(doc(firestore, "documents", docId), { slackConfig: config });
}

/** Send a notification to Slack about a document event */
export async function notifySlack(
  docId: string,
  event: "edit" | "share",
  data: {
    docTitle: string;
    authorName?: string;
    detail?: string;
    shareUrl?: string;
  },
): Promise<void> {
  const config = await loadSlackNotifyConfig(docId);
  if (!config.enabled || !config.webhookUrl) return;

  // Check if this event type is enabled
  if (event === "edit" && !config.events.onEdit) return;
  if (event === "share" && !config.events.onShare) return;

  const emoji = event === "edit" ? "✏️" : "🔗";
  const action = event === "edit" ? "updated" : "shared";

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
