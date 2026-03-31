import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  FileText,
  Plus,
  Moon,
  Sun,
  PenLine,
  LayoutGrid,
  History,
  Bot,
  Share2,
  Download,
  Upload,
  Printer,
  Keyboard,
  Globe,
  GlobeLock,
  Link,
} from "lucide-react";
import { useAppStore, type Document } from "@/stores/app-store";

interface CommandPaletteProps {
  onViewChange: (view: "editor" | "canvas") => void;
  onTogglePanel: (panel: "versions" | "ai") => void;
  onShare: () => void;
  onExportHtml: () => void;
  onExportText: () => void;
  onExportMarkdown?: () => void;
  onImportMarkdown?: () => void;
  onPrint?: () => void;
  onShowShortcuts?: () => void;
  onOpenShareLink?: (link: string) => void;
  onPublish?: () => void;
  onUnpublish?: () => void;
  isPublished?: boolean;
}

export function CommandPalette({
  onViewChange,
  onTogglePanel,
  onShare,
  onExportHtml,
  onExportText,
  onExportMarkdown,
  onImportMarkdown,
  onPrint,
  onShowShortcuts,
  onOpenShareLink,
  onPublish,
  onUnpublish,
  isPublished,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [linkInputOpen, setLinkInputOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const {
    documents,
    setActiveDocId,
    addDocument,
    theme,
    toggleTheme,
  } = useAppStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSelect = (callback: () => void) => {
    setOpen(false);
    callback();
  };

  const handleNewDoc = () => {
    const doc: Document = {
      id: crypto.randomUUID(),
      title: "Untitled",
      content: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      folder: "/",
      tags: [],
      ownerId: null,
    };
    addDocument(doc);
    setActiveDocId(doc.id);
  };

  return (
    <>
    {linkInputOpen && (
      <div
        className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50"
        onClick={() => { setLinkInputOpen(false); setLinkValue(""); }}
      >
        <div
          className="w-full max-w-md rounded-lg border border-border bg-popover p-4 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="mb-2 text-sm font-medium">共有リンクを貼り付け</p>
          <p className="mb-3 text-xs text-muted-foreground">
            markflow://share/... 形式のリンク、またはトークンを入力してください
          </p>
          <input
            autoFocus
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            placeholder="markflow://share/abc123... or token"
            value={linkValue}
            onChange={(e) => setLinkValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && linkValue.trim()) {
                onOpenShareLink?.(linkValue);
                setLinkInputOpen(false);
                setLinkValue("");
              }
              if (e.key === "Escape") {
                setLinkInputOpen(false);
                setLinkValue("");
              }
            }}
          />
        </div>
      </div>
    )}
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Documents">
          <CommandItem onSelect={() => handleSelect(handleNewDoc)}>
            <Plus className="mr-2 h-4 w-4" />
            New Document
          </CommandItem>
          {onImportMarkdown && (
            <CommandItem onSelect={() => handleSelect(onImportMarkdown)}>
              <Upload className="mr-2 h-4 w-4" />
              Import Markdown File
            </CommandItem>
          )}
          {documents.map((doc) => (
            <CommandItem
              key={doc.id}
              onSelect={() => handleSelect(() => setActiveDocId(doc.id))}
            >
              <FileText className="mr-2 h-4 w-4" />
              {doc.title}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Views">
          <CommandItem onSelect={() => handleSelect(() => onViewChange("editor"))}>
            <PenLine className="mr-2 h-4 w-4" />
            Editor View
          </CommandItem>
          <CommandItem onSelect={() => handleSelect(() => onViewChange("canvas"))}>
            <LayoutGrid className="mr-2 h-4 w-4" />
            Canvas View
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Panels">
          <CommandItem onSelect={() => handleSelect(() => onTogglePanel("ai"))}>
            <Bot className="mr-2 h-4 w-4" />
            Toggle AI Panel
          </CommandItem>
          <CommandItem onSelect={() => handleSelect(() => onTogglePanel("versions"))}>
            <History className="mr-2 h-4 w-4" />
            Toggle Version History
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => handleSelect(onShare)}>
            <Share2 className="mr-2 h-4 w-4" />
            Share Document
          </CommandItem>
          {onOpenShareLink && (
            <CommandItem onSelect={() => handleSelect(() => setLinkInputOpen(true))}>
              <Link className="mr-2 h-4 w-4" />
              Open Share Link
            </CommandItem>
          )}
          <CommandItem onSelect={() => handleSelect(onExportHtml)}>
            <Download className="mr-2 h-4 w-4" />
            Export as HTML
          </CommandItem>
          <CommandItem onSelect={() => handleSelect(onExportText)}>
            <Download className="mr-2 h-4 w-4" />
            Export as Text
          </CommandItem>
          {onExportMarkdown && (
            <CommandItem onSelect={() => handleSelect(onExportMarkdown)}>
              <Download className="mr-2 h-4 w-4" />
              Export as Markdown
            </CommandItem>
          )}
          {onPrint && (
            <CommandItem onSelect={() => handleSelect(onPrint)}>
              <Printer className="mr-2 h-4 w-4" />
              Print / Save as PDF
            </CommandItem>
          )}
          {onPublish && (
            <CommandItem onSelect={() => handleSelect(onPublish)}>
              <Globe className="mr-2 h-4 w-4" />
              {isPublished ? "Update Published Page" : "Publish to Web"}
            </CommandItem>
          )}
          {onUnpublish && isPublished && (
            <CommandItem onSelect={() => handleSelect(onUnpublish)}>
              <GlobeLock className="mr-2 h-4 w-4" />
              Unpublish from Web
            </CommandItem>
          )}
          <CommandItem onSelect={() => handleSelect(toggleTheme)}>
            {theme === "light" ? (
              <Moon className="mr-2 h-4 w-4" />
            ) : (
              <Sun className="mr-2 h-4 w-4" />
            )}
            Toggle {theme === "light" ? "Dark" : "Light"} Mode
          </CommandItem>
          {onShowShortcuts && (
            <CommandItem onSelect={() => handleSelect(onShowShortcuts)}>
              <Keyboard className="mr-2 h-4 w-4" />
              Keyboard Shortcuts
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
    </>
  );
}
