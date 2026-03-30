/**
 * Generate a self-contained HTML page from markdown content,
 * with the current preview theme styles and a HackMD-style TOC sidebar.
 */

import { marked } from "marked";
import hljs from "highlight.js";
import { previewThemes, type PreviewTheme } from "@/styles/preview-themes";

interface PublishOptions {
  title: string;
  content: string; // raw markdown
  themeId: string;
  isDark: boolean;
  customPreviewThemes?: PreviewTheme[];
  customPreviewCss?: string;
}

/** Extract headings from markdown for TOC generation */
function extractHeadings(html: string): { level: number; text: string; id: string }[] {
  const headings: { level: number; text: string; id: string }[] = [];
  const re = /<h([1-4])[^>]*id="([^"]*)"[^>]*>(.*?)<\/h[1-4]>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    headings.push({
      level: parseInt(m[1]),
      text: m[3].replace(/<[^>]+>/g, ""), // strip inner HTML tags
      id: m[2],
    });
  }
  return headings;
}

/** Slugify heading text for anchor IDs */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\u3000-\u9FFF\u4E00-\u9FFF\uF900-\uFAFF]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build theme CSS variables string */
function buildThemeVars(theme: PreviewTheme, isDark: boolean): string {
  const vars = { ...theme.variables };
  if (isDark && theme.dark) Object.assign(vars, theme.dark);
  return Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
}

/** Generate TOC HTML from headings */
function buildTocHtml(headings: { level: number; text: string; id: string }[]): string {
  if (headings.length === 0) return "";
  const items = headings
    .map(
      (h) =>
        `<a href="#${h.id}" class="toc-item toc-h${h.level}" data-target="${h.id}">${h.text}</a>`,
    )
    .join("\n      ");
  return `<nav class="toc-sidebar" id="toc">
      <div class="toc-title">Table of Contents</div>
      ${items}
    </nav>`;
}

export function generatePublishHtml(opts: PublishOptions): string {
  const { title, content, themeId, isDark, customPreviewThemes, customPreviewCss } = opts;

  // Configure marked with heading IDs
  const renderer = new marked.Renderer();
  renderer.heading = function ({ text, depth }: { text: string; depth: number }) {
    const id = slugify(text);
    return `<h${depth} id="${id}">${text}</h${depth}>`;
  };
  renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
    if (lang === "mermaid") {
      return `<div class="mermaid">${text}</div>`;
    }
    const highlighted = lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang }).value
      : hljs.highlightAuto(text).value;
    return `<pre><code class="hljs${lang ? ` language-${lang}` : ""}">${highlighted}</code></pre>`;
  };

  marked.setOptions({ gfm: true, breaks: true });
  const bodyHtml = marked.parse(content, { renderer }) as string;

  // Extract headings for TOC
  const headings = extractHeadings(bodyHtml);
  const tocHtml = buildTocHtml(headings);
  const hasToc = headings.length > 0;

  // Resolve theme
  const preset =
    previewThemes[themeId] ??
    customPreviewThemes?.find((t) => t.id === themeId) ??
    previewThemes.github;
  const themeVarsLight = buildThemeVars(preset, false);
  const themeVarsDark = buildThemeVars(preset, true);

  const escTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="ja" class="${isDark ? "dark" : ""}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escTitle}</title>
<meta property="og:title" content="${escTitle}">
<meta property="og:type" content="article">
<style>
/* Theme variables */
:root {
${themeVarsLight}
  --border: oklch(0.9 0 0);
  --card: #fff;
  --muted-foreground: oklch(0.55 0 0);
  --background: #fff;
}
html.dark {
${themeVarsDark}
  --border: oklch(0.25 0 0);
  --card: oklch(0.15 0 0);
  --muted-foreground: oklch(0.5 0 0);
  --background: oklch(0.1 0 0);
}

/* Reset & base */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; scroll-padding-top: 1em; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", sans-serif;
  background: var(--background);
  color: var(--prose-body);
  transition: background 0.3s, color 0.3s;
}

/* Layout */
.page-wrapper {
  display: flex;
  max-width: 1200px;
  margin: 0 auto;
  min-height: 100vh;
}
.main-content {
  flex: 1;
  min-width: 0;
  max-width: 780px;
  margin: 0 auto;
  padding: 2em 2em 4em;
}

