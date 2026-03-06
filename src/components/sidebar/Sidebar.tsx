import {
  FileText,
  Plus,
  Search,
  Trash2,
  PanelLeftClose,
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  Tag,
  X,
  Share2,
} from "lucide-react";
import { useState, useMemo, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useAppStore, type Document } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { fetchSharedWithMe } from "@/services/sharing";
import { fetchDocument } from "@/services/firebase";

// ── Folder tree helpers ──────────────────────────────────────

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  docs: Document[];
}

function buildTree(folders: string[], docs: Document[]): FolderNode {
  const root: FolderNode = { name: "Documents", path: "/", children: [], docs: [] };
  const nodeMap = new Map<string, FolderNode>();
  nodeMap.set("/", root);

  // Create nodes for all folders
  const sorted = [...folders].filter((f) => f !== "/").sort();
  for (const path of sorted) {
    const parts = path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (const part of parts) {
      currentPath += "/" + part;
      if (!nodeMap.has(currentPath)) {
        const node: FolderNode = { name: part, path: currentPath, children: [], docs: [] };
        nodeMap.set(currentPath, node);
        current.children.push(node);
      }
      current = nodeMap.get(currentPath)!;
    }
  }

  // Place docs
  for (const doc of docs) {
    const folder = doc.folder || "/";
    const node = nodeMap.get(folder);
    if (node) {
      node.docs.push(doc);
    } else {
      root.docs.push(doc);
    }
  }

  return root;
}

// ── Main component ───────────────────────────────────────────

