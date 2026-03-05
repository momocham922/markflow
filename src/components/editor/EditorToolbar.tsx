import { useState } from "react";
import { PenLine, Columns2, Eye, Paintbrush } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeCustomizer } from "@/components/ThemeCustomizer";
import type { PreviewMode } from "./Editor";

interface EditorToolbarProps {
  previewMode: PreviewMode;
  onPreviewModeChange: (mode: PreviewMode) => void;
}

export function EditorToolbar({
  previewMode,
  onPreviewModeChange,
}: EditorToolbarProps) {
  const [themeOpen, setThemeOpen] = useState(false);

  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-1.5 bg-background/80 backdrop-blur-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Markdown</span>
      </div>

      <div className="flex items-center gap-2">
        {/* Theme customizer */}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
          onClick={() => setThemeOpen(true)}
          title="テーマ設定"
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
