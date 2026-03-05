import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { useEffect, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";
import { EditorToolbar } from "./EditorToolbar";

const lowlight = createLowlight(common);

export function Editor() {
  const { activeDocId, documents, updateDocument } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);

  const editor = useEditor({
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
    ],
    content: activeDoc?.content || "",
    editorProps: {
      attributes: {
        class:
          "prose prose-neutral dark:prose-invert max-w-none outline-none min-h-[calc(100vh-8rem)] px-12 py-8",
      },
    },
    onUpdate: ({ editor }) => {
      if (activeDocId) {
        updateDocument(activeDocId, {
          content: editor.getHTML(),
          updatedAt: Date.now(),
        });
      }
    },
  });

  const updateTitle = useCallback(() => {
    if (!editor || !activeDocId) return;
    const text = editor.getText();
    const firstLine = text.split("\n")[0]?.trim();
    if (firstLine) {
      updateDocument(activeDocId, { title: firstLine.slice(0, 50) });
    }
  }, [editor, activeDocId, updateDocument]);

  useEffect(() => {
    if (editor && activeDoc) {
      const currentContent = editor.getHTML();
      if (currentContent !== activeDoc.content) {
        editor.commands.setContent(activeDoc.content || "");
      }
    }
  }, [activeDocId]); // eslint-disable-line react-hooks/exhaustive-deps

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
