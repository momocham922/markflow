// Strip extended-thinking blocks from assistant turns before relaying to Vertex.
//
// The streaming client reconstructs assistant content from SSE deltas but drops
// thinking_delta/signature_delta, leaving a malformed `{type:"thinking",
// thinking:""}` block. Echoing that on the next tool-loop turn makes Vertex 400
// ("messages.N.content.0.thinking: each thinking block must contain thinking").
// We cannot rebuild a valid thinking+signature pair, and under opus-5 adaptive
// thinking the "final assistant turn must begin with a thinking block" rule is
// dropped — so dropping them is safe (verified by live probe: stripped→200,
// empty→400, preserved→200). Doing this server-side fixes every client,
// including already-shipped builds.
//
// Pure + side-effect free so it can be unit-tested without booting the server.
export function stripThinkingBlocks(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (
      !msg ||
      typeof msg !== "object" ||
      (msg as { role?: string }).role !== "assistant"
    )
      return msg;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) return msg;
    const filtered = content.filter((block) => {
      const type =
        block && typeof block === "object"
          ? (block as { type?: string }).type
          : undefined;
      return type !== "thinking" && type !== "redacted_thinking";
    });
    // Guard: an assistant turn that was ONLY thinking would become an empty
    // content array, which Vertex also rejects. Keep the original in that case
    // (never happens on the tool-loop path, which always has a tool_use block).
    if (filtered.length === 0) return msg;
    return { ...(msg as object), content: filtered };
  });
}
