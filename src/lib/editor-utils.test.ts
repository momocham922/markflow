import { describe, it, expect } from "vitest";
import { isHtmlContent, extractYouTubeId, escapeHtml } from "./editor-utils";

describe("escapeHtml", () => {
  it("escapes all special characters", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
    );
  });

  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("leaves safe text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("isHtmlContent", () => {
  it("detects HTML content", () => {
    expect(isHtmlContent("<p>hello</p>")).toBe(true);
    expect(isHtmlContent("  <div>content</div>")).toBe(true);
    expect(isHtmlContent("<h1>Title</h1>")).toBe(true);
  });

  it("rejects plain markdown", () => {
    expect(isHtmlContent("# Hello")).toBe(false);
    expect(isHtmlContent("Just some text")).toBe(false);
    expect(isHtmlContent("- list item")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isHtmlContent("")).toBe(false);
  });
});

describe("extractYouTubeId", () => {
  it("extracts from standard watch URL", () => {
    expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from short URL", () => {
    expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from embed URL", () => {
    expect(extractYouTubeId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from URL with extra params", () => {
    expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for non-YouTube URLs", () => {
    expect(extractYouTubeId("https://example.com/video")).toBeNull();
    expect(extractYouTubeId("https://vimeo.com/12345")).toBeNull();
  });

  it("returns null for invalid YouTube URLs", () => {
    expect(extractYouTubeId("https://youtube.com/channel/abc")).toBeNull();
  });
});
