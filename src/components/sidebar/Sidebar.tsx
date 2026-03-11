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
  Users,
  Lock,
  PenLine,
} from "lucide-react";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useAppStore, type Document } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { fetchSharedWithMe, fetchUserTeams, fetchTeamDocuments, createTeamDocument, removeCollaborator, getTeamFolders, setTeamFolders, moveTeamDocument, type Team } from "@/services/sharing";
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

// ── Types ────────────────────────────────────────────────────

interface TeamWithDocs extends Team {
  docs: { id: string; title: string; folder: string }[];
  folders: string[];
}

// ── Main component ───────────────────────────────────────────

export function Sidebar() {
  const {
    documents,
    activeDocId,
    setActiveDocId,
    addDocument,
    updateDocument,
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
  const [renamingDocId, setRenamingDocId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Shared with me
  const user = useAuthStore((s) => s.user);
  const [sharedDocs, setSharedDocs] = useState<{ id: string; title: string; role: "editor" | "viewer" }[]>([]);
  const [sharedExpanded, setSharedExpanded] = useState(true);

  // My Documents collapsible
  const [myDocsExpanded, setMyDocsExpanded] = useState(true);

  // Teams
  const [teams, setTeams] = useState<TeamWithDocs[]>([]);
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());
  const [teamsExpanded, setTeamsExpanded] = useState(true);
  const teamsRefreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [expandedTeamFolders, setExpandedTeamFolders] = useState<Set<string>>(new Set());
  const [creatingTeamFolderIn, setCreatingTeamFolderIn] = useState<{ teamId: string; parent: string } | null>(null);
  const [newTeamFolderName, setNewTeamFolderName] = useState("");
  const [dragOverTeamFolder, setDragOverTeamFolder] = useState<string | null>(null);

  // Load shared docs & teams, with periodic refresh for team docs
  const refreshTeams = useCallback(async (uid: string) => {
    try {
      const userTeams = await fetchUserTeams(uid);
      const teamsWithDocs = await Promise.all(
        userTeams.map(async (team) => {
          const [docs, folders] = await Promise.all([
            fetchTeamDocuments(team.id).catch(() => []),
            getTeamFolders(team.id).catch(() => []),
          ]);
          return { ...team, docs, folders } as TeamWithDocs;
        }),
      );
      setTeams(teamsWithDocs);
      // Auto-expand if there's only one team
      if (teamsWithDocs.length === 1) {
        setExpandedTeams(new Set([teamsWithDocs[0].id]));
      }

      // Reconcile: remove local team docs that were deleted from Firestore
      const firestoreTeamDocIds = new Set<string>();
      for (const team of teamsWithDocs) {
        for (const doc of team.docs) firestoreTeamDocIds.add(doc.id);
      }
      const appStore = useAppStore.getState();
      for (const doc of appStore.documents) {
        if (!doc.teamId) continue;
        if (firestoreTeamDocIds.has(doc.id)) continue;
        // Grace period: skip docs created in the last 30s (might not be indexed yet)
        if (Date.now() - doc.createdAt < 30_000) continue;
        appStore.deleteDocument(doc.id);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setSharedDocs([]);
      setTeams([]);
      return;
    }
    fetchSharedWithMe(user.uid).then(setSharedDocs).catch(() => {});
    refreshTeams(user.uid);

    // Poll every 15s to pick up changes from other members
    teamsRefreshTimer.current = setInterval(() => {
      refreshTeams(user.uid);
      fetchSharedWithMe(user.uid).then(setSharedDocs).catch(() => {});
    }, 15_000);

    return () => {
      if (teamsRefreshTimer.current) clearInterval(teamsRefreshTimer.current);
    };
  }, [user?.uid, refreshTeams]);

  // Derive set of IDs that belong to teams or shared
  const teamDocIds = useMemo(() => {
    const ids = new Set<string>();
    for (const team of teams) {
      for (const td of team.docs) ids.add(td.id);
    }
    // Also include local docs that have a teamId
    for (const doc of documents) {
      if (doc.teamId) ids.add(doc.id);
    }
    return ids;
  }, [teams, documents]);

  const sharedDocIds = useMemo(
    () => new Set(sharedDocs.map((s) => s.id)),
    [sharedDocs],
  );

  // Personal docs: exclude team docs and docs shared with me (that I don't own)
  const personalDocs = useMemo(
    () => documents.filter((d) => !teamDocIds.has(d.id) && !sharedDocIds.has(d.id)),
    [documents, teamDocIds, sharedDocIds],
  );

  // Search: filter by title AND content (across ALL docs)
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

  // All unique tags (from personal docs only — matches filteredDocs scope)
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const doc of personalDocs) {
      for (const tag of doc.tags) tagSet.add(tag);
    }
    return [...tagSet].sort();
  }, [personalDocs]);

  // Filtered docs for tree (tag filter only, search is separate view)
  const filteredDocs = useMemo(() => {
    if (!selectedTag) return personalDocs;
    return personalDocs.filter((d) => d.tags.includes(selectedTag));
  }, [personalDocs, selectedTag]);

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
      content: "# Untitled\n",
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
    if (!name || /[/\\]/.test(name)) return;
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

  const handleCreateTeamDoc = async (team: TeamWithDocs, folder = "/") => {
    if (!user) return;
    const newDocId = await createTeamDocument(team.id, user.uid);
    // Update folder in Firestore if not root
    if (folder !== "/") {
      await moveTeamDocument(newDocId, folder).catch(console.error);
    }
    const newDoc: Document = {
      id: newDocId,
      title: "Untitled",
      content: "# Untitled\n",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      folder,
      tags: [],
      ownerId: user.uid,
      teamId: team.id,
      isShared: true,
    };
    addDocument(newDoc);
    setActiveDocId(newDocId);
    setExpandedTeams((prev) => new Set([...prev, team.id]));
    // Update local teams state immediately
    setTeams((prev) =>
      prev.map((t) =>
        t.id === team.id
          ? { ...t, docs: [...t.docs, { id: newDocId, title: "Untitled", folder }] }
          : t,
      ),
    );
  };

  const handleDeleteTeamDoc = async (docId: string, team: TeamWithDocs) => {
    // Remove from local store
    deleteDocument(docId);
    // Remove from Firestore
    try {
      const { deleteDocumentFromFirestore } = await import("@/services/firebase");
      await deleteDocumentFromFirestore(docId);
    } catch { /* ignore */ }
    // Update local teams state immediately
    setTeams((prev) =>
      prev.map((t) =>
        t.id === team.id
          ? { ...t, docs: t.docs.filter((d) => d.id !== docId) }
          : t,
      ),
    );
  };

  const handleCreateTeamFolder = async (teamId: string, parentPath: string) => {
    const name = newTeamFolderName.trim();
    if (!name || /[/\\]/.test(name)) return;
    const path = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;
    const updated = [...new Set([...team.folders, path])].sort();
    await setTeamFolders(teamId, updated).catch(console.error);
    setTeams((prev) => prev.map((t) => t.id === teamId ? { ...t, folders: updated } : t));
    setExpandedTeamFolders((prev) => new Set([...prev, `${teamId}:${parentPath}`, `${teamId}:${path}`]));
    setCreatingTeamFolderIn(null);
    setNewTeamFolderName("");
  };

  const handleDeleteTeamFolder = async (teamId: string, folderPath: string) => {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;
    // Delete docs in the folder
    const docsInFolder = team.docs.filter(
      (d) => d.folder === folderPath || d.folder.startsWith(folderPath + "/"),
    );
    for (const td of docsInFolder) {
      await handleDeleteTeamDoc(td.id, team);
    }
    // Remove the folder and subfolders
    const updated = team.folders.filter(
      (f) => f !== folderPath && !f.startsWith(folderPath + "/"),
    );
    await setTeamFolders(teamId, updated).catch(console.error);
    setTeams((prev) => prev.map((t) => t.id === teamId ? { ...t, folders: updated } : t));
  };

  const handleMoveTeamDoc = async (docId: string, folder: string) => {
    await moveTeamDocument(docId, folder).catch(console.error);
    // Update local state
    setTeams((prev) =>
      prev.map((t) => ({
        ...t,
        docs: t.docs.map((d) => d.id === docId ? { ...d, folder } : d),
      })),
    );
    // Also update local document store if loaded
    const existing = documents.find((d) => d.id === docId);
    if (existing) {
      updateDocument(docId, { folder, updatedAt: Date.now() });
    }
  };

  const openTeamOrSharedDoc = async (docIdToOpen: string, teamId?: string) => {
    const existing = documents.find((d) => d.id === docIdToOpen);
    if (existing) {
      // Ensure team/shared docs have isShared flag for yCollab activation
      if (!existing.isShared && (teamId || existing.teamId)) {
        updateDocument(docIdToOpen, { isShared: true, teamId: teamId || existing.teamId });
      }
      setActiveDocId(docIdToOpen);
      return;
    }
    const firestoreDoc = await fetchDocument(docIdToOpen);
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
        teamId: teamId || firestoreDoc.teamId || null,
        isShared: true,
      });
      setActiveDocId(docIdToOpen);
    }
  };

  // ── Render helpers ───────────────────────────────────────

  const commitRename = (docId: string) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== documents.find((d) => d.id === docId)?.title) {
      updateDocument(docId, { title: trimmed, updatedAt: Date.now() });
    }
    setRenamingDocId(null);
  };

  const renderDoc = (doc: Document) => (
    <button
      key={doc.id}
      draggable={renamingDocId !== doc.id}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", doc.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => setActiveDocId(doc.id)}
      onDoubleClick={(e) => {
        e.preventDefault();
        setRenamingDocId(doc.id);
        setRenameValue(doc.title);
      }}
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
      {renamingDocId === doc.id ? (
        <input
          autoFocus
          className="flex-1 min-w-0 bg-transparent border-b border-primary outline-none text-xs"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={() => commitRename(doc.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename(doc.id);
            if (e.key === "Escape") setRenamingDocId(null);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 truncate">{doc.title}</span>
      )}
      {doc.isShared && (
        <span title="Shared"><Share2 className="h-3 w-3 shrink-0 text-muted-foreground" /></span>
      )}
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
    // Determine which section this doc belongs to
    const isTeam = teamDocIds.has(doc.id);
    const isShared = sharedDocIds.has(doc.id);
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
          {isTeam && <Users className="h-2.5 w-2.5 text-muted-foreground" />}
          {isShared && <Share2 className="h-2.5 w-2.5 text-muted-foreground" />}
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
                onClick={(e) => {
                  e.stopPropagation();
                  const docCount = documents.filter(
                    (d) => d.folder === node.path || d.folder.startsWith(node.path + "/"),
                  ).length;
                  const msg = docCount > 0
                    ? `「${node.name}」とその中の ${docCount} 件のドキュメントを削除しますか？`
                    : `「${node.name}」を削除しますか？`;
                  if (confirm(msg)) deleteFolder(node.path);
                }}
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

  const renderTeamDoc = (td: { id: string; title: string; folder: string }, team: TeamWithDocs, depth: number) => {
    const localDoc = documents.find((d) => d.id === td.id);
    const title = localDoc?.title || td.title;
    const isOwnDoc = localDoc?.ownerId === user?.uid;
    return (
      <div key={td.id} style={{ paddingLeft: `${depth * 12}px` }}>
        <button
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", td.id);
            e.dataTransfer.setData("team-id", team.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => openTeamOrSharedDoc(td.id, team.id)}
          className={cn(
            "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
            activeDocId === td.id
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground hover:bg-sidebar-accent/50",
          )}
        >
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate">{title}</span>
          {!isOwnDoc && localDoc?.ownerId && (
            <span className="text-[9px] text-muted-foreground shrink-0" title="Created by another member">
              shared
            </span>
          )}
          <Trash2
            className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteTeamDoc(td.id, team);
            }}
          />
        </button>
      </div>
    );
  };

  const renderTeamFolder = (node: FolderNode, team: TeamWithDocs, allTeamDocs: { id: string; title: string; folder: string }[], depth = 0) => {
    const key = `${team.id}:${node.path}`;
    const isExpanded = expandedTeamFolders.has(key);
    const isRoot = node.path === "/";
    const hasContent = node.docs.length > 0 || node.children.length > 0;
    const isDragOver = dragOverTeamFolder === key;

    const toggleExpand = () => {
      setExpandedTeamFolders((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    };

    const handleTeamDrop = (e: React.DragEvent, folder: string) => {
      e.preventDefault();
      setDragOverTeamFolder(null);
      const docId = e.dataTransfer.getData("text/plain");
      const srcTeam = e.dataTransfer.getData("team-id");
      if (docId && srcTeam === team.id) {
        handleMoveTeamDoc(docId, folder);
      }
    };

    return (
      <div key={node.path}>
        {!isRoot && (
          <div
            className={cn(
              "group flex items-center gap-1 rounded-md px-2 py-1 text-xs text-sidebar-foreground hover:bg-sidebar-accent/50 cursor-pointer transition-colors",
              isDragOver && "bg-sidebar-accent/70 ring-1 ring-primary/30",
            )}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            onClick={toggleExpand}
            onDragOver={(e) => { e.preventDefault(); setDragOverTeamFolder(key); }}
            onDragLeave={() => setDragOverTeamFolder(null)}
            onDrop={(e) => handleTeamDrop(e, node.path)}
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
                onClick={(e) => { e.stopPropagation(); handleCreateTeamDoc(team, node.path); }}
              />
              <FolderPlus
                className="h-3 w-3 text-muted-foreground hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); setCreatingTeamFolderIn({ teamId: team.id, parent: node.path }); setNewTeamFolderName(""); }}
              />
              <Trash2
                className="h-3 w-3 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  const docCount = allTeamDocs.filter(
                    (d) => d.folder === node.path || d.folder.startsWith(node.path + "/"),
                  ).length;
                  const msg = docCount > 0
                    ? `「${node.name}」とその中の ${docCount} 件のドキュメントを削除しますか？`
                    : `「${node.name}」を削除しますか？`;
                  if (confirm(msg)) handleDeleteTeamFolder(team.id, node.path);
                }}
              />
            </div>
          </div>
        )}

        {creatingTeamFolderIn?.teamId === team.id && creatingTeamFolderIn?.parent === node.path && (
          <div className="flex items-center gap-1 px-2 py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
            <Folder className="h-3 w-3 text-muted-foreground shrink-0" />
            <input
              autoFocus
              className="flex-1 bg-transparent text-xs outline-none border-b border-input"
              placeholder="Folder name"
              value={newTeamFolderName}
              onChange={(e) => setNewTeamFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateTeamFolder(team.id, node.path);
                if (e.key === "Escape") setCreatingTeamFolderIn(null);
              }}
              onBlur={() => { if (newTeamFolderName.trim()) handleCreateTeamFolder(team.id, node.path); else setCreatingTeamFolderIn(null); }}
            />
          </div>
        )}

        {(isRoot || isExpanded) && (
          <>
            {node.children.map((child) => renderTeamFolder(child, team, allTeamDocs, isRoot ? depth : depth + 1))}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOverTeamFolder(key); }}
              onDragLeave={() => setDragOverTeamFolder(null)}
              onDrop={(e) => handleTeamDrop(e, node.path)}
            >
              {node.docs.map((doc) => {
                const td = allTeamDocs.find((d) => d.id === doc.id);
                if (!td) return null;
                return renderTeamDoc(td, team, isRoot ? depth : depth + 1);
              })}
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
    <div className="flex h-full w-full flex-col border-r border-border bg-sidebar-background">
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

      <div className="flex-1 px-1 overflow-y-auto">
        {/* ─── Search results ─── */}
        {isSearching ? (
          <div className="space-y-0.5 p-2">
            <p className="px-2 pb-1 text-[10px] text-muted-foreground">
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
            </p>
            {searchResults.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                No results
              </p>
            )}
            {searchResults.map(renderSearchMatch)}
          </div>
        ) : (
          <div>
            {/* ─── My Documents ─── */}
            <div className="px-1 pb-0">
              <div className="flex items-center justify-between">
                <button
                  className="flex flex-1 items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMyDocsExpanded((v) => !v)}
                >
                  {myDocsExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  <Lock className="h-3 w-3" />
                  <span className="font-medium">My Documents</span>
                  <span className="ml-auto text-[10px]">{personalDocs.length}</span>
                </button>
                <div className="flex gap-0.5 pr-2">
                  <Plus
                    className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={() => { handleNew(); setMyDocsExpanded(true); }}
                  />
                  <FolderPlus
                    className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={() => { setCreatingFolderIn("/"); setNewFolderName(""); setMyDocsExpanded(true); }}
                  />
                </div>
              </div>
              {myDocsExpanded && (
                <div className="space-y-0.5 pl-3">
                  {personalDocs.length === 0 && (
                    <p className="px-2 py-2 text-[10px] text-muted-foreground italic">
                      No documents yet
                    </p>
                  )}
                  {renderFolder(tree)}
                </div>
              )}
            </div>

            {/* ─── Teams ─── */}
            {user && (
              <>
                <Separator className="my-2" />
                <div className="px-1 pb-1">
                  <button
                    className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setTeamsExpanded((v) => !v)}
                  >
                    {teamsExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    <Users className="h-3 w-3" />
                    <span className="font-medium">Teams</span>
                    <span className="ml-auto text-[10px]">{teams.length}</span>
                  </button>
                  {teamsExpanded && (
                    <div className="space-y-0.5 pl-3">
                      {teams.length === 0 && (
                        <p className="px-2 py-2 text-[10px] text-muted-foreground italic">
                          No teams yet. Create one from Settings.
                        </p>
                      )}
                      {teams.map((team) => {
                        const isExpanded = expandedTeams.has(team.id);
                        // Merge: show Firestore docs + any locally-added docs not yet in Firestore list
                        const firestoreIds = new Set(team.docs.map((d) => d.id));
                        const localTeamDocs = documents.filter(
                          (d) => d.teamId === team.id && !firestoreIds.has(d.id),
                        );
                        const allTeamDocs: { id: string; title: string; folder: string }[] = [
                          ...team.docs,
                          ...localTeamDocs.map((d) => ({ id: d.id, title: d.title, folder: d.folder || "/" })),
                        ];
                        // Build folder tree for this team's docs
                        const teamFolders = ["/", ...(team.folders || [])];
                        const teamTree = buildTree(teamFolders, allTeamDocs.map((td) => {
                          const localDoc = documents.find((d) => d.id === td.id);
                          return {
                            id: td.id,
                            title: localDoc?.title || td.title,
                            content: localDoc?.content || "",
                            createdAt: localDoc?.createdAt || 0,
                            updatedAt: localDoc?.updatedAt || 0,
                            folder: td.folder || "/",
                            tags: localDoc?.tags || [],
                            ownerId: localDoc?.ownerId || null,
                          };
                        }));

                        return (
                          <div key={team.id}>
                            <div className="flex items-center">
                              <button
                                className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
                                onClick={() => setExpandedTeams((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(team.id)) next.delete(team.id);
                                  else next.add(team.id);
                                  return next;
                                })}
                              >
                                {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                <Users className="h-3 w-3 shrink-0" />
                                <span className="flex-1 truncate">{team.name || "(no name)"}</span>
                                <span className="text-[10px] text-muted-foreground">{allTeamDocs.length}</span>
                              </button>
                              <div className="flex gap-0.5 pr-1">
                                <Plus
                                  className="h-3 w-3 text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
                                  onClick={() => handleCreateTeamDoc(team)}
                                />
                                <FolderPlus
                                  className="h-3 w-3 text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
                                  onClick={() => { setCreatingTeamFolderIn({ teamId: team.id, parent: "/" }); setNewTeamFolderName(""); setExpandedTeams((prev) => new Set([...prev, team.id])); }}
                                />
                              </div>
                            </div>
                            {isExpanded && (
                              <div className="space-y-0.5 pl-3">
                                {allTeamDocs.length === 0 && (team.folders || []).length === 0 ? (
                                  <p className="text-[10px] text-muted-foreground italic px-2 py-1">No documents</p>
                                ) : (
                                  renderTeamFolder(teamTree, team, allTeamDocs)
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ─── Shared with me ─── */}
            {user && (
              <>
                <Separator className="my-2" />
                <div className="px-1 pb-1">
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
                    <div className="space-y-0.5 pl-3">
                      {sharedDocs.length === 0 && (
                        <p className="px-2 py-2 text-[10px] text-muted-foreground italic">
                          No shared documents yet.
                        </p>
                      )}
                      {sharedDocs.map((sd) => (
                        <button
                          key={sd.id}
                          onClick={() => openTeamOrSharedDoc(sd.id)}
                          className={cn(
                            "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
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
                          <span
                            className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive cursor-pointer"
                            title="Leave shared document"
                            role="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!user) return;
                              try {
                                await removeCollaborator(sd.id, { uid: user.uid, email: user.email || "", role: sd.role, addedAt: 0 });
                              } catch { /* ignore */ }
                              setSharedDocs((prev) => prev.filter((d) => d.id !== sd.id));
                              if (activeDocId === sd.id) setActiveDocId(null);
                            }}
                          >
                            <X className="h-3 w-3" />
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <Separator />
      <div className="px-3 py-2 text-[10px] text-muted-foreground">
        {personalDocs.length} doc{personalDocs.length !== 1 ? "s" : ""}
        {teams.length > 0 && ` / ${teams.length} team${teams.length !== 1 ? "s" : ""}`}
        {sharedDocs.length > 0 && ` / ${sharedDocs.length} shared`}
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
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-accent transition-colors"
              onClick={() => {
                const doc = documents.find((d) => d.id === contextMenu.docId);
                if (doc) {
                  setRenamingDocId(doc.id);
                  setRenameValue(doc.title);
                }
                setContextMenu(null);
              }}
            >
              <PenLine className="h-3 w-3 shrink-0" />
              Rename
            </button>
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
