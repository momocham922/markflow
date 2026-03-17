import { auth } from "./firebase";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "http://localhost:8080";

export type ContentBlock = {
  type: "text";
  text: string;
} | {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface CustomTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface SendOptions {
  systemPrompt: string;
  messages: ClaudeMessage[];
  onChunk?: (text: string) => void;
  tools?: boolean;
  customTools?: CustomTool[];
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

// Raw API call — returns full response JSON (non-streaming) or text (streaming)
async function callClaudeApi(
  idToken: string,
  body: Record<string, unknown>,
  onChunk?: (text: string) => void,
  signal?: AbortSignal,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const response = await fetch(`${AI_PROXY_URL}/v1/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
    signal,
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
    }
    return fullText;
  }

  return await response.json();
}

function buildToolsList(tools?: boolean, customTools?: CustomTool[]): unknown[] | undefined {
  if (!tools && (!customTools || customTools.length === 0)) return undefined;
  const allTools: unknown[] = [];
  if (tools) {
    allTools.push({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
  }
  if (customTools) {
    for (const t of customTools) {
      allTools.push({ name: t.name, description: t.description, input_schema: t.input_schema });
    }
  }
  return allTools;
}

export async function sendToClaude(
  _unused: string,
  systemPrompt: string,
  messages: ClaudeMessage[],
  onChunk?: (text: string) => void,
  tools?: boolean,
  customTools?: CustomTool[],
): Promise<string> {
  const idToken = await getFirebaseIdToken();

  abortClaude();
  const controller = new AbortController();
  activeAbortController = controller;

  const toolsList = buildToolsList(tools, customTools);
  const body: Record<string, unknown> = {
    system: systemPrompt,
    messages,
    max_tokens: 4096,
    stream: !!onChunk,
  };
  if (toolsList) body.tools = toolsList;

  try {
    const result = await callClaudeApi(idToken, body, onChunk, controller.signal);

    if (onChunk) return result as string;

    // Extract text from response
    if (Array.isArray(result.content)) {
      return result.content
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("");
    }
    return result.content?.[0]?.text || "";
  } finally {
    activeAbortController = null;
  }
}

/**
 * Send to Claude with MCP tool execution loop.
 * When Claude returns tool_use blocks, calls the tool and sends results back.
 * onChunk is only used for the final response (after all tool calls are resolved).
 */
export async function sendWithToolLoop(
  systemPrompt: string,
  messages: ClaudeMessage[],
  onToolCall: (toolName: string, input: Record<string, unknown>) => Promise<unknown>,
  onChunk?: (text: string) => void,
  tools?: boolean,
  customTools?: CustomTool[],
  onToolStatus?: (status: string) => void,
): Promise<string> {
  const idToken = await getFirebaseIdToken();

  abortClaude();
  const controller = new AbortController();
  activeAbortController = controller;

  const toolsList = buildToolsList(tools, customTools);
  const conversationMessages = [...messages];
  const maxIterations = 10;

  try {
    for (let i = 0; i < maxIterations; i++) {
      const isLastChance = i === maxIterations - 1;
      const body: Record<string, unknown> = {
        system: systemPrompt,
        messages: conversationMessages,
        max_tokens: 4096,
        stream: false,
      };
      if (toolsList && !isLastChance) body.tools = toolsList;

      const data = await callClaudeApi(idToken, body, undefined, controller.signal);

      if (!Array.isArray(data.content)) {
        return data.content?.[0]?.text || "";
      }

      // Check for tool_use blocks
      const toolUseBlocks = data.content.filter(
        (b: { type: string }) => b.type === "tool_use",
      );

      if (toolUseBlocks.length === 0 || isLastChance) {
        // No tool use — extract text. If there's an onChunk, send the final text through it.
        const text = data.content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("");
        if (onChunk) onChunk(text);
        return text;
      }

      // Add assistant response to conversation
      conversationMessages.push({ role: "assistant", content: data.content });

      // Execute all tool calls and add results
      const toolResults: ContentBlock[] = [];
      for (const block of toolUseBlocks) {
        const { id, name, input } = block as { id: string; name: string; input: Record<string, unknown> };
        onToolStatus?.(`Calling tool: ${name}`);
        try {
          const result = await onToolCall(name, input);
          toolResults.push({
            type: "tool_result" as unknown as "text",
            tool_use_id: id,
            content: typeof result === "string" ? result : JSON.stringify(result),
          } as unknown as ContentBlock);
        } catch (err) {
          toolResults.push({
            type: "tool_result" as unknown as "text",
            tool_use_id: id,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          } as unknown as ContentBlock);
        }
      }

      conversationMessages.push({ role: "user", content: toolResults });
    }

    return "Tool execution limit reached.";
  } finally {
    activeAbortController = null;
  }
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