export function Sidebar() {
  const {
    documents,
    activeDocId,
    setActiveDocId,
    addDocument,
    deleteDocument,
    toggleSidebar,
    folders,
    createFolder,
    deleteFolder,
    moveDocument,
  } = useAppStore();

  const [search, setSearch] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(["/"]) );
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [creatingFolderIn, setCreatingFolderIn] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ docId: string; x: number; y: number } | null>(null);

  // Shared with me
  const user = useAuthStore((s) => s.user);
  const [sharedDocs, setSharedDocs] = useState<{ id: string; title: string; role: "editor" | "viewer" }[]>([]);
  const [sharedExpanded, setSharedExpanded] = useState(true);

  useEffect(() => {
    if (!user?.uid) {
      setSharedDocs([]);
      return;
    }
    fetchSharedWithMe(user.uid).then(setSharedDocs).catch(() => {});
  }, [user?.uid]);

  // Search: filter by title AND content
  const isSearching = search.trim().length > 0;
  const searchResults = useMemo(() => {
    if (!isSearching) return [];
    const q = search.toLowerCase();
    return documents.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        d.content.toLowerCase().includes(q),
    );
  }, [documents, search, isSearching]);

  // All unique tags
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const doc of documents) {
      for (const tag of doc.tags) tagSet.add(tag);
    }
    return [...tagSet].sort();
  }, [documents]);

  // Filtered docs for tree (tag filter only, search is separate view)
  const filteredDocs = useMemo(() => {
    if (!selectedTag) return documents;
    return documents.filter((d) => d.tags.includes(selectedTag));
  }, [documents, selectedTag]);

  const tree = useMemo(
    () => buildTree(folders, filteredDocs),
    [folders, filteredDocs],
  );

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleNew = (folder = "/") => {
    const doc: Document = {
      id: crypto.randomUUID(),
      title: "Untitled",
      content: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      folder,
      tags: [],
      ownerId: null,
    };
    addDocument(doc);
    setActiveDocId(doc.id);
    // Expand the folder
    setExpandedFolders((prev) => new Set([...prev, folder]));
  };

  const handleCreateFolder = (parentPath: string) => {
    const name = newFolderName.trim();
    if (!name) return;
    const path = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    createFolder(path);
    setExpandedFolders((prev) => new Set([...prev, parentPath, path]));
    setCreatingFolderIn(null);
    setNewFolderName("");
  };

  const handleDrop = (e: React.DragEvent, folder: string) => {
    e.preventDefault();
    setDragOverFolder(null);
    const docId = e.dataTransfer.getData("text/plain");
    if (docId) moveDocument(docId, folder);
  };

  // ── Render helpers ───────────────────────────────────────

  const renderDoc = (doc: Document) => (
    <button
      key={doc.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", doc.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => setActiveDocId(doc.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ docId: doc.id, x: e.clientX, y: e.clientY });
      }}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
        activeDocId === doc.id
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
      )}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 truncate">{doc.title}</span>
      {doc.tags.length > 0 && (
        <span className="text-[9px] text-muted-foreground shrink-0">
          {doc.tags.length}
          <Tag className="inline h-2 w-2 ml-0.5" />
        </span>
      )}
      <Trash2
        className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
        onClick={(e) => {
          e.stopPropagation();
          deleteDocument(doc.id);
        }}
      />
    </button>
  );

  const renderSearchMatch = (doc: Document) => {
    const q = search.toLowerCase();
    const contentMatch = doc.content.toLowerCase().indexOf(q);
    let snippet = "";
    if (contentMatch >= 0) {
      const start = Math.max(0, contentMatch - 30);
      const end = Math.min(doc.content.length, contentMatch + search.length + 30);
      snippet = (start > 0 ? "..." : "") + doc.content.slice(start, end) + (end < doc.content.length ? "..." : "");
    }
    return (
      <button
        key={doc.id}
        onClick={() => setActiveDocId(doc.id)}
        className={cn(
          "group flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
          activeDocId === doc.id
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/50",
        )}
      >
        <div className="flex items-center gap-2">
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate font-medium">{doc.title}</span>
        </div>
        {snippet && (
          <span className="pl-5 text-[10px] text-muted-foreground truncate">
            {snippet}
          </span>
        )}
      </button>
    );
  };

  const renderFolder = (node: FolderNode, depth = 0) => {
    const isExpanded = expandedFolders.has(node.path);
    const isRoot = node.path === "/";
    const hasContent = node.docs.length > 0 || node.children.length > 0;
    const isDragOver = dragOverFolder === node.path;

    return (
      <div key={node.path}>
        {/* Folder header */}
        {!isRoot && (
          <div
            className={cn(
              "group flex items-center gap-1 rounded-md px-2 py-1 text-xs text-sidebar-foreground hover:bg-sidebar-accent/50 cursor-pointer transition-colors",
              isDragOver && "bg-sidebar-accent/70 ring-1 ring-primary/30",
            )}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            onClick={() => toggleFolder(node.path)}
            onDragOver={(e) => { e.preventDefault(); setDragOverFolder(node.path); }}
            onDragLeave={() => setDragOverFolder(null)}
            onDrop={(e) => handleDrop(e, node.path)}
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            {isExpanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="flex-1 truncate">{node.name}</span>
            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
              <Plus
                className="h-3 w-3 text-muted-foreground hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); handleNew(node.path); }}
              />
              <FolderPlus
                className="h-3 w-3 text-muted-foreground hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); setCreatingFolderIn(node.path); setNewFolderName(""); }}
              />
              <Trash2
                className="h-3 w-3 text-muted-foreground hover:text-destructive"
                onClick={(e) => { e.stopPropagation(); deleteFolder(node.path); }}
              />
            </div>
          </div>
        )}

        {/* Folder inline creation */}
        {creatingFolderIn === node.path && (
          <div className="flex items-center gap-1 px-2 py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
            <Folder className="h-3 w-3 text-muted-foreground shrink-0" />
            <input
              autoFocus
              className="flex-1 bg-transparent text-xs outline-none border-b border-input"
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder(node.path);
                if (e.key === "Escape") setCreatingFolderIn(null);
              }}
              onBlur={() => { if (newFolderName.trim()) handleCreateFolder(node.path); else setCreatingFolderIn(null); }}
            />
          </div>
        )}

        {/* Children */}
        {(isRoot || isExpanded) && (
          <>
            {node.children.map((child) => renderFolder(child, isRoot ? depth : depth + 1))}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOverFolder(node.path); }}
              onDragLeave={() => setDragOverFolder(null)}
              onDrop={(e) => handleDrop(e, node.path)}
            >
              {node.docs.map((doc) => (
                <div key={doc.id} style={{ paddingLeft: `${(isRoot ? depth : depth + 1) * 12}px` }}>
                  {renderDoc(doc)}
                </div>
              ))}
            </div>
            {!hasContent && isExpanded && !isRoot && (
              <p
                className="text-[10px] text-muted-foreground italic px-2 py-1"
                style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
              >
                Empty
              </p>
            )}
          </>
        )}
      </div>
    );
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
            placeholder="Search title & content..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {search && (
            <X
              className="h-3 w-3 text-muted-foreground cursor-pointer hover:text-foreground"
              onClick={() => setSearch("")}
            />
          )}
        </div>
      </div>

      {/* Tag filter */}
      {allTags.length > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
              className={cn(
                "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] transition-colors",
                selectedTag === tag
                  ? "bg-primary text-primary-foreground"
                  : "bg-sidebar-accent text-muted-foreground hover:text-foreground",
              )}
            >
              <Tag className="h-2 w-2" />
              {tag}
            </button>
          ))}
        </div>
      )}

      <Separator />

      {/* Actions */}
      <div className="px-3 py-2 flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 justify-start gap-2 text-xs"
          onClick={() => handleNew()}
        >
          <Plus className="h-3.5 w-3.5" />
          New Document
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => { setCreatingFolderIn("/"); setNewFolderName(""); }}
          title="New Folder"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Document list / search results */}
      <ScrollArea className="flex-1 px-1">
        <div className="space-y-0.5 p-2">
          {isSearching ? (
            <>
              <p className="px-2 pb-1 text-[10px] text-muted-foreground">
                {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
              </p>
              {searchResults.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  No results
                </p>
              )}
              {searchResults.map(renderSearchMatch)}
            </>
          ) : (
            <>
              {documents.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  No documents yet
                </p>
              )}
              {renderFolder(tree)}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Shared with me */}
      {user && sharedDocs.length > 0 && (
        <>
          <Separator />
          <div className="px-1">
            <button
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setSharedExpanded((v) => !v)}
            >
              {sharedExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <Share2 className="h-3 w-3" />
              <span className="font-medium">Shared with me</span>
              <span className="ml-auto text-[10px]">{sharedDocs.length}</span>
            </button>
            {sharedExpanded && (
              <div className="space-y-0.5 pb-1">
                {sharedDocs.map((sd) => (
                  <button
                    key={sd.id}
                    onClick={async () => {
                      // If doc is already in local store, just open it
                      const existing = documents.find((d) => d.id === sd.id);
                      if (existing) {
                        setActiveDocId(sd.id);
                        return;
                      }
                      // Fetch from Firestore and add to local store
                      const firestoreDoc = await fetchDocument(sd.id);
                      if (firestoreDoc) {
                        addDocument({
                          id: firestoreDoc.id,
                          title: firestoreDoc.title,
                          content: firestoreDoc.content,
                          createdAt: firestoreDoc.createdAt?.toMillis() ?? Date.now(),
                          updatedAt: firestoreDoc.updatedAt?.toMillis() ?? Date.now(),
                          folder: firestoreDoc.folder || "/",
                          tags: firestoreDoc.tags || [],
                          ownerId: firestoreDoc.ownerId,
                        });
                        setActiveDocId(sd.id);
                      }
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                      activeDocId === sd.id
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                    )}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 truncate">{sd.title}</span>
                    <span className="text-[9px] text-muted-foreground capitalize shrink-0">
                      {sd.role}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Footer */}
      <Separator />
      <div className="px-3 py-2 text-[10px] text-muted-foreground">
        {documents.length} document{documents.length !== 1 ? "s" : ""}
        {folders.length > 1 && ` / ${folders.length - 1} folder${folders.length > 2 ? "s" : ""}`}
      </div>

      {/* Context menu for "Move to folder" */}
      {contextMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setContextMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
        >
          <div
            className="absolute rounded-md border border-border bg-popover shadow-md py-1 min-w-[140px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="px-3 py-1 text-[10px] text-muted-foreground uppercase tracking-wider">
              Move to
            </p>
            {folders.map((f) => {
              const doc = documents.find((d) => d.id === contextMenu.docId);
              const isCurrent = doc?.folder === f;
              return (
                <button
                  key={f}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-accent transition-colors",
                    isCurrent && "text-muted-foreground",
                  )}
                  disabled={isCurrent}
                  onClick={() => {
                    moveDocument(contextMenu.docId, f);
                    setContextMenu(null);
                  }}
                >
                  <Folder className="h-3 w-3 shrink-0" />
                  {f === "/" ? "Root" : f.split("/").pop()}
                  {isCurrent && <span className="text-[10px] ml-auto">(current)</span>}
                </button>
              );
            })}
            <Separator className="my-1" />
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left text-destructive hover:bg-accent transition-colors"
              onClick={() => {
                deleteDocument(contextMenu.docId);
                setContextMenu(null);
              }}
            >
              <Trash2 className="h-3 w-3 shrink-0" />
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
