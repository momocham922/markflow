import { describe, it, expect } from "vitest";
import { jsonForScript, generatePublishHtml } from "@/lib/html-publish";

describe("jsonForScript (inline <script> XSS-safe JSON)", () => {
  it("escapes </script> so the HTML tokenizer cannot close the script early", () => {
    const out = jsonForScript({
      color: "rgba(0,0,0,1)</script><script>alert(1)</script>",
    });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain("/");
    // Still valid JSON that round-trips to the original value.
    expect(JSON.parse(out).color).toBe(
      "rgba(0,0,0,1)</script><script>alert(1)</script>",
    );
  });

  it("escapes U+2028 / U+2029 line separators", () => {
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);
    const raw = `x${LS}y${PS}z`;
    const out = jsonForScript({ a: raw });
    expect(out).not.toContain(LS);
    expect(out).not.toContain(PS);
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(JSON.parse(out).a).toBe(raw);
  });
});

describe("generatePublishHtml never leaks a closing script tag from theme colors", () => {
  it("keeps the inline module script intact even with a hostile custom theme", () => {
    const html = generatePublishHtml({
      title: "Test",
      content: "# Hi\n\n```mermaid\ngraph TD; A-->B;\n```\n",
      themeId: "evil",
      isDark: false,
      customPreviewThemes: [
        {
          id: "evil",
          name: "Evil",
          variables: {
            "--prose-links":
              'rgba(0,0,0,1)</script><script>document.location="//evil"</script>',
          },
        },
      ],
    });
    // The only </script> occurrences must be the ones WE authored, never one
    // injected via a MM_LIGHT/MM_DARK color value.
    expect(html).not.toContain('document.location="//evil"');
    expect(html).not.toContain("</script><script>document");
  });
});
