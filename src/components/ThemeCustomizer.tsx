import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { previewThemeList } from "@/styles/preview-themes";
import { editorThemeList } from "@/styles/editor-themes";
import { Check } from "lucide-react";

type Tab = "presets" | "custom";

interface ThemeCustomizerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ThemeCustomizer({ open, onOpenChange }: ThemeCustomizerProps) {
  const { themeSettings, setThemeSettings } = useAppStore();
  const [tab, setTab] = useState<Tab>("presets");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>テーマ設定</DialogTitle>
          <DialogDescription>
            プレビューとエディタの外観をカスタマイズ
          </DialogDescription>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          <button
            className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === "presets"
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab("presets")}
          >
            プリセット
          </button>
          <button
            className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === "custom"
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab("custom")}
          >
            カスタムCSS
          </button>
        </div>

        {tab === "presets" ? (
          <div className="space-y-4">
            {/* Preview theme */}
            <div>
              <label className="mb-2 block text-sm font-medium">
                プレビューテーマ
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {previewThemeList.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setThemeSettings({ previewTheme: t.id })}
                    className={`relative rounded-md border px-3 py-2 text-sm transition-colors ${
                      themeSettings.previewTheme === t.id
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border text-muted-foreground hover:border-foreground/30"
                    }`}
                  >
                    {t.name}
                    {themeSettings.previewTheme === t.id && (
                      <Check className="absolute top-1 right-1 h-3 w-3 text-primary" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Editor theme */}
            <div>
              <label className="mb-2 block text-sm font-medium">
                エディタテーマ
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {editorThemeList.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setThemeSettings({ editorTheme: t.id })}
                    className={`relative rounded-md border px-3 py-2 text-sm transition-colors ${
                      themeSettings.editorTheme === t.id
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border text-muted-foreground hover:border-foreground/30"
                    }`}
                  >
                    {t.name}
                    {themeSettings.editorTheme === t.id && (
                      <Check className="absolute top-1 right-1 h-3 w-3 text-primary" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="block text-sm font-medium">
              カスタムCSS（プレビューペインに適用）
            </label>
            <textarea
              className="h-48 w-full rounded-md border border-border bg-muted/50 p-3 font-mono text-sm focus:border-primary focus:outline-none"
              placeholder={`.prose h1 {\n  color: #e06c75;\n}\n.prose a {\n  color: #61afef;\n}`}
              value={themeSettings.customPreviewCss}
              onChange={(e) =>
                setThemeSettings({ customPreviewCss: e.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              プレビューペインの .prose 要素に対してCSSを記述できます。
              変更はリアルタイムで反映されます。
            </p>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setThemeSettings({
                previewTheme: "github",
                editorTheme: "default",
                customPreviewCss: "",
              })
            }
          >
            リセット
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
