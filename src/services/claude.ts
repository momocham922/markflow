import { auth } from "./firebase";
import { aiProxyHeaders, reportIfQuota } from "./ai-proxy";
import { track } from "./telemetry";

const AI_PROXY_URL =
  import.meta.env.VITE_AI_PROXY_URL || "http://localhost:8080";

export type ContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

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
  if (!user)
    throw new Error("Not authenticated. Please sign in with Google first.");
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
    headers: aiProxyHeaders(idToken),
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const error = await response.text();
    reportIfQuota(response.status, error);
    throw new Error(`AI error: ${response.status} ${error}`);
  }

  if (onChunk) {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    // Assemble the full content-block list while streaming so the tool loop can
    // detect client `tool_use` blocks AND still push live text deltas to the UI.
    // Blocks are index-keyed because the SSE interleaves start/delta/stop events.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: Record<number, any> = {};
    const jsonBuf: Record<number, string> = {};

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
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const idx = parsed.index ?? 0;
            switch (parsed.type) {
              case "content_block_start": {
                const cb = parsed.content_block ?? {};
                blocks[idx] =
                  cb.type === "text" ? { type: "text", text: "" } : { ...cb };
                if (cb.type === "tool_use" || cb.type === "server_tool_use") {
                  jsonBuf[idx] = "";
                  blocks[idx].input = cb.input ?? {};
                }
                break;
              }
              case "content_block_delta": {
                const d = parsed.delta ?? {};
                if (d.type === "text_delta" && typeof d.text === "string") {
                  fullText += d.text;
                  if (blocks[idx])
                    blocks[idx].text = (blocks[idx].text || "") + d.text;
                  else blocks[idx] = { type: "text", text: d.text };
                  onChunk(fullText);
                } else if (
                  d.type === "input_json_delta" &&
                  typeof d.partial_json === "string"
                ) {
                  jsonBuf[idx] = (jsonBuf[idx] || "") + d.partial_json;
                } else if (typeof d.text === "string") {
                  // Backward-compat with any delta shape that only carries text.
                  fullText += d.text;
                  onChunk(fullText);
                }
                break;
              }
              case "content_block_stop": {
                if (jsonBuf[idx] !== undefined && blocks[idx]) {
                  try {
                    blocks[idx].input = JSON.parse(jsonBuf[idx] || "{}");
                  } catch {
                    /* keep whatever was parsed at start */
                  }
                }
                break;
              }
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const content = Object.keys(blocks)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => blocks[k]);
    return { text: fullText, content };
  }

  return await response.json();
}

function buildToolsList(
  tools?: boolean,
  customTools?: CustomTool[],
): unknown[] | undefined {
  if (!tools && (!customTools || customTools.length === 0)) return undefined;
  const allTools: unknown[] = [];
  if (tools) {
    allTools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3,
    });
  }
  if (customTools) {
    for (const t of customTools) {
      allTools.push({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      });
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

  track("ai_request", {
    mode: onChunk ? "stream" : "oneshot",
    tools: !!toolsList,
  });

  try {
    const result = await callClaudeApi(
      idToken,
      body,
      onChunk,
      controller.signal,
    );

    if (onChunk) return (result as { text: string }).text;

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
  onToolCall: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>,
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

  track("ai_request", { mode: "tool_loop", tools: !!toolsList });

  try {
    for (let i = 0; i < maxIterations; i++) {
      const isLastChance = i === maxIterations - 1;
      const body: Record<string, unknown> = {
        system: systemPrompt,
        messages: conversationMessages,
        max_tokens: 4096,
        // Stream every iteration so ordinary chat (and the final answer after a
        // tool call) shows live text. The SSE assembler in callClaudeApi still
        // reconstructs the full content-block list so tool_use is detectable.
        stream: true,
      };
      if (toolsList && !isLastChance) body.tools = toolsList;

      const streamed = (await callClaudeApi(
        idToken,
        body,
        (text) => onChunk?.(text),
        controller.signal,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      )) as { text: string; content: any[] };

      const content = Array.isArray(streamed?.content) ? streamed.content : [];

      // Check for client tool_use blocks (server tools like web_search are
      // resolved by the API and never surface here).
      const toolUseBlocks = content.filter(
        (b: { type: string }) => b?.type === "tool_use",
      );

      if (toolUseBlocks.length === 0 || isLastChance) {
        // No tool use — extract text (already streamed via onChunk).
        const text =
          content
            .filter((b: { type: string }) => b?.type === "text")
            .map((b: { text: string }) => b.text || "")
            .join("") ||
          streamed?.text ||
          "";
        if (onChunk) onChunk(text);
        return text;
      }

      // Add assistant response to conversation
      conversationMessages.push({ role: "assistant", content });

      // Execute all tool calls and add results
      const toolResults: ContentBlock[] = [];
      for (const block of toolUseBlocks) {
        const { id, name, input } = block as {
          id: string;
          name: string;
          input: Record<string, unknown>;
        };
        onToolStatus?.(`Calling tool: ${name}`);
        try {
          const result = await onToolCall(name, input);
          toolResults.push({
            type: "tool_result" as unknown as "text",
            tool_use_id: id,
            content:
              typeof result === "string" ? result : JSON.stringify(result),
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
  {
    id: "summarize",
    label: "Summarize",
    icon: "FileText",
    prompt: "Summarize the following text concisely:",
  },
  {
    id: "improve",
    label: "Improve writing",
    icon: "Sparkles",
    prompt:
      "Improve the writing quality of the following text. Keep the same meaning and structure, but make it clearer and more polished:",
  },
  {
    id: "translate_en",
    label: "Translate to English",
    icon: "Languages",
    prompt: "Translate the following text to English:",
  },
  {
    id: "translate_ja",
    label: "Translate to Japanese",
    icon: "Languages",
    prompt: "Translate the following text to Japanese:",
  },
  {
    id: "fix_grammar",
    label: "Fix grammar",
    icon: "Check",
    prompt: "Fix the grammar and spelling in the following text:",
  },
  {
    id: "make_shorter",
    label: "Make shorter",
    icon: "Minimize",
    prompt:
      "Make the following text more concise while preserving the key information:",
  },
  {
    id: "make_longer",
    label: "Expand",
    icon: "Maximize",
    prompt: "Expand and add more detail to the following text:",
  },
  {
    id: "bullet_points",
    label: "To bullet points",
    icon: "List",
    prompt: "Convert the following text into clear bullet points:",
  },
] as const;
