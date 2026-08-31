import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Extension } from "@codemirror/state";

/** Shared base styles for all editor themes */
const baseStyles = {
  "&": {
    fontSize: "15px",
    fontFamily:
      '"SF Mono", "Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
  },
  ".cm-content": {
    padding: "2rem 3rem",
    minHeight: "calc(100vh - 8rem)",
  },
  ".cm-gutters": {
    background: "transparent",
    border: "none",
  },
  ".cm-activeLineGutter": {
    background: "transparent",
  },
  ".cm-strong": { fontWeight: "700" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-strikethrough": { textDecoration: "line-through" },
  ".cm-monospace": {
    fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
  },
};

// ─── Default ────────────────────────────────────────────────
const defaultLight = EditorView.theme(
  {
    ...baseStyles,
    ".cm-content": {
      ...baseStyles[".cm-content"],
      caretColor: "oklch(0.3 0 0)",
    },
    ".cm-gutters": { ...baseStyles[".cm-gutters"], color: "oklch(0.7 0 0)" },
    ".cm-activeLine": { background: "oklch(0 0 0 / 0.03)" },
    ".cm-selectionBackground": {
      background: "oklch(0.7 0.15 250 / 0.25) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.7 0.15 250 / 0.3) !important",
    },
    ".cm-cursor": { borderLeftColor: "oklch(0.3 0 0)", borderLeftWidth: "2px" },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.3 0.05 250)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.35 0.04 250)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.4 0.03 250)",
    },
    ".cm-link": { color: "oklch(0.5 0.2 250)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.55 0.12 250)" },
    ".cm-formatting": { color: "oklch(0.65 0 0)" },
    ".cm-quote": { color: "oklch(0.45 0.08 160)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.95 0 0)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: false },
);

const defaultDarkOverride = EditorView.theme(
  {
    ...baseStyles,
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.85 0.08 250)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.8 0.06 250)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.75 0.04 250)",
    },
    ".cm-link": { color: "oklch(0.75 0.15 250)" },
    ".cm-url": { color: "oklch(0.65 0.1 250)" },
    ".cm-formatting": { color: "oklch(0.5 0 0)" },
    ".cm-quote": { color: "oklch(0.65 0.06 160)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.25 0 0)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: true },
);

// ─── Dracula ────────────────────────────────────────────────
const draculaLight = EditorView.theme(
  {
    ...baseStyles,
    "&": { ...baseStyles["&"], background: "oklch(0.99 0 0)" },
    ".cm-content": {
      ...baseStyles[".cm-content"],
      caretColor: "oklch(0.55 0.22 300)",
    },
    ".cm-gutters": { ...baseStyles[".cm-gutters"], color: "oklch(0.6 0 0)" },
    ".cm-activeLine": { background: "oklch(0.85 0.04 300 / 0.08)" },
    ".cm-selectionBackground": {
      background: "oklch(0.8 0.1 300 / 0.2) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.8 0.1 300 / 0.3) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "oklch(0.55 0.22 300)",
      borderLeftWidth: "2px",
    },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.48 0.14 300)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.52 0.13 300)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.56 0.12 300)",
    },
    ".cm-link": { color: "oklch(0.52 0.16 270)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.55 0.15 200)" },
    ".cm-formatting": { color: "oklch(0.6 0.08 300)" },
    ".cm-quote": { color: "oklch(0.5 0.12 145)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.94 0.02 300)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: false },
);

const draculaDark = EditorView.theme(
  {
    ...baseStyles,
    "&": { ...baseStyles["&"], background: "oklch(0.18 0.01 280)" },
    ".cm-content": {
      ...baseStyles[".cm-content"],
      caretColor: "oklch(0.9 0 0)",
    },
    ".cm-gutters": {
      ...baseStyles[".cm-gutters"],
      color: "oklch(0.45 0 0)",
      background: "oklch(0.18 0.01 280)",
    },
    ".cm-activeLine": { background: "oklch(0.22 0.01 280)" },
    ".cm-selectionBackground": {
      background: "oklch(0.35 0.04 280) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.4 0.05 280) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "oklch(0.95 0.15 100)",
      borderLeftWidth: "2px",
    },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.82 0.14 300)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.79 0.13 300)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.76 0.12 300)",
    },
    ".cm-link": { color: "oklch(0.72 0.16 270)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.68 0.12 200)" },
    ".cm-formatting": { color: "oklch(0.5 0.06 280)" },
    ".cm-quote": { color: "oklch(0.72 0.16 145)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.25 0.02 280)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: true },
);

