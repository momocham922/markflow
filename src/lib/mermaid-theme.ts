/**
 * Brand-aware Mermaid theming.
 *
 * MarkFlow renders Mermaid diagrams inside the preview pane, which is styled by
 * the *selected preview theme* (GitHub / Nord / Dracula / …) merged with the
 * light/dark mode. Historically all three render sites (Editor preview,
 * SharedDocView, published HTML) hardcoded `theme: "default"` and re-tinted dark
 * mode by hand with a wall of `!important` GitHub-dark hexes. That meant diagrams
 * never followed the chosen theme and light mode was never branded at all.
 *
 * This module is the single source of truth that maps the resolved preview-theme
 * CSS tokens (`--prose-body`, `--prose-links`, `--code-bg`, …) onto Mermaid's
 * `base` theme `themeVariables`, so a diagram's own colors track the app theme in
 * both light and dark. All three render sites import from here.
 *
 * IMPORTANT — color format: Mermaid's `base` theme runs color math via `khroma`,
 * which understands hex / rgb / hsl but NOT `oklch()`. Our theme tokens are all
 * `oklch(...)`, so every value is normalized to a concrete `#rrggbb` / `rgba()`
 * via the browser's canvas color parser before being handed to Mermaid.
 */

import { previewThemes, type PreviewTheme } from "@/styles/preview-themes";

export const MERMAID_FONT =
  'ui-sans-serif, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';

// ---------------------------------------------------------------------------
// Color normalization (oklch/hsl/… -> hex) via a reusable canvas 2D context.
// ---------------------------------------------------------------------------
let _probeCtx: CanvasRenderingContext2D | null | undefined;
function getProbeCtx(): CanvasRenderingContext2D | null {
  if (_probeCtx !== undefined) return _probeCtx;
  try {
    _probeCtx = document
      .createElement("canvas")
      .getContext("2d", { willReadFrequently: true });
  } catch {
    _probeCtx = null;
  }
  return _probeCtx;
}

