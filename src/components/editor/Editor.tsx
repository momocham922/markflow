import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import { common, createLowlight } from "lowlight";
import { useEffect, useCallback, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { EditorToolbar } from "./EditorToolbar";
import {
  getYDoc,
  getProvider,
  disconnectProvider,
  getRandomColor,
} from "@/services/yjs";

const lowlight = createLowlight(common);

export function Editor() {
  const { activeDocId, documents, updateDocument } = useAppStore();
  const user = useAuthStore((s) => s.user);
  const isOnline = useAuthStore((s) => s.isOnline);
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const prevDocIdRef = useRef<string | null>(null);
  const colorRef = useRef(getRandomColor());

  // Determine if collaboration should be enabled
  const collabEnabled = !!user && isOnline && !!activeDocId;

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          codeBlock: false,
        }),
        Placeholder.configure({
          placeholder: "Start writing...",
        }),
        Typography,
        TaskList,
        TaskItem.configure({ nested: true }),
        CodeBlockLowlight.configure({ lowlight }),
        // Collaboration extensions (only when online + authenticated)
        ...(collabEnabled
          ? [
              Collaboration.configure({
                document: getYDoc(activeDocId),
              }),
              CollaborationCursor.configure({
                provider: getProvider(activeDocId, {
                  name: user.displayName || user.email || "Anonymous",
                  color: colorRef.current,
                }),
              }),
            ]
          : []),
      ],
      content: collabEnabled ? undefined : activeDoc?.content || "",
      editorProps: {
        attributes: {
          class:
            "prose prose-neutral dark:prose-invert max-w-none outline-none min-h-[calc(100vh-8rem)] px-12 py-8",
        },
      },
      onUpdate: ({ editor: e }) => {
        if (activeDocId) {
          updateDocument(activeDocId, {
            content: e.getHTML(),
            updatedAt: Date.now(),
          });
        }
      },
    },
    [activeDocId, collabEnabled],
  );

  const updateTitle = useCallback(() => {
    if (!editor || !activeDocId) return;
    const text = editor.getText();
    const firstLine = text.split("\n")[0]?.trim();
    if (firstLine) {
      updateDocument(activeDocId, { title: firstLine.slice(0, 50) });
    }
  }, [editor, activeDocId, updateDocument]);

  // Clean up previous collaboration when switching docs
  useEffect(() => {
    if (prevDocIdRef.current && prevDocIdRef.current !== activeDocId) {
      disconnectProvider(prevDocIdRef.current);
    }
    prevDocIdRef.current = activeDocId;

    return () => {
      if (activeDocId) {
        disconnectProvider(activeDocId);
      }
    };
  }, [activeDocId]);

  useEffect(() => {
    if (!editor) return;
    const handler = () => updateTitle();
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor, updateTitle]);

  if (!activeDoc) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <p className="text-lg font-medium">No document selected</p>
          <p className="text-sm">
            Create a new document or select one from the sidebar
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <EditorToolbar editor={editor} />
      <div className="flex-1 overflow-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
