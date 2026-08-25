/**
 * Generate a self-contained HTML page from markdown content,
 * with the current preview theme styles and a HackMD-style TOC sidebar.
 */

import { marked } from "marked";
import hljs from "highlight.js";
import DOMPurify from "dompurify";
import { previewThemes, type PreviewTheme } from "@/styles/preview-themes";
import { buildThemeVarLines } from "@/lib/theme-css";

interface PublishOptions {
  title: string;
  content: string; // raw markdown
  themeId: string;
  isDark: boolean;
  customPreviewThemes?: PreviewTheme[];
  customPreviewCss?: string;
}

/** Extract headings from markdown for TOC generation */
function extractHeadings(
  html: string,
): { level: number; text: string; id: string }[] {
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

/** Build theme CSS variables string (sanitized — themes may be untrusted imports) */
function buildThemeVars(theme: PreviewTheme, isDark: boolean): string {
  const vars = { ...theme.variables };
  if (isDark && theme.dark) Object.assign(vars, theme.dark);
  return buildThemeVarLines(vars);
}

/** Generate TOC HTML from headings */
function buildTocHtml(
  headings: { level: number; text: string; id: string }[],
): string {
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
  const {
    title,
    content,
    themeId,
    isDark,
    customPreviewThemes,
    customPreviewCss,
  } = opts;

  // Configure marked with heading IDs
  const renderer = new marked.Renderer();
  // Dedup identical heading slugs (GitHub-style -1/-2) so TOC anchors don't all
  // resolve to the first heading of a given title. Track the fully-resolved ids
  // (not just base counts): a generated "foo-1" must not collide with an
  // explicit heading whose own slug is already "foo-1".
  const usedIds = new Set<string>();
  renderer.heading = function ({
    text,
    depth,
  }: {
    text: string;
    depth: number;
  }) {
    const base = slugify(text) || "section";
    let id = base;
    let n = 1;
    while (usedIds.has(id)) {
      id = `${base}-${n}`;
      n++;
    }
    usedIds.add(id);
    return `<h${depth} id="${id}">${text}</h${depth}>`;
  };
  renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
    if (lang === "mermaid") {
      const safe = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<div class="mermaid">${safe}</div>`;
    }
    const highlighted =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang }).value
        : hljs.highlightAuto(text).value;
    return `<pre><code class="hljs${lang ? ` language-${lang}` : ""}">${highlighted}</code></pre>`;
  };

  // Wrap tables in a horizontal-scroll container. Without this, wide/multi-column
  // tables were squeezed into the fixed content width (table-layout: fixed +
  // width: 100%), collapsing columns to unreadable slivers. The wrapper lets the
  // table size to its content and scroll sideways when it overflows.
  const defaultTable = renderer.table.bind(renderer);
  renderer.table = (token) =>
    `<div class="table-wrap">${defaultTable(token)}</div>`;

  marked.setOptions({ gfm: true, breaks: true });
  // marked (v17) does NOT sanitize HTML — raw <script>/<img onerror=…> in the
  // markdown would become stored XSS on the published page. Sanitize the body
  // while preserving heading ids (the TOC anchors depend on them) and the
  // mermaid/hljs class hooks used by the runtime scripts and styles.
  const rawBody = marked.parse(content, { renderer }) as string;
  const bodyHtml = DOMPurify.sanitize(rawBody, {
    ADD_ATTR: ["target", "id", "class"],
  })
    // Body content (raw HTML embedded in the document) may carry ids that
    // collide with the runtime TOC controls emitted after it (toc-fab /
    // toc-mobile / toc-backdrop). getElementById returns the FIRST match in
    // tree order, so a body element appearing before the real control would
    // shadow it and silently break the mobile TOC FAB. Strip only these
    // reserved control ids from body content — heading anchor ids (referenced
    // by TOC item clicks) are outside this set and stay intact. DOMPurify
    // serializes via the DOM, so ids are always double-quoted here.
    .replace(/\bid="(?:toc-fab|toc-mobile|toc-backdrop)"/g, "");

  // Extract headings for TOC
  const headings = extractHeadings(bodyHtml);
  const tocHtml = buildTocHtml(headings);
  const hasToc = headings.length > 0;

  // Mobile floating TOC: a bottom-right FAB that expands a tappable outline.
  const tocMobileHtml = hasToc
    ? `<button class="toc-fab" id="toc-fab" aria-label="目次" aria-expanded="false">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
  </button>
  <div class="toc-backdrop" id="toc-backdrop"></div>
  <nav class="toc-mobile" id="toc-mobile">
    <div class="toc-title">Table of Contents</div>
    ${headings
      .map(
        (h) =>
          `<a href="#${h.id}" class="toc-item toc-h${h.level}" data-target="${h.id}">${h.text}</a>`,
      )
      .join("\n    ")}
  </nav>`
    : "";

  // Resolve theme
  const preset =
    previewThemes[themeId] ??
    customPreviewThemes?.find((t) => t.id === themeId) ??
    previewThemes.github;
  const themeVarsLight = buildThemeVars(preset, false);
  const themeVarsDark = buildThemeVars(preset, true);

  const escTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="ja" class="${isDark ? "dark" : ""}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escTitle}</title>
<meta property="og:title" content="${escTitle}">
<meta property="og:type" content="article">
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  themeVariables: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", sans-serif', fontSize: '14px' },
  flowchart: { htmlLabels: false, padding: 15, useMaxWidth: true },
  sequence: { useMaxWidth: true },
});

function fixMermaidSvg(el, dark) {
  var svg = el.querySelector('svg');
  if (!svg) return;
  var modified = false;
  var SKIP = ['actor','note','activation0','activation1','activation2'];
  var allRects = Array.from(svg.querySelectorAll('rect'));

  allRects.filter(function(r){ return r.classList.contains('note'); }).forEach(function(noteRect){
    var g = noteRect.parentElement;
    if (!g) return;
    var textEls = g.querySelectorAll('text');
    if (textEls.length === 0) return;
    var rx = parseFloat(noteRect.getAttribute('x') || '0');
    var rw = parseFloat(noteRect.getAttribute('width') || '0');
    var minTx = Infinity, maxTr = -Infinity;
    Array.from(textEls).forEach(function(t){
      try { var bb = t.getBBox(); if (bb.width > 0) { minTx = Math.min(minTx, bb.x); maxTr = Math.max(maxTr, bb.x + bb.width); } } catch(e) {}
    });
    if (maxTr === -Infinity) return;
    var pad = 18;
    var newX = Math.min(rx, minTx - pad);
    var newRight = Math.max(rx + rw, maxTr + pad);
    if (newRight - newX > rw + 1) {
      noteRect.setAttribute('x', String(newX));
      noteRect.setAttribute('width', String(newRight - newX));
      modified = true;
    }
  });

  var sectionRects = allRects.filter(function(r){
    for (var i = 0; i < SKIP.length; i++) if (r.classList.contains(SKIP[i])) return false;
    return /^rgba?\\s*\\(/i.test(r.getAttribute('fill') || '');
  });

  if (sectionRects.length >= 2) {
    var minX = Infinity, maxR = 0;
    sectionRects.forEach(function(r){
      var x = parseFloat(r.getAttribute('x') || '0');
      var w = parseFloat(r.getAttribute('width') || '0');
      minX = Math.min(minX, x);
      maxR = Math.max(maxR, x + w);
    });
    sectionRects.forEach(function(r){
      r.setAttribute('x', String(minX));
      r.setAttribute('width', String(maxR - minX));
    });
    modified = true;
  }

  if (dark) {
    var mainBg = null, maxArea = 0;
    allRects.forEach(function(r){
      if (sectionRects.indexOf(r) >= 0) return;
      var a = parseFloat(r.getAttribute('width') || '0') * parseFloat(r.getAttribute('height') || '0');
      if (a > maxArea) { maxArea = a; mainBg = r; }
    });
    if (mainBg) { mainBg.setAttribute('fill', 'transparent'); modified = true; }
    sectionRects.forEach(function(r){
      var fill = r.getAttribute('fill') || '';
      var m = fill.match(/rgba?\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
      if (m) r.setAttribute('fill', 'rgba(' + Math.round(Number(m[1])*0.25) + ',' + Math.round(Number(m[2])*0.25) + ',' + Math.round(Number(m[3])*0.25) + ',0.6)');
      var stroke = r.getAttribute('stroke') || '';
      var sm = stroke.match(/rgba?\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
      if (sm) r.setAttribute('stroke', 'rgba(' + Math.round(Number(sm[1])*0.35) + ',' + Math.round(Number(sm[2])*0.35) + ',' + Math.round(Number(sm[3])*0.35) + ',0.5)');
    });
  }

  if (modified) {
    try {
      var bbox = svg.getBBox();
      if (bbox.width > 10 && bbox.height > 10) {
        var p = 8;
        svg.setAttribute('viewBox', (bbox.x-p)+' '+(bbox.y-p)+' '+(bbox.width+p*2)+' '+(bbox.height+p*2));
        svg.style.maxWidth = (bbox.width+p*2)+'px';
      }
    } catch(e) {}
  }
}

document.querySelectorAll('.mermaid').forEach(function(el){
  el.setAttribute('data-source', el.textContent || '');
});

async function renderAllMermaid() {
  var dark = document.documentElement.classList.contains('dark');
  var divs = document.querySelectorAll('.mermaid');
  for (var i = 0; i < divs.length; i++) {
    var el = divs[i];
    var source = el.getAttribute('data-source');
    if (!source) continue;
    try {
      var result = await mermaid.render('mermaid-' + Date.now() + '-' + i, source);
      el.innerHTML = result.svg;
      if (result.bindFunctions) result.bindFunctions(el);
      fixMermaidSvg(el, dark);
    } catch(e) { el.textContent = String(e); }
  }
}

await renderAllMermaid();

var toggleBtn = document.querySelector('.theme-toggle');
if (toggleBtn) {
  toggleBtn.addEventListener('click', function(){
    setTimeout(function(){ renderAllMermaid(); }, 50);
  });
}
</script>
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
  font-size: 0.65rem;
  color: var(--muted-foreground);
  opacity: 0.6;
  letter-spacing: 0.02em;
}

/* TOC sidebar — left, modern, no scrollbar */
.toc-sidebar {
  position: sticky;
  top: 60px;
  width: 200px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
  padding: 1.5em 1.5em 1.5em 0;
  flex-shrink: 0;
  margin-left: 2em;
  scrollbar-width: none; /* Firefox */
  -ms-overflow-style: none;
}
.toc-sidebar::-webkit-scrollbar { display: none; }
.toc-title {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted-foreground);
  margin-bottom: 1em;
  opacity: 0.7;
}
.toc-item {
  display: block;
  font-size: 0.76rem;
  line-height: 1.4;
  padding: 4px 0 4px 12px;
  margin-bottom: 1px;
  color: var(--muted-foreground);
  text-decoration: none;
  border-left: 2px solid transparent;
  transition: color 0.2s, border-color 0.2s;
}
.toc-item:hover { color: var(--prose-body); border-left-color: oklch(0.5 0 0 / 0.2); }
.toc-item.active {
  color: var(--prose-links);
  border-left-color: var(--prose-links);
  font-weight: 500;
}
.toc-h2 { padding-left: 20px; }
.toc-h3 { padding-left: 28px; font-size: 0.72rem; }
.toc-h4 { padding-left: 36px; font-size: 0.7rem; opacity: 0.8; }

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
.prose .table-wrap { overflow-x: auto; margin: 1em 0; max-width: 100%; -webkit-overflow-scrolling: touch; }
.prose table { width: auto; min-width: 100%; border-collapse: collapse; margin: 0; table-layout: auto; }
.prose th { border-bottom: 2px solid var(--border); padding: 0.6em 0.75em; text-align: left; font-weight: 600; background: oklch(0 0 0 / 0.02); overflow-wrap: break-word; }
html.dark .prose th { background: oklch(1 1 1 / 0.03); }
.prose td { border-bottom: 1px solid var(--border); padding: 0.5em 0.75em; overflow-wrap: break-word; }

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

/* Mermaid diagram styles */
.prose .mermaid { margin: 1.5em 0; min-height: 40px; background: rgba(0,0,0,0.02); border-radius: 0.375rem; padding: 1em 0; }
html.dark .prose .mermaid { background: #161b22; }
.prose .mermaid svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
.prose .mermaid .actor { stroke-width: 1.5px; }
.prose .mermaid .note { stroke-width: 1px; }
.prose .mermaid rect.note { rx: 4px; ry: 4px; }
.prose .mermaid .actor-line { stroke-dasharray: 4, 4; }
.prose .mermaid .activation0, .prose .mermaid .activation1, .prose .mermaid .activation2 { rx: 3px; ry: 3px; }
html.dark .prose .mermaid svg text, html.dark .prose .mermaid svg tspan { fill: #c9d1d9 !important; }
html.dark .prose .mermaid svg .actor { fill: #21262d !important; stroke: #8b949e !important; }
html.dark .prose .mermaid svg text.actor > tspan { fill: #e6edf3 !important; }
html.dark .prose .mermaid svg rect.note { fill: #1c2128 !important; stroke: #8b949e !important; }
html.dark .prose .mermaid svg .noteText, html.dark .prose .mermaid svg .noteText > tspan { fill: #e6edf3 !important; }
html.dark .prose .mermaid svg .actor-line { stroke: #484f58 !important; }
html.dark .prose .mermaid svg .messageLine0, html.dark .prose .mermaid svg .messageLine1 { stroke: #8b949e !important; }
html.dark .prose .mermaid svg .messageText { fill: #c9d1d9 !important; }
html.dark .prose .mermaid svg .loopLine { stroke: #8b949e !important; }
html.dark .prose .mermaid svg .labelBox { fill: #21262d !important; stroke: #8b949e !important; }
html.dark .prose .mermaid svg .labelText, html.dark .prose .mermaid svg .labelText > tspan { fill: #e6edf3 !important; }
html.dark .prose .mermaid svg .loopText, html.dark .prose .mermaid svg .loopText > tspan { fill: #c9d1d9 !important; }
html.dark .prose .mermaid svg .activation0, html.dark .prose .mermaid svg .activation1, html.dark .prose .mermaid svg .activation2 { fill: #30363d !important; stroke: #8b949e !important; }
html.dark .prose .mermaid svg .sequenceNumber { fill: #e6edf3 !important; }
html.dark .prose .mermaid svg marker path { fill: #8b949e !important; stroke: #8b949e !important; }
html.dark .prose .mermaid svg .node rect, html.dark .prose .mermaid svg .node circle, html.dark .prose .mermaid svg .node polygon { fill: #21262d !important; stroke: #8b949e !important; }
html.dark .prose .mermaid svg .node .label { fill: #e6edf3 !important; }
html.dark .prose .mermaid svg .edgePath .path { stroke: #8b949e !important; }
html.dark .prose .mermaid svg .edgeLabel { background-color: #161b22 !important; color: #c9d1d9 !important; }
html.dark .prose .mermaid svg .cluster rect { fill: #161b22 !important; stroke: #30363d !important; }
html.dark .prose .mermaid svg .cluster text { fill: #c9d1d9 !important; }

/* Task list checkboxes */
.prose input[type="checkbox"] { margin-right: 0.4em; }

/* Mobile floating TOC (hidden on desktop) */
.toc-fab {
  display: none;
  position: fixed;
  right: 16px;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--prose-headings);
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 200;
  box-shadow: 0 4px 16px oklch(0 0 0 / 0.18);
}
.toc-fab svg { width: 22px; height: 22px; }
.toc-mobile {
  display: none;
  position: fixed;
  right: 16px;
  bottom: calc(76px + env(safe-area-inset-bottom, 0px));
  max-height: 60vh;
  width: min(78vw, 320px);
  overflow-y: auto;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 8px;
  z-index: 200;
  box-shadow: 0 8px 28px oklch(0 0 0 / 0.22);
  -webkit-overflow-scrolling: touch;
}
.toc-mobile.open { display: block; }
.toc-mobile .toc-title { padding: 0 8px; margin-bottom: 0.75em; }
.toc-mobile .toc-item { padding: 8px 10px; font-size: 0.85rem; border-left: none; border-radius: 6px; }
.toc-mobile .toc-item:hover, .toc-mobile .toc-item.active { background: oklch(0.5 0 0 / 0.08); color: var(--prose-links); }
.toc-backdrop {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 199;
  background: transparent;
}
.toc-backdrop.open { display: block; }

/* Responsive */
@media (max-width: 900px) {
  .toc-sidebar { display: none; }
  .main-content { padding: 1.25em 1em 4em; }
  .page-header { padding: 0.6em 1em; }
  .branding { display: none; }
  .prose h1 { font-size: 1.45em; padding-bottom: 0.25em; margin-top: 1em; }
  .toc-fab { display: flex; }
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
      <span class="branding">Published with MarkFlow</span>
    </div>
  </header>
  <div class="page-wrapper">
    ${hasToc ? tocHtml : ""}
    <article class="main-content prose">
${bodyHtml}
    </article>
  </div>
  ${hasToc ? tocMobileHtml : ""}
  ${
    hasToc
      ? `<script>
(function() {
  // Mobile TOC toggle (FAB → panel; close on backdrop or item tap)
  var fab = document.getElementById('toc-fab');
  var panel = document.getElementById('toc-mobile');
  var backdrop = document.getElementById('toc-backdrop');
  function closeToc() {
    if (!panel) return;
    panel.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    if (fab) fab.setAttribute('aria-expanded', 'false');
  }
  if (fab && panel) {
    fab.addEventListener('click', function() {
      var open = panel.classList.toggle('open');
      if (backdrop) backdrop.classList.toggle('open', open);
      fab.setAttribute('aria-expanded', String(open));
    });
    panel.addEventListener('click', function(e) {
      if (e.target && e.target.closest('.toc-item')) closeToc();
    });
    if (backdrop) backdrop.addEventListener('click', closeToc);
  }

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
</script>`
      : ""
  }
</body>
</html>`;
}
