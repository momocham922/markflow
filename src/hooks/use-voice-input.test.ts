import { describe, it, expect } from "vitest";
import { splitLinear16Base64 } from "./use-voice-input";

// Helper: build a base64 LINEAR16 (16-bit PCM mono) buffer of `seconds` at
// `rate` Hz. Byte length = seconds * rate * 2 (2 bytes/sample). Fill with a
// counting pattern so we can assert the concatenated segments reconstruct the
// original exactly (order + content preserved, no dropped/duplicated samples).
function pcmBase64(seconds: number, rate: number): string {
  const bytes = Math.round(seconds * rate * 2);
  let binary = "";
  for (let i = 0; i < bytes; i++) binary += String.fromCharCode(i % 256);
  return btoa(binary);
}

const RATE = 16000;
const MAX_S = 25; // matches CHUNK_MS / 1000

describe("splitLinear16Base64", () => {
  it("returns the input unchanged when within the limit (foreground tick)", () => {
    const b64 = pcmBase64(25, RATE); // exactly at the cap
    expect(splitLinear16Base64(b64, MAX_S, RATE)).toEqual([b64]);

    const shorter = pcmBase64(10, RATE);
    expect(splitLinear16Base64(shorter, MAX_S, RATE)).toEqual([shorter]);
  });

  it("splits an over-length background buffer into ≤maxSeconds segments", () => {
    const b64 = pcmBase64(130, RATE); // ~2min10s accumulated while backgrounded
    const segments = splitLinear16Base64(b64, MAX_S, RATE);
    // 130s / 25s = 5.2 → 6 segments (5 full + remainder)
    expect(segments.length).toBe(6);
  });

  it("keeps every segment within the byte cap (sample-aligned, even bytes)", () => {
    const b64 = pcmBase64(130, RATE);
    const maxBytes = MAX_S * RATE * 2;
    for (const seg of splitLinear16Base64(b64, MAX_S, RATE)) {
      const len = atob(seg).length;
      expect(len).toBeLessThanOrEqual(maxBytes);
      expect(len % 2).toBe(0); // never splits a 16-bit sample
    }
  });

  it("preserves all audio exactly (concatenation === original)", () => {
    const b64 = pcmBase64(77, RATE);
    const segments = splitLinear16Base64(b64, MAX_S, RATE);
    const rejoined = segments.map((s) => atob(s)).join("");
    expect(rejoined).toBe(atob(b64));
  });

  it("returns the input unchanged when it is not valid base64", () => {
    const garbage = "!!!not base64!!!";
    expect(splitLinear16Base64(garbage, MAX_S, RATE)).toEqual([garbage]);
  });
});