function toHex2(n: number): string {
  return Math.min(255, Math.max(0, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
}

/**
 * Normalize any CSS color string to a form Mermaid/khroma can parse (#rrggbb or
 * rgba(...)). Returns `fallback` (which MUST already be khroma-safe) when the
 * value is empty, unparseable, or a DOM/canvas is unavailable (e.g. jsdom tests).
 *
 * We resolve the color by painting a pixel and reading back its sRGB bytes via
 * getImageData. This is deliberate: modern Chromium/WebKit accept `oklch()` as a
 * canvas fillStyle and serialize it BACK as `oklch(...)` (not hex), so the old
 * "read fillStyle string" trick no longer converts anything — and khroma cannot
 * parse oklch. Reading actual painted pixels always yields concrete sRGB values.
 */
export function normalizeColor(
  value: string | undefined,
  fallback: string,
): string {
  const v = (value ?? "").trim();
  if (!v) return fallback;
  // Fast path: STRICTLY-valid, khroma-parseable, HTML-inert colors only. The
  // patterns are fully anchored and their character classes exclude `< > /`, so
  // a value returned here can never break out of a `<style>` declaration or an
  // inline `<script>` (published HTML bakes these into both). Anything else —
  // malformed hex (`#12345`), CSS Color-4 slash-alpha (`rgb(0 0 0 / 50%)`),
  // oklch(), named colors — falls through to the canvas normalizer below, which
  // always returns a concrete `#rrggbb` / `rgba(n, n, n, a)` (digits/commas only).
  if (
    /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ||
    /^rgba?\([\d.,\s%]+\)$/i.test(v) ||
    /^hsla?\([\d.,\s%]+\)$/i.test(v)
  ) {
    return v;
  }
  const ctx = getProbeCtx();
  if (!ctx) return fallback;
  try {
    // Paint the color over a known background and read the resulting pixel.
    // Doing it over both black and white lets us (a) detect an unparseable
    // value (fillStyle no-ops → the background shows through unchanged) and
    // (b) recover the source alpha for translucent colors.
    const read = (bg: string): [number, number, number] => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const b = read("#000000");
    const w = read("#ffffff");
    // Unparseable: value never painted, so both backgrounds show through.
    if (
      b[0] === 0 &&
      b[1] === 0 &&
      b[2] === 0 &&
      w[0] === 255 &&
      w[1] === 255 &&
      w[2] === 255
    ) {
      return fallback;
    }
    // Recover alpha from how much each background bleeds through.
    const bleed = (w[0] - b[0] + (w[1] - b[1]) + (w[2] - b[2])) / (3 * 255);
    const alpha = Math.min(1, Math.max(0, 1 - bleed));
    if (alpha >= 0.999) {
      return `#${toHex2(b[0])}${toHex2(b[1])}${toHex2(b[2])}`;
    }
    if (alpha <= 0.001) return fallback; // effectively invisible
    // Un-premultiply the over-black read to recover the source rgb.
    const c = (x: number) => Math.min(255, Math.max(0, Math.round(x / alpha)));
    return `rgba(${c(b[0])}, ${c(b[1])}, ${c(b[2])}, ${alpha.toFixed(3)})`;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * khroma-safe hex fallbacks, used only when a theme omits a token or the value
 * can't be parsed. Mirror the globals.css `:root` / `.dark` neutrals + accent.
 */
const FALLBACK = {
  light: {
    body: "#171717",
    headings: "#0f0f0f",
    links: "#2f68d8",
    codeBg: "#f5f5f5",
    codeBorder: "#e2e2e2",
  },
  dark: {
    body: "#e6e6e6",
    headings: "#f2f2f2",
    links: "#5aa2f0",
    codeBg: "#1e1e1e",
    codeBorder: "#333333",
  },
} as const;

// The preview pane background is the app `--background` (a greyscale surface),
// independent of the selected preview theme. Diagrams float on it.
const PAGE_BG = { light: "#ffffff", dark: "#0a0a0a" } as const;
// Neutral, always-readable edge color (kept theme-agnostic on purpose so links
// stay legible on both white and near-black backgrounds).
const LINE = { light: "#6b7280", dark: "#8b949e" } as const;

interface BrandTokens {
  body: string;
  headings: string;
  accent: string;
  nodeBg: string;
  border: string;
  pageBg: string;
  line: string;
}

function resolvePreset(
  themeId: string,
  customThemes?: readonly PreviewTheme[],
): PreviewTheme | undefined {
  return previewThemes[themeId] ?? customThemes?.find((t) => t.id === themeId);
}

function pickTokens(
  preset: PreviewTheme | undefined,
  isDark: boolean,
): BrandTokens {
  const fb = isDark ? FALLBACK.dark : FALLBACK.light;
  const src: Record<string, string> = preset
    ? { ...preset.variables, ...(isDark && preset.dark ? preset.dark : {}) }
    : {};
  return {
    body: normalizeColor(src["--prose-body"], fb.body),
    headings: normalizeColor(src["--prose-headings"], fb.headings),
    accent: normalizeColor(src["--prose-links"], fb.links),
    nodeBg: normalizeColor(src["--code-bg"], fb.codeBg),
    border: normalizeColor(src["--code-border"], fb.codeBorder),
    pageBg: isDark ? PAGE_BG.dark : PAGE_BG.light,
    line: isDark ? LINE.dark : LINE.light,
  };
}

/**
 * Build the full Mermaid `base` themeVariables object from resolved brand tokens.
 * Node fill = subtle code surface, node border = brand accent, text = body,
 * edges = neutral readable grey. Covers flowchart / sequence / class / state /
 * ER / pie in one coherent palette.
 */
function buildThemeVariables(
  t: BrandTokens,
  isDark: boolean,
): Record<string, string | boolean> {
  return {
    // NOTE: every value here must be a concrete color khroma can parse
    // (hex / rgb / hsl). Mermaid's `base` theme runs color math on some of these
    // (e.g. `background`), so `"transparent"` is avoided — page-bg matches the
    // preview surface, giving a seamless "floating" look without an opaque box.
    darkMode: isDark,
    fontFamily: MERMAID_FONT,
    fontSize: "14px",
    background: t.pageBg,

    // Generic nodes (flowchart / class / state / er)
    primaryColor: t.nodeBg,
    primaryBorderColor: t.accent,
    primaryTextColor: t.body,
    secondaryColor: t.nodeBg,
    secondaryBorderColor: t.border,
    secondaryTextColor: t.body,
    tertiaryColor: t.pageBg,
    tertiaryBorderColor: t.border,
    tertiaryTextColor: t.body,
    mainBkg: t.nodeBg,
    nodeBorder: t.accent,
    nodeTextColor: t.body,
    lineColor: t.line,
    defaultLinkColor: t.line,
    textColor: t.body,
    titleColor: t.headings,
    edgeLabelBackground: t.pageBg,
    clusterBkg: t.pageBg,
    clusterBorder: t.border,
    labelColor: t.body,
    classText: t.body,

    // Sequence
    actorBkg: t.nodeBg,
    actorBorder: t.accent,
    actorTextColor: t.body,
    actorLineColor: t.border,
    signalColor: t.body,
    signalTextColor: t.body,
    labelBoxBkgColor: t.nodeBg,
    labelBoxBorderColor: t.border,
    labelTextColor: t.body,
    loopTextColor: t.body,
    noteBkgColor: t.nodeBg,
    noteBorderColor: t.accent,
    noteTextColor: t.body,
    activationBkgColor: t.nodeBg,
    activationBorderColor: t.border,
    sequenceNumberColor: t.pageBg,

    // Pie
    pieTitleTextColor: t.headings,
    pieSectionTextColor: t.body,
    pieLegendTextColor: t.body,
    pieStrokeColor: t.pageBg,
    pieOuterStrokeColor: t.border,
  };
}

/** Tiny stable hash (djb2) for cache-key signatures. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export interface MermaidConfig {
  theme: "base";
  themeVariables: Record<string, string | boolean>;
  /**
   * Stable signature of (theme id × light/dark × resolved colors). Use it as a
   * render-cache key so diagrams re-render when — and only when — their palette
   * actually changes (theme switch, dark toggle, or a live custom-theme edit).
   */
  signature: string;
}

/**
 * Resolve the Mermaid `base` config for the currently selected preview theme +
 * light/dark mode. Deterministic; safe to call on every render pass.
 */
export function resolveMermaidConfig(
  themeId: string,
  isDark: boolean,
  customThemes?: readonly PreviewTheme[],
): MermaidConfig {
  const preset = resolvePreset(themeId, customThemes);
  const tokens = pickTokens(preset, isDark);
  const themeVariables = buildThemeVariables(tokens, isDark);
  const signature = `${isDark ? "d" : "l"}:${themeId}:${hash(
    JSON.stringify(themeVariables),
  )}`;
  return { theme: "base", themeVariables, signature };
}

/** Full `mermaid.initialize(...)` options for the given theme + mode. */
export function mermaidInitOptions(
  themeId: string,
  isDark: boolean,
  customThemes?: readonly PreviewTheme[],
) {
  const { themeVariables } = resolveMermaidConfig(
    themeId,
    isDark,
    customThemes,
  );
  return {
    startOnLoad: false,
    theme: "base" as const,
    themeVariables,
    flowchart: { htmlLabels: false, padding: 15, useMaxWidth: true },
    sequence: { useMaxWidth: true },
  };
}
