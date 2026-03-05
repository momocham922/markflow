import { auth } from "./firebase";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "http://localhost:8080";

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

async function getFirebaseIdToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated. Please sign in with Google first.");
  return await user.getIdToken();
}

// Active abort controller for cancellation support
let activeAbortController: AbortController | null = null;

export function abortClaude() {
  activeAbortController?.abort();
  activeAbortController = null;
}

export async function sendToClaude(
  _unused: string,
  systemPrompt: string,
  messages: ClaudeMessage[],
  onChunk?: (text: string) => void,
): Promise<string> {
  const idToken = await getFirebaseIdToken();

  abortClaude(); // Cancel any in-flight request
  const controller = new AbortController();
  activeAbortController = controller;

  const response = await fetch(`${AI_PROXY_URL}/v1/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      system: systemPrompt,
      messages,
      max_tokens: 4096,
      stream: !!onChunk,
    }),
    signal: controller.signal,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`AI error: ${response.status} ${error}`);
  }

  if (onChunk) {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    if (!reader) throw new Error("No response body");

    try {
      let lineBuf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split("\n");
        // Keep the last (possibly incomplete) line in the buffer
        lineBuf = lines.pop() || "";

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
              // Skip unparseable lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
      activeAbortController = null;
    }
    return fullText;
  }

  activeAbortController = null;
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