/* Header */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75em 2em;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--background);
  z-index: 100;
}
.page-header h1 {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--prose-headings);
  margin: 0;
  border: none;
  padding: 0;
}
.theme-toggle {
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 0.8rem;
  color: var(--prose-body);
  transition: border-color 0.2s;
}
.theme-toggle:hover { border-color: var(--prose-links); }
.branding {
  font-size: 0.7rem;
  color: var(--muted-foreground);
  text-decoration: none;
}
.branding:hover { color: var(--prose-links); }

/* TOC sidebar */
.toc-sidebar {
  position: sticky;
  top: 60px;
  width: 220px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
  padding: 1.5em 0 1.5em 1em;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  margin-left: 2em;
}
.toc-title {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted-foreground);
  margin-bottom: 0.75em;
  padding-left: 0.5em;
}
.toc-item {
  display: block;
  font-size: 0.78rem;
  line-height: 1.4;
  padding: 3px 0.5em;
  margin-bottom: 2px;
  color: var(--muted-foreground);
  text-decoration: none;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.toc-item:hover { color: var(--prose-links); background: oklch(0.5 0 0 / 0.05); }
.toc-item.active { color: var(--prose-links); font-weight: 600; background: oklch(0.5 0.1 250 / 0.08); }
.toc-h2 { padding-left: 1.2em; }
.toc-h3 { padding-left: 2em; font-size: 0.74rem; }
.toc-h4 { padding-left: 2.8em; font-size: 0.72rem; }

/* Prose styles */
.prose {
  color: var(--prose-body);
  line-height: var(--prose-line-height, 1.75);
  font-size: var(--prose-font-size, 1rem);
  font-family: var(--prose-font, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", sans-serif);
  letter-spacing: var(--prose-letter-spacing, 0);
}
.prose h1 {
  font-size: var(--prose-h1-size, 1.875em);
  font-weight: var(--prose-h1-weight, 700);
  margin-top: var(--prose-h1-mt, 1.5em);
  margin-bottom: var(--prose-h1-mb, 0.5em);
  line-height: 1.2;
  color: var(--prose-headings);
  letter-spacing: var(--prose-h-letter-spacing, -0.02em);
  border-bottom: var(--prose-h1-border-width, 1px) solid var(--prose-h1-border);
  padding-bottom: var(--prose-h1-pb, 0.3em);
  font-family: var(--prose-heading-font, inherit);
  text-transform: var(--prose-h1-transform, none);
}
.prose h2 {
  font-size: var(--prose-h2-size, 1.5em);
  font-weight: var(--prose-h2-weight, 600);
  margin-top: 1.4em; margin-bottom: 0.4em;
  line-height: 1.3;
  color: var(--prose-headings);
  letter-spacing: var(--prose-h-letter-spacing, -0.01em);
  font-family: var(--prose-heading-font, inherit);
}
.prose h3 {
  font-size: var(--prose-h3-size, 1.25em);
  font-weight: var(--prose-h3-weight, 600);
  margin-top: 1.2em; margin-bottom: 0.3em;
  line-height: 1.4;
  color: var(--prose-headings);
  font-family: var(--prose-heading-font, inherit);
}
.prose h4 { font-size: 1.1em; font-weight: 600; margin-top: 0.75em; margin-bottom: 0.25em; color: var(--prose-headings); }
.prose p { margin-top: 0; margin-bottom: var(--prose-p-spacing, 0.75em); line-height: var(--prose-line-height, 1.75); }
.prose blockquote {
  border-left: var(--prose-bq-border-width, 4px) solid var(--prose-blockquote-border);
  padding-left: var(--prose-bq-pl, 1.2em);
  margin-left: 0; margin-top: 0.75em; margin-bottom: 0.75em;
  color: var(--prose-blockquote-fg);
  font-style: var(--prose-bq-style, italic);
  background: var(--prose-blockquote-bg);
  border-radius: var(--prose-bq-radius, 0 0.375em 0.375em 0);
  padding-top: 0.5em; padding-bottom: 0.5em; padding-right: 1em;
  font-size: var(--prose-bq-font-size, inherit);
}
.prose code {
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: var(--prose-code-radius, 0.3em);
  padding: var(--prose-code-padding, 0.15em 0.4em);
  font-size: 0.85em;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", "JetBrains Mono", monospace;
  color: var(--prose-code-fg);
  font-weight: var(--prose-code-weight, 400);
}
.prose pre {
  background: var(--pre-bg);
  color: var(--pre-fg);
  border-radius: var(--prose-pre-radius, 0.5em);
  padding: var(--prose-pre-padding, 1em 1.25em);
  overflow-x: auto;
  margin: 1.25em 0;
  border: var(--prose-pre-border, 1px solid oklch(0.3 0 0 / 0.2));
  font-size: 0.875rem;
  line-height: 1.6;
}
.prose pre code { background: none; border: none; padding: 0; border-radius: 0; font-size: 0.875em; color: inherit; }
.prose ul { list-style-type: var(--prose-ul-marker, disc); padding-left: 1.75em; margin-top: 0.5em; margin-bottom: 0.75em; }
.prose ol { list-style-type: decimal; padding-left: 1.75em; margin-top: 0.5em; margin-bottom: 0.75em; }
.prose li { margin-bottom: 0.35em; line-height: var(--prose-line-height, 1.7); }
.prose li > p { margin-bottom: 0.25em; }
.prose li > ul, .prose li > ol { margin-top: 0.25em; margin-bottom: 0; }
.prose hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
.prose a {
  color: var(--prose-links);
  text-decoration: var(--prose-link-decoration, underline);
  text-underline-offset: 0.2em;
  font-weight: var(--prose-link-weight, inherit);
  transition: color 0.15s;
}
.prose a:hover { color: var(--prose-links-hover); }
.prose strong { font-weight: 700; }
.prose em { font-style: italic; }
.prose img { max-width: 100%; border-radius: 0.5em; margin: 1em 0; box-shadow: 0 2px 8px oklch(0 0 0 / 0.1); }
.prose table { width: 100%; border-collapse: collapse; margin: 1em 0; }
.prose th { border-bottom: 2px solid var(--border); padding: 0.6em 0.75em; text-align: left; font-weight: 600; background: oklch(0 0 0 / 0.02); }
html.dark .prose th { background: oklch(1 1 1 / 0.03); }
.prose td { border-bottom: 1px solid var(--border); padding: 0.5em 0.75em; }

/* Syntax highlighting */
.hljs-comment, .hljs-quote { color: var(--hl-comment); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-addition { color: var(--hl-keyword); }
.hljs-string, .hljs-doctag, .hljs-regexp { color: var(--hl-string); }
.hljs-number, .hljs-literal { color: var(--hl-number); }
.hljs-title, .hljs-section, .hljs-name { color: var(--hl-title); font-weight: 600; }
.hljs-built_in, .hljs-type { color: var(--hl-builtin); }
.hljs-attr, .hljs-variable, .hljs-template-variable { color: var(--hl-attr); }
.hljs-symbol, .hljs-bullet, .hljs-link { color: var(--hl-symbol); }
.hljs-meta { color: var(--hl-meta); }
.hljs-deletion { color: oklch(0.65 0.2 25); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: bold; }

/* Task list checkboxes */
.prose input[type="checkbox"] { margin-right: 0.4em; }

/* Responsive */
@media (max-width: 900px) {
  .toc-sidebar { display: none; }
  .main-content { padding: 1.5em 1em 3em; }
}
@media print {
  .page-header, .toc-sidebar { display: none; }
  .main-content { max-width: 100%; padding: 0; }
}

${customPreviewCss || ""}
</style>
</head>
<body>
  <header class="page-header">
    <h1>${escTitle}</h1>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="theme-toggle" onclick="document.documentElement.classList.toggle('dark')">
        <span class="light-icon">&#9790;</span> / <span class="dark-icon">&#9788;</span>
      </button>
      <a class="branding" href="https://github.com/momocham922/markflow" target="_blank" rel="noopener">Published with MarkFlow</a>
    </div>
  </header>
  <div class="page-wrapper">
    <article class="main-content prose">
${bodyHtml}
    </article>
    ${hasToc ? tocHtml : ""}
  </div>
  ${hasToc ? `<script>
(function() {
  var items = document.querySelectorAll('.toc-item');
  var targets = [];
  items.forEach(function(item) {
    var el = document.getElementById(item.dataset.target);
    if (el) targets.push({ link: item, el: el });
  });
  if (!targets.length) return;
  var current = null;
  function onScroll() {
    var scrollY = window.scrollY + 80;
    var active = targets[0];
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].el.offsetTop <= scrollY) active = targets[i];
    }
    if (current !== active.link) {
      if (current) current.classList.remove('active');
      active.link.classList.add('active');
      current = active.link;
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
</script>` : ""}
</body>
</html>`;
}
