import { useState, useRef, type ReactNode } from "react";
import { PenLine, Columns2, Eye, Paintbrush, Tag, X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeCustomizer } from "@/components/ThemeCustomizer";
import { useAppStore } from "@/stores/app-store";
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
  const tagInputRef = useRef<HTMLInputElement>(null);

  const { activeDocId, documents, updateDocument } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const tags = activeDoc?.tags ?? [];

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

  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-1.5 bg-background/80 backdrop-blur-sm">
      {/* Left: tags */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0 flex-1 overflow-hidden">
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

      <div className="flex items-center gap-2">
        {collabSlot}
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
