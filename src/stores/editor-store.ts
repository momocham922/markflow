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
  insertAtCursor: (text: string) => void;
  replaceSelection: (text: string) => void;
  appendToDoc: (text: string) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  view: null,
  editor: null,

  setView: (view) => {
    set({ view });
    // Also set editor shim for StatusBar compatibility
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
    if (!view) return "";
    const { from, to } = view.state.selection.main;
    if (from === to) return "";
    return view.state.sliceDoc(from, to);
  },

  getFullText: () => {
    const { view } = get();
    if (!view) return "";
    return view.state.doc.toString();
  },

  insertAtCursor: (text: string) => {
    const { view } = get();
    if (!view) return;
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, insert: text },
    });
    view.focus();
  },

  replaceSelection: (text: string) => {
    const { view } = get();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
    });
    view.focus();
  },

  appendToDoc: (text: string) => {
    const { view } = get();
    if (!view) return;
    const len = view.state.doc.length;
    view.dispatch({
      changes: { from: len, insert: `\n\n${text}` },
    });
    view.focus();
  },
}));
