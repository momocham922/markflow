const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

export async function sendToClaude(
  apiKey: string,
  systemPrompt: string,
  messages: ClaudeMessage[],
  onChunk?: (text: string) => void,
): Promise<string> {
  const response = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      stream: !!onChunk,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} ${error}`);
  }

  if (onChunk) {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    if (!reader) throw new Error("No response body");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "content_block_delta" && parsed.delta?.text) {
              fullText += parsed.delta.text;
              onChunk(fullText);
            }
          } catch {
            // Skip unparseable chunks
          }
        }
      }
    }
    return fullText;
  }

  const data = await response.json();
  return data.content?.[0]?.text || "";
}

export const AI_ACTIONS = [
  { id: "summarize", label: "Summarize", icon: "FileText", prompt: "Summarize the following text concisely:" },
  { id: "improve", label: "Improve writing", icon: "Sparkles", prompt: "Improve the writing quality of the following text. Keep the same meaning and structure, but make it clearer and more polished:" },
  { id: "translate_en", label: "Translate to English", icon: "Languages", prompt: "Translate the following text to English:" },
  { id: "translate_ja", label: "Translate to Japanese", icon: "Languages", prompt: "Translate the following text to Japanese:" },
  { id: "fix_grammar", label: "Fix grammar", icon: "Check", prompt: "Fix the grammar and spelling in the following text:" },
  { id: "make_shorter", label: "Make shorter", icon: "Minimize", prompt: "Make the following text more concise while preserving the key information:" },
  { id: "make_longer", label: "Expand", icon: "Maximize", prompt: "Expand and add more detail to the following text:" },
  { id: "bullet_points", label: "To bullet points", icon: "List", prompt: "Convert the following text into clear bullet points:" },
] as const;
