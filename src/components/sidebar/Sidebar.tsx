import {
  FileText,
  Plus,
  Search,
  Trash2,
  PanelLeftClose,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useAppStore, type Document } from "@/stores/app-store";

export function Sidebar() {
  const {
    documents,
    activeDocId,
    setActiveDocId,
    addDocument,
    deleteDocument,
    toggleSidebar,
  } = useAppStore();
  const [search, setSearch] = useState("");

  const filtered = documents.filter((d) =>
    d.title.toLowerCase().includes(search.toLowerCase()),
  );

  const handleNew = () => {
    const doc: Document = {
      id: crypto.randomUUID(),
      title: "Untitled",
      content: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    addDocument(doc);
    setActiveDocId(doc.id);
  };

  return (
    <div className="flex h-full w-60 flex-col border-r border-border bg-sidebar-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-2 pb-2">
        <span className="text-sm font-semibold text-sidebar-foreground tracking-wide">
          MarkFlow
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-sidebar-foreground"
          onClick={toggleSidebar}
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <Separator />

      {/* New document */}
      <div className="px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-xs"
          onClick={handleNew}
        >
          <Plus className="h-3.5 w-3.5" />
          New Document
        </Button>
      </div>

      {/* Document list */}
      <ScrollArea className="flex-1 px-1">
        <div className="space-y-0.5 p-2">
          {filtered.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No documents yet
            </p>
          )}
          {filtered.map((doc) => (
            <button
              key={doc.id}
              onClick={() => setActiveDocId(doc.id)}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                activeDocId === doc.id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50",
              )}
            >
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate">{doc.title}</span>
              <Trash2
                className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteDocument(doc.id);
                }}
              />
            </button>
          ))}
        </div>
      </ScrollArea>

      {/* Footer */}
      <Separator />
      <div className="px-3 py-2 text-[10px] text-muted-foreground">
        {documents.length} document{documents.length !== 1 ? "s" : ""}
      </div>
    </div>
  );
}
