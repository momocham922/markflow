import { describe, it, expect } from "vitest";
import { normalizeColor, resolveMermaidConfig } from "@/lib/mermaid-theme";
import type { PreviewTheme } from "@/styles/preview-themes";

// NOTE: the vitest environment is jsdom, where <canvas>.getContext("2d")
// returns null. So normalizeColor's canvas normalizer is unavailable here and
// any value that does NOT match the strict fast-path resolves to `fallback`.
// That is exactly the property we want to assert for the security invariant:
// nothing HTML-breaking can survive to the output.

const FB = "#ff00ff"; // sentinel fallback, never a real theme color

describe("normalizeColor fast-path (khroma-safe, HTML-inert only)", () => {
  it("passes through valid hex of length 3/4/6/8", () => {
    expect(normalizeColor("#abc", FB)).toBe("#abc");
    expect(normalizeColor("#abcd", FB)).toBe("#abcd");
    expect(normalizeColor("#a1b2c3", FB)).toBe("#a1b2c3");
    expect(normalizeColor("#a1b2c3d4", FB)).toBe("#a1b2c3d4");
  });

  it("rejects malformed 5-/7-digit hex (falls through -> fallback in jsdom)", () => {
    expect(normalizeColor("#12345", FB)).toBe(FB);
    expect(normalizeColor("#1234567", FB)).toBe(FB);
  });

  it("passes through strict comma-form rgb/rgba/hsl/hsla", () => {
    expect(normalizeColor("rgb(1,2,3)", FB)).toBe("rgb(1,2,3)");
    expect(normalizeColor("rgba(1, 2, 3, 0.5)", FB)).toBe("rgba(1, 2, 3, 0.5)");
    expect(normalizeColor("hsl(200, 50%, 40%)", FB)).toBe("hsl(200, 50%, 40%)");
    expect(normalizeColor("hsla(200, 50%, 40%, 0.5)", FB)).toBe(
      "hsla(200, 50%, 40%, 0.5)",
    );
  });

  it("does NOT fast-path CSS Color-4 slash-alpha syntax (khroma can't parse it)", () => {
    // Contains `/`; excluded from the fast path -> fallback in jsdom.
    expect(normalizeColor("rgb(0 0 0 / 50%)", FB)).toBe(FB);
  });

  it("does NOT fast-path oklch / named colors -> fallback in jsdom", () => {
    expect(normalizeColor("oklch(0.96 0 0)", FB)).toBe(FB);
    expect(normalizeColor("red", FB)).toBe(FB);
  });

  it("never returns a string containing < > or / for adversarial input", () => {
    const evil = "rgba(0,0,0,1)</script><script>alert(1)</script>";
    const out = normalizeColor(evil, FB);
    expect(out).toBe(FB); // fast-path rejects (has < > /), canvas null -> fallback
    expect(out).not.toMatch(/[<>/]/);
  });

  it("returns fallback for empty/undefined", () => {
    expect(normalizeColor("", FB)).toBe(FB);
    expect(normalizeColor(undefined, FB)).toBe(FB);
  });
});

describe("resolveMermaidConfig security invariant", () => {
  it("emits theme 'base' and a stable signature", () => {
    const cfg = resolveMermaidConfig("github", false);
    expect(cfg.theme).toBe("base");
    expect(typeof cfg.signature).toBe("string");
    expect(cfg.signature.startsWith("l:github:")).toBe(true);
    expect(
      resolveMermaidConfig("github", true).signature.startsWith("d:"),
    ).toBe(true);
  });

  it("all themeVariables color values are free of < > / (no script breakout)", () => {
    const malicious: PreviewTheme = {
      id: "evil",
      name: "Evil",
      variables: {
        "--prose-links":
          'rgba(0,0,0,1)</script><script>fetch("//evil")</script>',
        "--prose-body": "<img src=x onerror=alert(1)>",
        "--code-bg": "javascript:alert(1)",
        "--code-border": "url(//evil)",
        "--prose-headings": "oklch(0.5 0.1 200)",
      },
    };
    const cfg = resolveMermaidConfig("evil", false, [malicious]);
    for (const v of Object.values(cfg.themeVariables)) {
      if (typeof v === "string") {
        expect(v, `value must be HTML-inert: ${v}`).not.toMatch(/[<>]/);
        // `/` only ever appears inside fontFamily? No — MERMAID_FONT has none.
        expect(v, `value must not contain a slash: ${v}`).not.toMatch(/\//);
      }
    }
  });

  it("built-in preset resolves without HTML-breaking values", () => {
    for (const id of ["github", "nord", "dracula", "tokyo-night"]) {
      for (const dark of [false, true]) {
        const cfg = resolveMermaidConfig(id, dark);
        for (const v of Object.values(cfg.themeVariables)) {
          if (typeof v === "string") expect(v).not.toMatch(/[<>]/);
        }
      }
    }
  });
});
