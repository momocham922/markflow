import { useState, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppStore, type CustomPreviewTheme } from "@/stores/app-store";
import { previewThemeList } from "@/styles/preview-themes";
import { editorThemeList } from "@/styles/editor-themes";
import { Check, Upload, Download, X } from "lucide-react";
import { getPlatform } from "@/platform";

type Tab = "presets" | "custom";

interface ThemeCustomizerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Validate that an object looks like a valid PreviewTheme */
function validateThemeFile(obj: unknown): obj is CustomPreviewTheme {
  if (!obj || typeof obj !== "object") return false;
  const t = obj as Record<string, unknown>;
  return typeof t.id === "string" && typeof t.name === "string"
    && typeof t.variables === "object" && t.variables !== null;
}

export function ThemeCustomizer({ open, onOpenChange }: ThemeCustomizerProps) {
  const { themeSettings, setThemeSettings, customPreviewThemes, addCustomPreviewTheme, removeCustomPreviewTheme } = useAppStore();
  const [tab, setTab] = useState<Tab>("presets");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const handleImportTheme = useCallback(() => {
    setImportError(null);
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        if (!validateThemeFile(parsed)) {
          setImportError("無効なテーマファイル: id, name, variables が必要です");
          return;
        }
        addCustomPreviewTheme(parsed);
        setThemeSettings({ previewTheme: parsed.id });
        setImportError(null);
      } catch {
        setImportError("JSONの解析に失敗しました");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, [addCustomPreviewTheme, setThemeSettings]);

  const handleExportTheme = useCallback(async (theme: CustomPreviewTheme) => {
    const json = JSON.stringify(theme, null, 2);
    const platform = await getPlatform();
    const path = await platform.showSaveDialog({
      defaultPath: `${theme.id}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (path) await platform.writeTextFile(path, json);
  }, []);

  const handleDownloadTemplate = useCallback(async () => {
    const template: CustomPreviewTheme = {
      id: "my-custom-theme",
      name: "My Custom Theme",
      variables: {
        "--prose-body": "#333",
        "--prose-headings": "#111",
        "--prose-links": "#2563eb",
        "--prose-code-bg": "#f3f3f3",
        "--prose-quote-border": "#ddd",
        "--prose-font-size": "1rem",
        "--prose-line-height": "1.75",
        "--prose-font": "-apple-system, BlinkMacSystemFont, sans-serif",
        "--prose-letter-spacing": "0",
      },
      dark: {
        "--prose-body": "#ddd",
        "--prose-headings": "#fff",
        "--prose-links": "#60a5fa",
        "--prose-code-bg": "#1e293b",
        "--prose-quote-border": "#475569",
      },
    };
    const json = JSON.stringify(template, null, 2);
    const platform = await getPlatform();
    const path = await platform.showSaveDialog({
      defaultPath: "theme-template.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (path) await platform.writeTextFile(path, json);
  }, []);

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
              <div className="mb-2 flex items-center justify-between">
                <label className="block text-sm font-medium">
                  プレビューテーマ
                </label>
                <div className="flex gap-1">
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={handleDownloadTemplate}>
                    <Download className="h-3 w-3" />
                    テンプレート
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={handleImportTheme}>
                    <Upload className="h-3 w-3" />
                    インポート
                  </Button>
                </div>
              </div>
              {importError && (
                <p className="mb-2 text-xs text-destructive">{importError}</p>
              )}
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
                {customPreviewThemes.map((t) => (
                  <div key={t.id} className="group relative">
                    <button
                      onClick={() => setThemeSettings({ previewTheme: t.id })}
                      className={`w-full rounded-md border px-3 py-2 text-sm transition-colors ${
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
                    <div className="absolute -top-1 -right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-muted-foreground hover:text-foreground"
                        title="エクスポート"
                        onClick={(e) => { e.stopPropagation(); handleExportTheme(t); }}
                      >
                        <Download className="h-2.5 w-2.5" />
                      </button>
                      <button
                        className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-muted-foreground hover:text-destructive"
                        title="削除"
                        onClick={(e) => { e.stopPropagation(); removeCustomPreviewTheme(t.id); }}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  </div>
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
                mindMapTheme: "lavender",
                customPreviewCss: "",
              })
            }
          >
            リセット
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleFileChange}
        />
      </DialogContent>
    </Dialog>
  );
}
