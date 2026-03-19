import { keymap } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { insertNewlineContinueMarkup, deleteMarkupBackward } from "@codemirror/lang-markdown";

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

/**
 * Custom Enter handler for list continuation.
 * Uses @codemirror/lang-markdown's insertNewlineContinueMarkup internally,
 * but post-processes to remove extra blank lines that the built-in handler
 * inserts for "non-tight" lists. This ensures pressing Enter always produces
 * a single newline before the next bullet, not two.
 */
function continueListTight(view: EditorView): boolean {
  const before = view.state.doc.toString();
  const result = insertNewlineContinueMarkup(view);
  if (!result) return false;

  // If the built-in handler inserted an extra blank line (non-tight list behavior),
  // remove it. Detect by checking if the change introduced \n\n before a list marker.
  const after = view.state.doc.toString();
  if (after === before) return result;

  const cursor = view.state.selection.main.head;
  const line = view.state.doc.lineAt(cursor);
  const prevLine = line.number > 1 ? view.state.doc.line(line.number - 1) : null;

  // If previous line is empty and current line starts with a list marker,
  // the built-in handler inserted an unwanted blank line — remove it
  if (prevLine && prevLine.text.trim() === "" && /^\s*[-*+]\s|^\s*\d+[.)]\s/.test(line.text)) {
    view.dispatch({
      changes: { from: prevLine.from, to: prevLine.to + 1, insert: "" },
    });
  }

  return result;
}

const markdownKeybindings: KeyBinding[] = [
  // List continuation (Enter) and markup deletion (Backspace)
  { key: "Enter", run: continueListTight },
  { key: "Backspace", run: deleteMarkupBackward },

  // Inline formatting
  { key: "Mod-b", run: (view) => wrapSelection(view, "**", "**") },
  { key: "Mod-i", run: (view) => wrapSelection(view, "_", "_") },
  { key: "Mod-Shift-x", run: (view) => wrapSelection(view, "~~", "~~") },
  { key: "Mod-e", run: (view) => wrapSelection(view, "`", "`") },
  { key: "Mod-Shift-k", run: (view) => wrapSelection(view, "[[", "]]") },

  // Block formatting
  { key: "Mod-Shift-1", run: (view) => linePrefix(view, "# ") },
  { key: "Mod-Shift-2", run: (view) => linePrefix(view, "## ") },
  { key: "Mod-Shift-3", run: (view) => linePrefix(view, "### ") },
  { key: "Mod-Shift-.", run: (view) => linePrefix(view, "> ") },
  { key: "Mod-Shift-8", run: (view) => linePrefix(view, "- ") },
  { key: "Mod-Shift-7", run: (view) => linePrefix(view, "1. ") },
  { key: "Mod-Shift-c", run: (view) => wrapSelection(view, "```\n", "\n```") },
];

// Prec.high() ensures our Enter/Backspace handlers run before basicSetup's
// defaultKeymap (whose insertNewlineAndIndent always returns true and would
// otherwise consume Enter before list continuation can fire).
// This matches @codemirror/lang-markdown's own addKeymap behavior.
export const markdownShortcuts = Prec.high(keymap.of(markdownKeybindings));