// ─── Solarized ──────────────────────────────────────────────
const solarizedLight = EditorView.theme(
  {
    ...baseStyles,
    "&": { ...baseStyles["&"], background: "oklch(0.97 0.01 85)" },
    ".cm-content": {
      ...baseStyles[".cm-content"],
      caretColor: "oklch(0.4 0.1 230)",
    },
    ".cm-gutters": {
      ...baseStyles[".cm-gutters"],
      color: "oklch(0.6 0.05 85)",
      background: "oklch(0.95 0.01 85)",
    },
    ".cm-activeLine": { background: "oklch(0.93 0.02 85)" },
    ".cm-selectionBackground": { background: "oklch(0.85 0.04 85) !important" },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.82 0.05 85) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "oklch(0.4 0.1 230)",
      borderLeftWidth: "2px",
    },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.48 0.12 200)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.52 0.11 200)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.56 0.1 200)",
    },
    ".cm-link": { color: "oklch(0.53 0.16 250)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.5 0.12 200)" },
    ".cm-formatting": { color: "oklch(0.6 0.06 85)" },
    ".cm-quote": { color: "oklch(0.55 0.12 60)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.93 0.02 85)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: false },
);

const solarizedDark = EditorView.theme(
  {
    ...baseStyles,
    "&": { ...baseStyles["&"], background: "oklch(0.15 0.03 230)" },
    ".cm-content": {
      ...baseStyles[".cm-content"],
      caretColor: "oklch(0.75 0.06 85)",
    },
    ".cm-gutters": {
      ...baseStyles[".cm-gutters"],
      color: "oklch(0.45 0.04 230)",
      background: "oklch(0.15 0.03 230)",
    },
    ".cm-activeLine": { background: "oklch(0.18 0.03 230)" },
    ".cm-selectionBackground": {
      background: "oklch(0.25 0.04 230) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.28 0.05 230) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "oklch(0.75 0.06 85)",
      borderLeftWidth: "2px",
    },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.72 0.12 200)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.7 0.11 200)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.68 0.1 200)",
    },
    ".cm-link": { color: "oklch(0.7 0.15 250)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.65 0.1 200)" },
    ".cm-formatting": { color: "oklch(0.45 0.04 230)" },
    ".cm-quote": { color: "oklch(0.65 0.1 60)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.2 0.03 230)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: true },
);

// ─── Nord ───────────────────────────────────────────────────
const nordLight = EditorView.theme(
  {
    ...baseStyles,
    "&": { ...baseStyles["&"], background: "oklch(0.97 0.01 250)" },
    ".cm-content": {
      ...baseStyles[".cm-content"],
      caretColor: "oklch(0.5 0.1 230)",
    },
    ".cm-gutters": {
      ...baseStyles[".cm-gutters"],
      color: "oklch(0.6 0.03 250)",
      background: "oklch(0.95 0.01 250)",
    },
    ".cm-activeLine": { background: "oklch(0.92 0.02 250)" },
    ".cm-selectionBackground": {
      background: "oklch(0.82 0.05 220) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.78 0.06 220) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "oklch(0.5 0.1 230)",
      borderLeftWidth: "2px",
    },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.5 0.1 230)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.53 0.09 230)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.55 0.08 230)",
    },
    ".cm-link": { color: "oklch(0.55 0.12 220)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.55 0.09 200)" },
    ".cm-formatting": { color: "oklch(0.62 0.04 250)" },
    ".cm-quote": { color: "oklch(0.52 0.1 160)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.92 0.02 250)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: false },
);

const nordDark = EditorView.theme(
  {
    ...baseStyles,
    "&": { ...baseStyles["&"], background: "oklch(0.28 0.02 260)" },
    ".cm-content": {
      ...baseStyles[".cm-content"],
      caretColor: "oklch(0.85 0.06 220)",
    },
    ".cm-gutters": {
      ...baseStyles[".cm-gutters"],
      color: "oklch(0.55 0.03 260)",
      background: "oklch(0.28 0.02 260)",
    },
    ".cm-activeLine": { background: "oklch(0.32 0.02 260)" },
    ".cm-selectionBackground": {
      background: "oklch(0.42 0.04 250) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.46 0.05 250) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "oklch(0.85 0.06 220)",
      borderLeftWidth: "2px",
    },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.82 0.09 210)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.8 0.08 210)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.78 0.07 210)",
    },
    ".cm-link": { color: "oklch(0.8 0.1 210)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.78 0.08 190)" },
    ".cm-formatting": { color: "oklch(0.55 0.03 260)" },
    ".cm-quote": { color: "oklch(0.8 0.1 155)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.34 0.02 260)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: true },
);

// ─── Tokyo Night ────────────────────────────────────────────
const tokyoNightLight = EditorView.theme(
  {
    ...baseStyles,
    "&": { ...baseStyles["&"], background: "oklch(0.97 0.01 265)" },
    ".cm-content": {
      ...baseStyles[".cm-content"],
      caretColor: "oklch(0.5 0.15 265)",
    },
    ".cm-gutters": {
      ...baseStyles[".cm-gutters"],
      color: "oklch(0.6 0.05 265)",
      background: "oklch(0.95 0.01 265)",
    },
    ".cm-activeLine": { background: "oklch(0.93 0.02 265)" },
    ".cm-selectionBackground": {
      background: "oklch(0.85 0.05 265) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.82 0.06 265) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "oklch(0.5 0.15 265)",
      borderLeftWidth: "2px",
    },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.5 0.14 265)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.53 0.13 265)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.55 0.12 265)",
    },
    ".cm-link": { color: "oklch(0.55 0.16 240)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.55 0.11 200)" },
    ".cm-formatting": { color: "oklch(0.62 0.06 265)" },
    ".cm-quote": { color: "oklch(0.55 0.13 160)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.93 0.02 265)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: false },
);

