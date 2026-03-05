export interface SlackConfig {
  webhookUrl: string;
  defaultChannel?: string;
}

export interface SlackSharePayload {
  title: string;
  content: string;
  channel?: string;
  authorName?: string;
  shareUrl?: string;
}

export async function sendToSlack(
  config: SlackConfig,
  payload: SlackSharePayload,
): Promise<void> {
  const preview = stripHtmlToText(payload.content).slice(0, 300);

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `📝 ${payload.title}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: preview + (payload.content.length > 300 ? "..." : ""),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Shared from *MarkFlow*${payload.authorName ? ` by ${payload.authorName}` : ""}`,
        },
      ],
    },
  ];

  if (payload.shareUrl) {
    blocks.push({
      type: "section" as const,
      text: {
        type: "mrkdwn",
        text: `<${payload.shareUrl}|Open in MarkFlow>`,
      },
    });
  }

  const body: Record<string, unknown> = {
    blocks,
  };

  if (payload.channel) {
    body.channel = payload.channel;
  }

  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status}`);
  }
}

function stripHtmlToText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

// Convert HTML content to Slack mrkdwn format
export function htmlToSlackMrkdwn(html: string): string {
  let text = html;
  text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "*$1*\n");
  text = text.replace(/<strong>(.*?)<\/strong>/gi, "*$1*");
  text = text.replace(/<b>(.*?)<\/b>/gi, "*$1*");
  text = text.replace(/<em>(.*?)<\/em>/gi, "_$1_");
  text = text.replace(/<i>(.*?)<\/i>/gi, "_$1_");
  text = text.replace(/<code>(.*?)<\/code>/gi, "`$1`");
  text = text.replace(/<pre><code[^>]*>(.*?)<\/code><\/pre>/gis, "```\n$1\n```");
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "<$1|$2>");
  text = text.replace(/<li>(.*?)<\/li>/gi, "• $1\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<p>(.*?)<\/p>/gi, "$1\n\n");
  text = text.replace(/<blockquote>(.*?)<\/blockquote>/gis, "> $1\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
