import { keymap } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";

/** Wrap selected text with before/after markers, or insert at cursor */
function wrapSelection(view: EditorView, before: string, after: string): boolean {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);

  // If already wrapped, unwrap
  if (
    selected.startsWith(before) &&
    selected.endsWith(after) &&
    selected.length >= before.length + after.length
  ) {
    const inner = selected.slice(before.length, selected.length - after.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
    return true;
  }

  if (from === to) {
    // No selection — insert markers with cursor between them
    view.dispatch({
      changes: { from, insert: before + after },
      selection: { anchor: from + before.length },
    });
  } else {
    view.dispatch({
      changes: { from, to, insert: before + selected + after },
      selection: { anchor: from + before.length, head: from + before.length + selected.length },
    });
  }
  return true;
}

/** Insert prefix at the beginning of the current line */
function linePrefix(view: EditorView, prefix: string): boolean {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const currentText = line.text;

  // Toggle: if line already starts with prefix, remove it
  if (currentText.startsWith(prefix)) {
    view.dispatch({
      changes: { from: line.from, to: line.from + prefix.length, insert: "" },
    });
  } else {
    view.dispatch({
      changes: { from: line.from, insert: prefix },
    });
  }
  return true;
}

const markdownKeybindings: KeyBinding[] = [
  // Inline formatting
  { key: "Mod-b", run: (view) => wrapSelection(view, "**", "**") },
  { key: "Mod-i", run: (view) => wrapSelection(view, "_", "_") },
  { key: "Mod-Shift-x", run: (view) => wrapSelection(view, "~~", "~~") },
  { key: "Mod-e", run: (view) => wrapSelection(view, "`", "`") },
  { key: "Mod-Shift-k", run: (view) => wrapSelection(view, "[[", "]]") },

  // Links
  {
    key: "Mod-k",
    run: (view) => {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      if (from === to) {
        view.dispatch({
          changes: { from, insert: "[](url)" },
          selection: { anchor: from + 1 },
        });
      } else {
        view.dispatch({
          changes: { from, to, insert: `[${selected}](url)` },
          selection: { anchor: from + selected.length + 3, head: from + selected.length + 6 },
        });
      }
      return true;
    },
  },

  // Block formatting
  { key: "Mod-Shift-1", run: (view) => linePrefix(view, "# ") },
  { key: "Mod-Shift-2", run: (view) => linePrefix(view, "## ") },
  { key: "Mod-Shift-3", run: (view) => linePrefix(view, "### ") },
  { key: "Mod-Shift-.", run: (view) => linePrefix(view, "> ") },
  { key: "Mod-Shift-8", run: (view) => linePrefix(view, "- ") },
  { key: "Mod-Shift-7", run: (view) => linePrefix(view, "1. ") },
  { key: "Mod-Shift-c", run: (view) => wrapSelection(view, "```\n", "\n```") },
];

export const markdownShortcuts = keymap.of(markdownKeybindings);
