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
} from "lucide-react";
import { useAppStore, type Document } from "@/stores/app-store";

interface CommandPaletteProps {
  onViewChange: (view: "editor" | "canvas") => void;
  onTogglePanel: (panel: "versions" | "ai") => void;
  onShare: () => void;
  onExportHtml: () => void;
  onExportText: () => void;
}

export function CommandPalette({
  onViewChange,
  onTogglePanel,
  onShare,
  onExportHtml,
  onExportText,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
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
    };
    addDocument(doc);
    setActiveDocId(doc.id);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Documents">
          <CommandItem onSelect={() => handleSelect(handleNewDoc)}>
            <Plus className="mr-2 h-4 w-4" />
            New Document
          </CommandItem>
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
          <CommandItem onSelect={() => handleSelect(onExportHtml)}>
            <Download className="mr-2 h-4 w-4" />
            Export as HTML
          </CommandItem>
          <CommandItem onSelect={() => handleSelect(onExportText)}>
            <Download className="mr-2 h-4 w-4" />
            Export as Text
          </CommandItem>
          <CommandItem onSelect={() => handleSelect(toggleTheme)}>
            {theme === "light" ? (
              <Moon className="mr-2 h-4 w-4" />
            ) : (
              <Sun className="mr-2 h-4 w-4" />
            )}
            Toggle {theme === "light" ? "Dark" : "Light"} Mode
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
