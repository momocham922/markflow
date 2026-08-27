import { describe, it, expect } from "vitest";
import { stripThinkingBlocks } from "./thinking";

describe("stripThinkingBlocks", () => {
  it("removes the malformed empty thinking block that causes the Vertex 400", () => {
    // Reproduces the exact bug: the streaming client rebuilds an assistant turn
    // with an empty thinking block + a tool_use block; echoing it 400s.
    const messages = [
      { role: "user", content: "summarize this" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "tool_use", id: "t1", name: "web_search", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }],
      },
    ];
    const out = stripThinkingBlocks(messages) as typeof messages;
    expect(out[1].content).toEqual([
      { type: "tool_use", id: "t1", name: "web_search", input: {} },
    ]);
    // Other turns are untouched.
    expect(out[0]).toBe(messages[0]);
    expect(out[2]).toBe(messages[2]);
  });

  it("strips redacted_thinking too", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "xxx" },
          { type: "text", text: "hello" },
        ],
      },
    ];
    const out = stripThinkingBlocks(messages) as typeof messages;
    expect(out[0].content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("leaves user messages and string content untouched", () => {
    const messages = [
      { role: "user", content: [{ type: "thinking", thinking: "x" }] },
      { role: "assistant", content: "plain string answer" },
    ];
    const out = stripThinkingBlocks(messages) as typeof messages;
    // A "thinking" block inside a USER turn is not ours to touch.
    expect(out[0]).toBe(messages[0]);
    // String content passes through.
    expect(out[1]).toBe(messages[1]);
  });

  it("preserves a valid thinking+signature pair path by only dropping thinking blocks (never text/tool_use)", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "real reasoning", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const out = stripThinkingBlocks(messages) as typeof messages;
    expect(out[0].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("keeps the original turn if stripping would empty it (thinking-only)", () => {
    const messages = [
      { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
    ];
    const out = stripThinkingBlocks(messages) as typeof messages;
    // Empty content arrays are also invalid for Vertex — keep original rather
    // than emit []. (Doesn't occur on the tool-loop path.)
    expect(out[0]).toBe(messages[0]);
  });

  it("returns non-array input unchanged", () => {
    expect(stripThinkingBlocks(undefined)).toBe(undefined);
    expect(stripThinkingBlocks(null)).toBe(null);
    const obj = { not: "an array" };
    expect(stripThinkingBlocks(obj)).toBe(obj);
  });
});
