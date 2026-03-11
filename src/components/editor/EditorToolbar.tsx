import { useState, useRef, type ReactNode } from "react";
import {
  PenLine,
  Columns2,
  Eye,
  Paintbrush,
  Tag,
  X,
  Plus,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Link,
  Pencil,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ThemeCustomizer } from "@/components/ThemeCustomizer";
import { useAppStore } from "@/stores/app-store";
import { useEditorStore } from "@/stores/editor-store";
import type { PreviewMode } from "./Editor";

interface EditorToolbarProps {
  previewMode: PreviewMode;
  onPreviewModeChange: (mode: PreviewMode) => void;
  collabSlot?: ReactNode;
}

export function EditorToolbar({
  previewMode,
  onPreviewModeChange,
  collabSlot,
}: EditorToolbarProps) {
  const [themeOpen, setThemeOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [showTagInput, setShowTagInput] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const tagInputRef = useRef<HTMLInputElement>(null);

  const { activeDocId, documents, updateDocument } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const tags = activeDoc?.tags ?? [];
  const { view } = useEditorStore();

  const addTag = (value: string) => {
    const tag = value.trim().toLowerCase();
    if (!tag || !activeDocId || tags.includes(tag)) return;
    updateDocument(activeDocId, { tags: [...tags, tag], updatedAt: Date.now() });
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    if (!activeDocId) return;
    updateDocument(activeDocId, { tags: tags.filter((t) => t !== tag), updatedAt: Date.now() });
  };

  // ── Formatting helpers (dispatch to CodeMirror) ─────────

  const wrapSelection = (before: string, after: string) => {
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    if (from === to) {
      view.dispatch({ changes: { from, insert: before + after }, selection: { anchor: from + before.length } });
    } else {
      view.dispatch({
        changes: { from, to, insert: before + selected + after },
        selection: { anchor: from + before.length, head: from + before.length + selected.length },
      });
    }
    view.focus();
  };

  const linePrefix = (prefix: string) => {
    if (!view) return;
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    if (line.text.startsWith(prefix)) {
      view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: "" } });
    } else {
      view.dispatch({ changes: { from: line.from, insert: prefix } });
    }
    view.focus();
  };

  const handleStartRename = () => {
    if (!activeDoc) return;
    setRenameValue(activeDoc.title);
    setRenaming(true);
  };

  const handleFinishRename = () => {
    if (!activeDocId) {
      setRenaming(false);
      return;
    }
    const trimmed = renameValue.trim();
    if (!trimmed) {
      // Cleared title → unpin, immediately derive from content
      const derived = activeDoc?.content?.split("\n")[0]?.replace(/^#+\s*/, "").trim().slice(0, 50) || "Untitled";
      updateDocument(activeDocId, { title: derived, titlePinned: false, updatedAt: Date.now() });
    } else {
      updateDocument(activeDocId, { title: trimmed, titlePinned: true, updatedAt: Date.now() });
    }
    setRenaming(false);
  };

  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-1.5 bg-background/80 backdrop-blur-sm gap-2">
      {/* Left: document title (rename) + tags */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0 flex-1 overflow-hidden">
        {/* Document title / rename */}
        {activeDoc && (
          renaming ? (
            <div className="flex items-center gap-1 shrink-0">
              <input
                autoFocus
                className="bg-transparent text-xs font-medium outline-none border-b border-input w-32"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") handleFinishRename();
                  if (e.key === "Escape") setRenaming(false);
                }}
                onBlur={handleFinishRename}
              />
              <Check
                className="h-3 w-3 cursor-pointer hover:text-foreground"
                onClick={handleFinishRename}
              />
            </div>
          ) : (
            <span
              className="text-xs font-medium truncate max-w-[120px] cursor-pointer hover:text-foreground shrink-0 flex items-center gap-1"
              onClick={handleStartRename}
              title="Click to rename"
            >
              {activeDoc.title}
              <Pencil className="h-2.5 w-2.5 opacity-50" />
            </span>
          )
        )}

        <Separator orientation="vertical" className="h-4 mx-1" />

        {/* Tags */}
        <Tag className="h-3 w-3 shrink-0" />
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-0.5 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-secondary-foreground shrink-0"
          >
            {tag}
            <X
              className="h-2 w-2 cursor-pointer hover:text-destructive"
              onClick={() => removeTag(tag)}
            />
          </span>
        ))}
        {showTagInput ? (
          <input
            ref={tagInputRef}
            autoFocus
            className="bg-transparent text-[10px] outline-none w-16 border-b border-input"
            placeholder="tag"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(tagInput);
              }
              if (e.key === "Escape") {
                setShowTagInput(false);
                setTagInput("");
              }
            }}
            onBlur={() => {
              if (tagInput.trim()) addTag(tagInput);
              setShowTagInput(false);
            }}
          />
        ) : (
          <span title="Add tag">
            <Plus
              className="h-3 w-3 shrink-0 cursor-pointer hover:text-foreground"
              onClick={() => setShowTagInput(true)}
            />
          </span>
        )}
      </div>

      <div className="flex items-center gap-1">
        {collabSlot}

        {/* Formatting buttons */}
        {previewMode !== "preview" && (
          <>
            <div className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => wrapSelection("**", "**")} title="Bold (Cmd+B)">
                <Bold className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => wrapSelection("_", "_")} title="Italic (Cmd+I)">
                <Italic className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => wrapSelection("~~", "~~")} title="Strikethrough (Cmd+Shift+X)">
                <Strikethrough className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => wrapSelection("`", "`")} title="Code (Cmd+E)">
                <Code className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => {
                if (!view) return;
                const { from, to } = view.state.selection.main;
                const selected = view.state.sliceDoc(from, to);
                if (from === to) {
                  view.dispatch({ changes: { from, insert: "[](url)" }, selection: { anchor: from + 1 } });
                } else {
                  view.dispatch({ changes: { from, to, insert: `[${selected}](url)` }, selection: { anchor: from + selected.length + 3, head: from + selected.length + 6 } });
                }
                view.focus();
              }} title="Link (Cmd+K)">
                <Link className="h-3.5 w-3.5" />
              </Button>
            </div>

            <Separator orientation="vertical" className="h-4 mx-0.5" />

            <div className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => linePrefix("# ")} title="Heading 1">
                <Heading1 className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => linePrefix("## ")} title="Heading 2">
                <Heading2 className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => linePrefix("### ")} title="Heading 3">
                <Heading3 className="h-3.5 w-3.5" />
              </Button>
            </div>

            <Separator orientation="vertical" className="h-4 mx-0.5" />

            <div className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => linePrefix("- ")} title="Bullet list">
                <List className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => linePrefix("1. ")} title="Numbered list">
                <ListOrdered className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => linePrefix("> ")} title="Blockquote">
                <Quote className="h-3.5 w-3.5" />
              </Button>
            </div>

            <Separator orientation="vertical" className="h-4 mx-0.5" />
          </>
        )}

        {/* Theme customizer */}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
          onClick={() => setThemeOpen(true)}
          title="Theme"
        >
          <Paintbrush className="h-3.5 w-3.5" />
          Theme
        </Button>

        {/* Preview mode toggle */}
        <div className="flex items-center rounded-md border border-border p-0.5">
          <Button
            variant={previewMode === "edit" ? "secondary" : "ghost"}
            size="icon"
            className="h-6 w-6"
            onClick={() => onPreviewModeChange("edit")}
            title="Edit only"
          >
            <PenLine className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={previewMode === "split" ? "secondary" : "ghost"}
            size="icon"
            className="h-6 w-6"
            onClick={() => onPreviewModeChange("split")}
            title="Split view"
          >
            <Columns2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={previewMode === "preview" ? "secondary" : "ghost"}
            size="icon"
            className="h-6 w-6"
            onClick={() => onPreviewModeChange("preview")}
            title="Preview only"
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ThemeCustomizer open={themeOpen} onOpenChange={setThemeOpen} />
    </div>
  );
}
