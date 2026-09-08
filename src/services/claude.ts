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

// =====================================================================
// Automatic pre-output retry (owner rule: 「エラーなら原則リトライ」)
// ---------------------------------------------------------------------
// A logical AI request that fails BEFORE any output was delivered (a flaky
// network drop, or the server returning a transient 503/504) is retried
// automatically a bounded number of times with backoff. Because the client
// re-sends the SAME Idempotency-Key, a retry can NEVER double-charge: the failed
// attempt produced no output → the server refunded it (output-aware commit), and
// a retry that finally succeeds charges exactly once. Once ANY output has been
// delivered we NEVER retry (the answer is already streaming; a retry would
// duplicate it). Aborts and real limits (401/403/429/422) are never retried;
// after auto-retry is exhausted the UI surfaces a 再生成 CTA (the next stage).
// =====================================================================
const AUTO_RETRY_MAX = 1; // automatic retries AFTER the first attempt (2 tries total)

/** Whether a pre-output failure is a transient class worth auto-retrying. */
function shouldAutoRetry(status: number | null, body: string): boolean {
  if (status != null) {
    // 429 = real quota/rate limit (retry never helps). 401/403/402/422/400 and
    // the server's non-retryable upstream 502 are permanent for this request.
    if (status === 503 || status === 504) return true;
    // Honor the server's explicit retryable flag on ai_upstream_error too.
    return /"retryable"\s*:\s*true/.test(body);
  }
  // No HTTP status → a fetch/transport failure (never reached the server, so it
  // never charged). Same connectivity class as friendlyErrorMessage's network arm.
  const s = body.toLowerCase();
  return /failed to fetch|load failed|networkerror|network error|err_network|err_connection|econnreset|econnrefused|ehostunreach|enotfound|net::|timed out|timeout/.test(
    s,
  );
}

/** Backoff for retry attempt N (1-based): ~0.6s, 1.2s … + jitter, capped. */
function retryDelayMs(attempt: number): number {
  const base = Math.min(600 * 2 ** (attempt - 1), 4000);
  return base + Math.floor(Math.random() * 300);
}

/** Sleep that rejects with an AbortError the instant `signal` aborts. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new DOMException("Aborted", "AbortError"));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Retry wrapper around callClaudeApiOnce. Retries ONLY pre-output transient
 * failures (see shouldAutoRetry); once output has been delivered, or on abort /
 * non-transient errors, it rethrows immediately.
 */
async function callClaudeApi(
  idToken: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
  onChunk?: (text: string) => void,
  signal?: AbortSignal,
  onRetry?: (attempt: number) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let delivered = false;
    try {
      return await callClaudeApiOnce(
        idToken,
        body,
        idempotencyKey,
        onChunk,
        signal,
        () => {
          delivered = true;
        },
      );
    } catch (err) {
      // A user-initiated abort is final — never retry it.
      if (
        signal?.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        throw err;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status: number | null = (err as any)?.httpStatus ?? null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bodyText: string =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any)?.httpBody ??
        (err instanceof Error ? err.message : String(err));
      if (
        delivered ||
        attempt >= AUTO_RETRY_MAX ||
        !shouldAutoRetry(status, bodyText)
      ) {
        throw err;
      }
      onRetry?.(attempt + 1);
      await abortableDelay(retryDelayMs(attempt + 1), signal);
      // fall through to next iteration → retry with the SAME idempotency key
    }
  }
}

// Single attempt — returns full response JSON (non-streaming) or text (streaming).
// `onFirstOutput` fires the first time any content delta arrives so the retry
// wrapper knows output has begun (and must not retry past this point).
async function callClaudeApiOnce(
  idToken: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
  onChunk?: (text: string) => void,
  signal?: AbortSignal,
  onFirstOutput?: () => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const response = await fetch(`${AI_PROXY_URL}/v1/chat`, {
    method: "POST",
    headers: aiProxyHeaders(idToken, idempotencyKey),
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const error = await response.text();
    reportIfQuota(response.status, error);
    // Attach the status/body so the retry wrapper can classify transience
    // without re-parsing the message string.
    const e = new Error(`AI error: ${response.status} ${error}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e as any).httpStatus = response.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e as any).httpBody = error;
    throw e;
  }

  let firstOutputFired = false;
  const markOutput = () => {
    if (!firstOutputFired) {
      firstOutputFired = true;
      onFirstOutput?.();
    }
  };

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
                  markOutput();
                  fullText += d.text;
                  if (blocks[idx])
                    blocks[idx].text = (blocks[idx].text || "") + d.text;
                  else blocks[idx] = { type: "text", text: d.text };
                  onChunk(fullText);
                } else if (
                  d.type === "input_json_delta" &&
                  typeof d.partial_json === "string"
                ) {
                  // A tool call is real output too — once it starts, don't retry.
                  markOutput();
                  jsonBuf[idx] = (jsonBuf[idx] || "") + d.partial_json;
                } else if (typeof d.text === "string") {
                  // Backward-compat with any delta shape that only carries text.
                  markOutput();
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
  // Stable per-logical-request key so error-retries / 再生成 collapse onto ONE
  // charge server-side. Omit for internal helper calls (e.g. doc summarize).
  idempotencyKey?: string,
  // Fired before each automatic pre-output retry so the UI can show a hint.
  onRetry?: (attempt: number) => void,
): Promise<string> {
  const idToken = await getFirebaseIdToken();

  abortClaude();
  const controller = new AbortController();
  activeAbortController = controller;

  const toolsList = buildToolsList(tools, customTools);
  const body: Record<string, unknown> = {
    system: systemPrompt,
    messages,
    // Max out the ceiling so nothing ever truncates mid-sentence. max_tokens is
    // only a CAP (we pay for tokens actually produced), and opus-5's adaptive
    // `thinking` spends from this same budget — a low cap can be eaten by
    // thinking before the answer starts. Streaming can safely use the model's
    // full 128K output limit; non-streaming (summarize/image-prompt) must stay
    // lower or it risks an HTTP timeout on a very long response.
    max_tokens: onChunk ? 128000 : 32000,
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
      idempotencyKey,
      onChunk,
      controller.signal,
      onRetry,
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
  // Stable per-logical-request key. Applied ONLY to the FIRST iteration so a
  // whole-request 再生成 dedupes at least that opening call; later iterations
  // grow the message list (different content) and always charge as real calls.
  idempotencyKey?: string,
  // Fired before each automatic pre-output retry so the UI can show a hint.
  onRetry?: (attempt: number) => void,
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
        // Full 128K output ceiling — tool-loop answers (esp. the final
        // synthesized reply) never get cut off. Always streamed, so 128K is
        // safe. It's a cap, not a charge; opus-5 thinking also draws from it.
        max_tokens: 128000,
        // Stream every iteration so ordinary chat (and the final answer after a
        // tool call) shows live text. The SSE assembler in callClaudeApi still
        // reconstructs the full content-block list so tool_use is detectable.
        stream: true,
      };
      if (toolsList && !isLastChance) body.tools = toolsList;

      const streamed = (await callClaudeApi(
        idToken,
        body,
        // Only the opening call carries the key (see signature note above).
        i === 0 ? idempotencyKey : undefined,
        (text) => onChunk?.(text),
        controller.signal,
        onRetry,
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
