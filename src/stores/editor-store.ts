import { create } from "zustand";
import type { EditorView } from "@codemirror/view";

interface EditorState {
  view: EditorView | null;
  setView: (view: EditorView | null) => void;
  /** For StatusBar backward compat */
  editor: { getText: () => string } | null;
  setEditor: (editor: { getText: () => string } | null) => void;
  getSelectedText: () => string;
  getFullText: () => string;
  insertAtCursor: (text: string) => boolean;
  replaceSelection: (text: string) => boolean;
  appendToDoc: (text: string) => boolean;
}

/** Check that the view is alive and its DOM is still attached */
function isViewAlive(view: EditorView | null): view is EditorView {
  if (!view) return false;
  try {
    // If the view's DOM has been detached, contentDOM won't be in the document
    return document.contains(view.contentDOM);
  } catch {
    return false;
  }
}

export const useEditorStore = create<EditorState>((set, get) => ({
  view: null,
  editor: null,

  setView: (view) => {
    set({ view });
    if (view) {
      set({
        editor: {
          getText: () => view.state.doc.toString(),
        },
      });
    } else {
      set({ editor: null });
    }
  },

  setEditor: (editor) => set({ editor }),

  getSelectedText: () => {
    const { view } = get();
    if (!isViewAlive(view)) return "";
    const { from, to } = view.state.selection.main;
    if (from === to) return "";
    return view.state.sliceDoc(from, to);
  },

  getFullText: () => {
    const { view } = get();
    if (!isViewAlive(view)) return "";
    return view.state.doc.toString();
  },

  insertAtCursor: (text: string) => {
    const { view } = get();
    if (!isViewAlive(view)) return false;
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, insert: text },
    });
    view.focus();
    return true;
  },

  replaceSelection: (text: string) => {
    const { view } = get();
    if (!isViewAlive(view)) return false;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
    });
    view.focus();
    return true;
  },

  appendToDoc: (text: string) => {
    const { view } = get();
    if (!isViewAlive(view)) return false;
    const len = view.state.doc.length;
    view.dispatch({
      changes: { from: len, insert: `\n\n${text}` },
    });
    view.focus();
    return true;
  },
}));