const tokyoNightDark = EditorView.theme(
  {
    ...baseStyles,
    "&": { ...baseStyles["&"], background: "oklch(0.2 0.03 265)" },
    ".cm-content": {
      ...baseStyles[".cm-content"],
      caretColor: "oklch(0.85 0.1 240)",
    },
    ".cm-gutters": {
      ...baseStyles[".cm-gutters"],
      color: "oklch(0.5 0.04 265)",
      background: "oklch(0.2 0.03 265)",
    },
    ".cm-activeLine": { background: "oklch(0.24 0.03 265)" },
    ".cm-selectionBackground": {
      background: "oklch(0.35 0.05 265) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.39 0.06 265) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "oklch(0.85 0.1 240)",
      borderLeftWidth: "2px",
    },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.78 0.14 265)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.76 0.13 265)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.74 0.12 265)",
    },
    ".cm-link": { color: "oklch(0.78 0.13 240)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.75 0.1 200)" },
    ".cm-formatting": { color: "oklch(0.5 0.04 265)" },
    ".cm-quote": { color: "oklch(0.78 0.12 160)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.26 0.03 265)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: true },
);

// ─── Gruvbox ────────────────────────────────────────────────
const gruvboxLight = EditorView.theme(
  {
    ...baseStyles,
    "&": { ...baseStyles["&"], background: "oklch(0.96 0.03 90)" },
    ".cm-content": {
      ...baseStyles[".cm-content"],
      caretColor: "oklch(0.45 0.13 40)",
    },
    ".cm-gutters": {
      ...baseStyles[".cm-gutters"],
      color: "oklch(0.6 0.06 90)",
      background: "oklch(0.94 0.03 90)",
    },
    ".cm-activeLine": { background: "oklch(0.92 0.04 90)" },
    ".cm-selectionBackground": { background: "oklch(0.85 0.06 90) !important" },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.82 0.07 90) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "oklch(0.45 0.13 40)",
      borderLeftWidth: "2px",
    },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.5 0.13 55)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.53 0.12 55)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.56 0.11 55)",
    },
    ".cm-link": { color: "oklch(0.5 0.14 250)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.52 0.1 200)" },
    ".cm-formatting": { color: "oklch(0.62 0.06 90)" },
    ".cm-quote": { color: "oklch(0.52 0.13 130)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.92 0.04 90)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: false },
);

const gruvboxDark = EditorView.theme(
  {
    ...baseStyles,
    "&": { ...baseStyles["&"], background: "oklch(0.25 0.02 80)" },
    ".cm-content": {
      ...baseStyles[".cm-content"],
      caretColor: "oklch(0.85 0.08 90)",
    },
    ".cm-gutters": {
      ...baseStyles[".cm-gutters"],
      color: "oklch(0.55 0.04 80)",
      background: "oklch(0.25 0.02 80)",
    },
    ".cm-activeLine": { background: "oklch(0.29 0.02 80)" },
    ".cm-selectionBackground": { background: "oklch(0.4 0.03 80) !important" },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.44 0.04 80) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "oklch(0.85 0.08 90)",
      borderLeftWidth: "2px",
    },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.82 0.13 55)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.79 0.12 55)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.76 0.11 55)",
    },
    ".cm-link": { color: "oklch(0.78 0.1 230)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.75 0.09 200)" },
    ".cm-formatting": { color: "oklch(0.55 0.04 80)" },
    ".cm-quote": { color: "oklch(0.8 0.12 130)", fontStyle: "italic" },
    ".cm-inline-code": {
      background: "oklch(0.3 0.02 80)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: true },
);

// ─── Exports ────────────────────────────────────────────────
export interface EditorThemePreset {
  id: string;
  name: string;
  light: Extension[];
  dark: Extension[];
}

export const editorThemes: Record<string, EditorThemePreset> = {
  default: {
    id: "default",
    name: "Default",
    light: [defaultLight],
    dark: [oneDark, defaultDarkOverride],
  },
  dracula: {
    id: "dracula",
    name: "Dracula",
    light: [draculaLight],
    dark: [draculaDark],
  },
  solarized: {
    id: "solarized",
    name: "Solarized",
    light: [solarizedLight],
    dark: [solarizedDark],
  },
  nord: {
    id: "nord",
    name: "Nord",
    light: [nordLight],
    dark: [nordDark],
  },
  "tokyo-night": {
    id: "tokyo-night",
    name: "Tokyo Night",
    light: [tokyoNightLight],
    dark: [tokyoNightDark],
  },
  gruvbox: {
    id: "gruvbox",
    name: "Gruvbox",
    light: [gruvboxLight],
    dark: [gruvboxDark],
  },
};

export const editorThemeList = Object.values(editorThemes);
