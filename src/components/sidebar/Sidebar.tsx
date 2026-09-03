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
  Network,
  Pencil,
} from "lucide-react";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useIMEGuard } from "@/hooks/use-ime-guard";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useAppStore, type Document } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import {
  fetchSharedWithMe,
  fetchUserTeams,
  fetchTeamDocuments,
  createTeamDocument,
  removeCollaborator,
  getTeamFolders,
  setTeamFolders,
  moveTeamDocument,
  copyTeamDocToPersonal,
  moveDocToTeam,
  type Team,
} from "@/services/sharing";
import { fetchDocument } from "@/services/firebase";
import { track } from "@/services/telemetry";
import { isIOS, isMobile } from "@/platform";
import { friendlyErrorMessage } from "@/lib/friendly-error";

// ── Folder tree helpers ──────────────────────────────────────

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  docs: Document[];
}

function buildTree(folders: string[], docs: Document[]): FolderNode {
  const root: FolderNode = {
    name: "Documents",
    path: "/",
    children: [],
    docs: [],
  };
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
        const node: FolderNode = {
          name: part,
          path: currentPath,
          children: [],
          docs: [],
        };
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
  docs: { id: string; title: string; folder: string; updatedAt: number }[];
  folders: string[];
}

// ── Main component ───────────────────────────────────────────

export function Sidebar() {
  const {
    documents: allDocuments,
    activeDocId,
    setActiveDocId,
    addDocument,
    updateDocument,
    deleteDocument,
    toggleSidebar,
    folders,
    createFolder,
    deleteFolder,
    renameFolder,
    moveDocument,
  } = useAppStore();

  const [search, setSearch] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(["/"]),
  );
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [creatingFolderIn, setCreatingFolderIn] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const dragRef = useRef<{
    docId?: string;
    folderPath?: string;
    teamId?: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const dragHappenedRef = useRef(false);
  const [dragIndicator, setDragIndicator] = useState<{
    docId: string;
    x: number;
    y: number;
  } | null>(null);
  const moveDocRef = useRef(moveDocument);
  moveDocRef.current = moveDocument;
  const moveTeamDocFnRef = useRef<(docId: string, folder: string) => void>(
    () => {},
  );
  const crossCopyRef = useRef<(docId: string, folder: string) => void>(
    () => {},
  );
  const crossMoveToTeamRef = useRef<
    (docId: string, teamId: string, folder: string) => void
  >(() => {});
  const [contextMenu, setContextMenu] = useState<{
    docId: string;
    x: number;
    y: number;
  } | null>(null);
  const [renamingDocId, setRenamingDocId] = useState<string | null>(null);
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(
    null,
  );
  const [renameFolderValue, setRenameFolderValue] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const ime = useIMEGuard();

  // Shared with me
  const user = useAuthStore((s) => s.user);

  // Fail-closed UI barrier: never render a PRIVATE document owned by another
  // account, regardless of what slipped into the store (an in-flight sync
  // reviving a row after an account-switch wipe, a cold start that loaded the
  // previous account's SQLite rows before auth resolved, or a switch-purge
  // skipped on iOS when getSetting/wipe threw). Own docs (ownerId === uid),
  // unclaimed offline docs (ownerId null), and shared/team docs are unaffected.
  const documents = useMemo(
    () =>
      allDocuments.filter(
        (d) =>
          !(d.ownerId && d.ownerId !== user?.uid && !d.isShared && !d.teamId),
      ),
    [allDocuments, user?.uid],
  );

  const [sharedDocs, setSharedDocs] = useState<
    { id: string; title: string; role: "editor" | "viewer" }[]
  >([]);
  const [sharedExpanded, setSharedExpanded] = useState(true);
  const [teamsLoaded, setTeamsLoaded] = useState(!user);

  // My Documents collapsible
  const [myDocsExpanded, setMyDocsExpanded] = useState(true);

  // Teams
  const [teams, setTeams] = useState<TeamWithDocs[]>([]);
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());
  const [teamsExpanded, setTeamsExpanded] = useState(true);
  const teamsRefreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [expandedTeamFolders, setExpandedTeamFolders] = useState<Set<string>>(
    new Set(),
  );
  const [creatingTeamFolderIn, setCreatingTeamFolderIn] = useState<{
    teamId: string;
    parent: string;
  } | null>(null);
  const [newTeamFolderName, setNewTeamFolderName] = useState("");
  const [dragOverTeamFolder, setDragOverTeamFolder] = useState<string | null>(
    null,
  );

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
      // Account may have switched while we were fetching — dropping stale
      // results here prevents the previous account's team docs from repopulating
      // the sidebar after a switch (data-isolation guard).
      if (useAuthStore.getState().user?.uid !== uid) return;
      setTeams(teamsWithDocs);
      // Auto-expand if there's only one team
      if (teamsWithDocs.length === 1) {
        setExpandedTeams(new Set([teamsWithDocs[0].id]));
      }
      // Sync team doc titles to app-store so Editor toolbar reflects renames.
      // Only update titles for non-owned docs — the owner's local title is
      // authoritative and will be pushed to Firestore via syncToCloud.
      // Overwriting owned docs here causes a race condition where a stale
      // Firestore title ("Untitled") reverts a local rename.
      const appStore = useAppStore.getState();
      for (const team of teamsWithDocs) {
        for (const td of team.docs) {
          const local = appStore.documents.find((d) => d.id === td.id);
          if (local && local.title !== td.title && local.ownerId !== uid) {
            // Only update title if cloud version is newer than local
            if (td.updatedAt > (local.updatedAt ?? 0)) {
              appStore.updateDocument(td.id, {
                title: td.title,
                titlePinned: true,
              });
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setSharedDocs([]);
      setTeams([]);
      setTeamsLoaded(true);
      return;
    }
    const uid = user.uid;
    // Clear the previous account's shared/team lists IMMEDIATELY on switch so a
    // slow fetch for the new account can't leave the old account's shared docs
    // visible in the meantime (data-isolation guard).
    setSharedDocs([]);
    setTeams([]);
    setTeamsLoaded(false);
    // Only apply async results if this account is still the signed-in one.
    const applyShared = (docs: typeof sharedDocs) => {
      if (useAuthStore.getState().user?.uid === uid) setSharedDocs(docs);
    };
    Promise.all([
      fetchSharedWithMe(uid)
        .then(applyShared)
        .catch(() => {}),
      refreshTeams(uid),
    ]).then(() => {
      if (useAuthStore.getState().user?.uid === uid) setTeamsLoaded(true);
    });

    // Poll every 15s to pick up changes from other members
    teamsRefreshTimer.current = setInterval(() => {
      refreshTeams(uid);
      fetchSharedWithMe(uid)
        .then(applyShared)
        .catch(() => {});
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

  // Personal docs: exclude team docs and docs shared with me (that I don't own).
  // While teams are loading, also exclude docs with teamId to prevent flash.
  const personalDocs = useMemo(
    () =>
      documents.filter((d) => {
        if (teamDocIds.has(d.id) || sharedDocIds.has(d.id)) return false;
        if (!teamsLoaded && d.teamId) return false;
        return true;
      }),
    [documents, teamDocIds, sharedDocIds, teamsLoaded],
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

  // Exclude team folder paths from personal folder list
  const personalFolders = useMemo(() => {
    const teamFolderPaths = new Set<string>();
    for (const team of teams) {
      for (const f of team.folders || []) teamFolderPaths.add(f);
    }
    return folders.filter((f) => !teamFolderPaths.has(f));
  }, [folders, teams]);

  // When a tag filter is active, collect every folder that holds a matching doc
  // plus its ancestor chain. Used to (a) hide folders with no matches and
  // (b) auto-expand the ones that do, so matching docs buried in collapsed
  // subfolders actually surface. Null when no filter is active.
  const tagFolderPaths = useMemo(() => {
    if (!selectedTag) return null;
    const paths = new Set<string>(["/"]);
    for (const doc of filteredDocs) {
      const folder = doc.folder || "/";
      if (folder === "/") continue;
      const parts = folder.split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) {
        cur += "/" + part;
        paths.add(cur);
      }
    }
    return paths;
  }, [selectedTag, filteredDocs]);

  const tree = useMemo(() => {
    const treeFolders = tagFolderPaths
      ? personalFolders.filter((f) => tagFolderPaths.has(f))
      : personalFolders;
    return buildTree(treeFolders, filteredDocs);
  }, [personalFolders, filteredDocs, tagFolderPaths]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleNew = (
    folder = "/",
    docType: "markdown" | "mindmap" = "markdown",
  ) => {
    const isMindMap = docType === "mindmap";
    const title = isMindMap ? "New Mind Map" : "Untitled";
    const content = isMindMap
      ? JSON.stringify({ nodes: [{ id: "root", label: title, children: [] }] })
      : "# Untitled\n";
    const authUser = useAuthStore.getState().user;
    const doc: Document = {
      id: crypto.randomUUID(),
      title,
      content,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      folder,
      tags: [],
      ownerId: authUser?.uid ?? null,
      docType,
    };
    addDocument(doc);
    track("doc_create", { docType, source: "sidebar" });
    setActiveDocId(doc.id);
    setExpandedFolders((prev) => new Set([...prev, folder]));
    if (authUser) {
      import("@/services/firebase")
        .then(({ saveDocumentToFirestore }) => {
          saveDocumentToFirestore({
            id: doc.id,
            title: doc.title,
            content: doc.content,
            ownerId: authUser.uid,
            ownerName: authUser.displayName || authUser.email || undefined,
            folder: doc.folder,
            tags: doc.tags,
            updatedAt: doc.updatedAt,
          }).catch((err) => console.error("[new] Cloud upload failed:", err));
        })
        .catch(() => {});
    }
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

  const handleCreateTeamDoc = async (team: TeamWithDocs, folder = "/") => {
    if (!user) return;
    const newDocId = await createTeamDocument(
      team.id,
      user.uid,
      user.displayName || user.email || undefined,
    );
    // Update folder in Firestore if not root
    if (folder !== "/") {
      await moveTeamDocument(newDocId, folder).catch(console.error);
    }
    const newDoc: Document = {
      id: newDocId,
      title: "Untitled",
      content: "",
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
    // No need to manually update teams state here — the merge logic at render
    // time (localTeamDocs) will pick up the new doc from app-store documents.
    // Manually adding to team.docs causes duplicates when refreshTeams polls.
  };

  const handleDeleteTeamDoc = async (docId: string, team: TeamWithDocs) => {
    // deleteDocument handles both local removal and cloud deletion (via deleteFromCloud)
    await deleteDocument(docId);
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
    setTeams((prev) =>
      prev.map((t) => (t.id === teamId ? { ...t, folders: updated } : t)),
    );
    setExpandedTeamFolders(
      (prev) =>
        new Set([...prev, `${teamId}:${parentPath}`, `${teamId}:${path}`]),
    );
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
    setTeams((prev) =>
      prev.map((t) => (t.id === teamId ? { ...t, folders: updated } : t)),
    );
  };

  const handleMoveTeamDoc = async (docId: string, folder: string) => {
    await moveTeamDocument(docId, folder).catch(console.error);
    // Update local state
    setTeams((prev) =>
      prev.map((t) => ({
        ...t,
        docs: t.docs.map((d) => (d.id === docId ? { ...d, folder } : d)),
      })),
    );
    // Also update local document store if loaded
    const existing = documents.find((d) => d.id === docId);
    if (existing) {
      updateDocument(docId, { folder, updatedAt: Date.now() });
    }
  };
  moveTeamDocFnRef.current = handleMoveTeamDoc;

  // Cross-section: Team doc → Personal (copy)
  const handleCopyTeamDocToPersonal = async (docId: string, folder: string) => {
    if (!user) return;
    try {
      const result = await copyTeamDocToPersonal(docId, user.uid, folder);
      addDocument({
        id: result.id,
        title: result.title,
        content: result.content,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        folder,
        tags: [],
        ownerId: user.uid,
      });
      setActiveDocId(result.id);
    } catch (err) {
      console.error("Failed to copy team doc:", err);
    }
  };
  crossCopyRef.current = handleCopyTeamDocToPersonal;

  // Cross-section: Personal doc → Team (move)
  const handleMoveDocToTeam = async (
    docId: string,
    teamId: string,
    folder: string,
  ) => {
    try {
      // The doc may be a personal doc that was never synced to Firestore.
      // moveDocToTeam merges {teamId,folder}, but Firestore rules reject a
      // partial create with no ownerId — so ensure the full doc exists first.
      const localDocToMove = documents.find((d) => d.id === docId);
      const authUser = useAuthStore.getState().user;
      if (localDocToMove && authUser) {
        const { saveDocumentToFirestore } = await import("@/services/firebase");
        await saveDocumentToFirestore({
          id: localDocToMove.id,
          title: localDocToMove.title,
          content: localDocToMove.content,
          ownerId: authUser.uid,
          ownerName: authUser.displayName || authUser.email || undefined,
          folder,
          tags: localDocToMove.tags,
          titlePinned: localDocToMove.titlePinned,
          updatedAt: localDocToMove.updatedAt,
        });
      }
      await moveDocToTeam(docId, teamId, folder);
      // Update local store
      updateDocument(docId, {
        teamId,
        folder,
        isShared: true,
        updatedAt: Date.now(),
      });
      // Add to team docs list
      const localDoc = documents.find((d) => d.id === docId);
      setTeams((prev) =>
        prev.map((t) =>
          t.id === teamId
            ? {
                ...t,
                docs: [
                  ...t.docs,
                  {
                    id: docId,
                    title: localDoc?.title || "Untitled",
                    folder,
                    updatedAt: Date.now(),
                  },
                ],
              }
            : t,
        ),
      );
    } catch (err) {
      console.error("Failed to move doc to team:", err);
      window.alert(
        `チームへの移動に失敗しました。${friendlyErrorMessage(err, "team")}`,
      );
    }
  };
  crossMoveToTeamRef.current = handleMoveDocToTeam;

  const openTeamOrSharedDoc = async (docIdToOpen: string, teamId?: string) => {
    const existing = documents.find((d) => d.id === docIdToOpen);
    if (existing) {
      // Ensure team/shared docs have isShared flag for yCollab activation
      if (!existing.isShared && (teamId || existing.teamId)) {
        updateDocument(docIdToOpen, {
          isShared: true,
          teamId: teamId || existing.teamId,
        });
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
    if (!trimmed) {
      updateDocument(docId, { titlePinned: false, updatedAt: Date.now() });
    } else if (trimmed !== documents.find((d) => d.id === docId)?.title) {
      updateDocument(docId, {
        title: trimmed,
        titlePinned: true,
        updatedAt: Date.now(),
      });
    }
    setRenamingDocId(null);
  };

  const commitFolderRename = (oldPath: string) => {
    const newName = renameFolderValue.trim();
    if (!newName || /[/\\]/.test(newName)) {
      setRenamingFolderPath(null);
      return;
    }
    const parent = oldPath.substring(0, oldPath.lastIndexOf("/")) || "";
    const newPath = parent ? `${parent}/${newName}` : `/${newName}`;
    if (newPath !== oldPath) {
      renameFolder(oldPath, newPath);
    }
    setRenamingFolderPath(null);
  };

  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");

  // ── Context menu open helper ────────────────────────────────
  const openContextMenu = (
    docId: string,
    e: React.MouseEvent | React.PointerEvent,
  ) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const menuHeight = 120;
    const y =
      rect.top + menuHeight > window.innerHeight
        ? Math.max(4, window.innerHeight - menuHeight - 4)
        : rect.top;
    setContextMenu({ docId, x: rect.right, y });
  };

  // ── Shared doc row trigger (⋮ button) ─────────────────────
  const menuTrigger = (docId: string) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (contextMenu?.docId === docId) {
          setContextMenu(null);
        } else {
          openContextMenu(docId, e);
        }
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      style={{
        background: "none",
        border: "none",
        padding: isMobile ? "4px 8px" : "0 2px",
        margin: 0,
        cursor: "pointer",
        flexShrink: 0,
        fontSize: isMobile ? 18 : 14,
        lineHeight: 1,
        color: "var(--muted-foreground, #888)",
        minWidth: isMobile ? 32 : undefined,
        minHeight: isMobile ? 32 : undefined,
        // Keep the 32px touch target but don't let it stretch the row. The
        // text-xs row box is 16px; a 32px control adds +16px unless we bleed
        // the extra into negative margins (same trick as the header's -my-1
        // buttons). This is what makes mobile doc rows match the desktop 28px.
        marginTop: isMobile ? -8 : undefined,
        marginBottom: isMobile ? -8 : undefined,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      ⋮
    </button>
  );

  const renderDoc = (doc: Document) => (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button === 2) {
          e.preventDefault();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const menuH = 120;
          const cy =
            rect.top + menuH > window.innerHeight
              ? Math.max(4, window.innerHeight - menuH - 4)
              : rect.top;
          setContextMenu({ docId: doc.id, x: e.clientX, y: cy });
        } else if (
          e.button === 0 &&
          !e.ctrlKey &&
          !isIOS &&
          renamingDocId !== doc.id
        ) {
          dragRef.current = {
            docId: doc.id,
            startX: e.clientX,
            startY: e.clientY,
            active: false,
          };
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (!dragHappenedRef.current) setActiveDocId(doc.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") setActiveDocId(doc.id);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        setRenamingDocId(doc.id);
        setRenameValue(doc.title);
      }}
      className={cn(
        "group flex w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs transition-colors cursor-pointer",
        isMobile ? "pl-3 py-2" : "pl-2.5 py-1.5",
        activeDocId === doc.id
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
      )}
    >
      {doc.docType === "mindmap" ? (
        <Network
          className={isMobile ? "h-4 w-4 shrink-0" : "h-3.5 w-3.5 shrink-0"}
        />
      ) : (
        <FileText
          className={isMobile ? "h-4 w-4 shrink-0" : "h-3.5 w-3.5 shrink-0"}
        />
      )}
      {renamingDocId === doc.id ? (
        <input
          autoFocus
          className="flex-1 min-w-0 bg-transparent border-b border-primary outline-none text-xs"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onBlur={() => commitRename(doc.id)}
          onKeyDown={(e) => {
            if (ime.isComposing()) return;
            if (e.key === "Enter") commitRename(doc.id);
            if (e.key === "Escape") setRenamingDocId(null);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 truncate">{doc.title}</span>
      )}
      {doc.isShared && (
        <span title="Shared">
          <Share2 className="h-3 w-3 shrink-0 text-muted-foreground" />
        </span>
      )}
      {doc.tags.length > 0 && (
        <span className="text-[9px] text-muted-foreground shrink-0">
          {doc.tags.length}
          <Tag className="inline h-2 w-2 ml-0.5" />
        </span>
      )}
      {menuTrigger(doc.id)}
    </div>
  );

  const renderSearchMatch = (doc: Document) => {
    const q = search.toLowerCase();
    const contentMatch = doc.content.toLowerCase().indexOf(q);
    let snippet = "";
    if (contentMatch >= 0) {
      const start = Math.max(0, contentMatch - 30);
      const end = Math.min(
        doc.content.length,
        contentMatch + search.length + 30,
      );
      snippet =
        (start > 0 ? "..." : "") +
        doc.content.slice(start, end) +
        (end < doc.content.length ? "..." : "");
    }
    // Determine which section this doc belongs to
    const isTeam = teamDocIds.has(doc.id);
    const isShared = sharedDocIds.has(doc.id);
    return (
      <button
        key={doc.id}
        onClick={() => setActiveDocId(doc.id)}
        className={cn(
          "group flex w-full flex-col gap-0.5 rounded-md px-2 text-left text-xs transition-colors",
          isMobile ? "py-1" : "py-1.5",
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
    // Auto-expand folders that contain a tag match (without mutating the user's
    // manual expand state — this only holds while the filter is active).
    const isExpanded =
      expandedFolders.has(node.path) ||
      (tagFolderPaths?.has(node.path) ?? false);
    const isRoot = node.path === "/";
    const hasContent = node.docs.length > 0 || node.children.length > 0;
    const isDragOver = dragOverFolder === node.path;

    return (
      <div key={node.path}>
        {/* Folder header */}
        {!isRoot && (
          <div
            data-folder-path={node.path}
            className={cn(
              // Match the document row's box (w-full + pr-2 + py-1.5) so folders
              // and docs share the SAME width AND vertical rhythm on mobile.
              // Unified with the comfortable doc-to-doc spacing across every row
              // type (docs/folders/teams/shared) per owner request. Mobile gets a
              // touch more breathing room (py-2) to match the doc rows.
              "group flex w-full items-center gap-1.5 rounded-md pr-2 py-1.5 text-xs text-sidebar-foreground hover:bg-sidebar-accent/50 cursor-pointer transition-colors",
              isMobile && "py-2",
              isDragOver && "bg-sidebar-accent/70 ring-1 ring-primary/30",
            )}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            onClick={() => {
              if (renamingFolderPath !== node.path) toggleFolder(node.path);
            }}
            onPointerDown={(e) => {
              if (
                e.button === 0 &&
                !isIOS &&
                renamingFolderPath !== node.path
              ) {
                dragRef.current = {
                  folderPath: node.path,
                  startX: e.clientX,
                  startY: e.clientY,
                  active: false,
                };
              }
            }}
            onDoubleClick={(e) => {
              e.preventDefault();
              setRenamingFolderPath(node.path);
              setRenameFolderValue(node.name);
            }}
          >
            {isExpanded ? (
              <ChevronDown
                className={cn(
                  "shrink-0 text-muted-foreground",
                  isMobile ? "h-3.5 w-3.5" : "h-3 w-3",
                )}
              />
            ) : (
              <ChevronRight
                className={cn(
                  "shrink-0 text-muted-foreground",
                  isMobile ? "h-3.5 w-3.5" : "h-3 w-3",
                )}
              />
            )}
            {isExpanded ? (
              <FolderOpen
                className={cn(
                  "shrink-0 text-muted-foreground",
                  isMobile ? "h-4 w-4" : "h-3.5 w-3.5",
                )}
              />
            ) : (
              <Folder
                className={cn(
                  "shrink-0 text-muted-foreground",
                  isMobile ? "h-4 w-4" : "h-3.5 w-3.5",
                )}
              />
            )}
            {renamingFolderPath === node.path ? (
              <input
                autoFocus
                className="flex-1 min-w-0 bg-transparent border-b border-primary outline-none text-xs"
                value={renameFolderValue}
                onChange={(e) => setRenameFolderValue(e.target.value)}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
                onBlur={() => commitFolderRename(node.path)}
                onKeyDown={(e) => {
                  if (ime.isComposing()) return;
                  if (e.key === "Enter") commitFolderRename(node.path);
                  if (e.key === "Escape") setRenamingFolderPath(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="flex-1 truncate">{node.name}</span>
            )}
            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
              <Pencil
                className="h-3 w-3 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenamingFolderPath(node.path);
                  setRenameFolderValue(node.name);
                }}
              />
              <Plus
                className="h-3 w-3 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  handleNew(node.path);
                }}
              />
              <FolderPlus
                className="h-3 w-3 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setCreatingFolderIn(node.path);
                  setNewFolderName("");
                }}
              />
              <Trash2
                className="h-3 w-3 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  const docCount = documents.filter(
                    (d) =>
                      d.folder === node.path ||
                      d.folder.startsWith(node.path + "/"),
                  ).length;
                  const msg =
                    docCount > 0
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
          <div
            className="flex items-center gap-1 px-2 py-1"
            style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
          >
            <Folder className="h-3 w-3 text-muted-foreground shrink-0" />
            <input
              autoFocus
              className="flex-1 bg-transparent text-xs outline-none border-b border-input"
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              onKeyDown={(e) => {
                if (ime.isComposing()) return;
                if (e.key === "Enter") handleCreateFolder(node.path);
                if (e.key === "Escape") setCreatingFolderIn(null);
              }}
              onBlur={() => {
                if (newFolderName.trim()) handleCreateFolder(node.path);
                else setCreatingFolderIn(null);
              }}
            />
          </div>
        )}

        {/* Children */}
        {(isRoot || isExpanded) && (
          <>
            {node.children.map((child) =>
              renderFolder(child, isRoot ? depth : depth + 1),
            )}
            <div data-folder-path={node.path}>
              {node.docs.map((doc) => (
                <div
                  key={doc.id}
                  style={{
                    paddingLeft: `${(isRoot ? depth : depth + 1) * 12 + 16}px`,
                  }}
                >
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

  const renderTeamDoc = (
    td: { id: string; title: string; folder: string; updatedAt: number },
    team: TeamWithDocs,
    depth: number,
  ) => {
    const localDoc = documents.find((d) => d.id === td.id);
    const title = localDoc?.title || td.title;
    const isOwnDoc = localDoc?.ownerId === user?.uid;
    return (
      <div key={td.id} style={{ paddingLeft: `${depth * 12 + 16}px` }}>
        <div
          role="button"
          tabIndex={0}
          onPointerDown={(e) => {
            if (e.button === 2) {
              e.preventDefault();
              const rect = (
                e.currentTarget as HTMLElement
              ).getBoundingClientRect();
              const menuH = 120;
              const cy =
                rect.top + menuH > window.innerHeight
                  ? Math.max(4, window.innerHeight - menuH - 4)
                  : rect.top;
              setContextMenu({ docId: td.id, x: e.clientX, y: cy });
            } else if (
              e.button === 0 &&
              !e.ctrlKey &&
              !isIOS &&
              renamingDocId !== td.id
            ) {
              dragRef.current = {
                docId: td.id,
                teamId: team.id,
                startX: e.clientX,
                startY: e.clientY,
                active: false,
              };
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
          onClick={() => {
            if (!dragHappenedRef.current) openTeamOrSharedDoc(td.id, team.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ")
              openTeamOrSharedDoc(td.id, team.id);
          }}
          onDoubleClick={(e) => {
            e.preventDefault();
            setRenamingDocId(td.id);
            setRenameValue(title);
          }}
          className={cn(
            "group flex w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs transition-colors cursor-pointer",
            isMobile ? "pl-3 py-2" : "pl-2.5 py-1.5",
            activeDocId === td.id
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground hover:bg-sidebar-accent/50",
          )}
        >
          <FileText
            className={cn("shrink-0", isMobile ? "h-4 w-4" : "h-3.5 w-3.5")}
          />
          {renamingDocId === td.id ? (
            <input
              autoFocus
              className="flex-1 min-w-0 bg-transparent border-b border-primary outline-none text-xs"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              onBlur={() => commitRename(td.id)}
              onKeyDown={(e) => {
                if (ime.isComposing()) return;
                if (e.key === "Enter") commitRename(td.id);
                if (e.key === "Escape") setRenamingDocId(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="flex-1 truncate">{title}</span>
          )}
          {!isOwnDoc && localDoc?.ownerId && (
            <span
              className="shrink-0"
              title="Created by another member"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                padding: "1px 5px",
                borderRadius: 9999,
                fontSize: 9,
                opacity: 0.6,
                background: isDark
                  ? "rgba(255,255,255,0.08)"
                  : "rgba(0,0,0,0.05)",
                color: isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.4)",
              }}
            >
              <Users style={{ width: 8, height: 8 }} />
            </span>
          )}
          {menuTrigger(td.id)}
        </div>
      </div>
    );
  };

  const renderTeamFolder = (
    node: FolderNode,
    team: TeamWithDocs,
    allTeamDocs: {
      id: string;
      title: string;
      folder: string;
      updatedAt: number;
    }[],
    depth = 0,
  ) => {
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

    return (
      <div key={node.path}>
        {!isRoot && (
          <div
            data-folder-path={node.path}
            data-team-id={team.id}
            className={cn(
              // Same box as document rows (see personal folder header) so team
              // folders and docs line up at the same width AND padding on mobile
              // — unified with the comfortable doc-to-doc spacing (py-2 mobile).
              "group flex w-full items-center gap-1.5 rounded-md pr-2 py-1.5 text-xs text-sidebar-foreground hover:bg-sidebar-accent/50 cursor-pointer transition-colors",
              isMobile && "py-2",
              isDragOver && "bg-sidebar-accent/70 ring-1 ring-primary/30",
            )}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            onClick={toggleExpand}
          >
            {isExpanded ? (
              <ChevronDown
                className={cn(
                  "shrink-0 text-muted-foreground",
                  isMobile ? "h-3.5 w-3.5" : "h-3 w-3",
                )}
              />
            ) : (
              <ChevronRight
                className={cn(
                  "shrink-0 text-muted-foreground",
                  isMobile ? "h-3.5 w-3.5" : "h-3 w-3",
                )}
              />
            )}
            {isExpanded ? (
              <FolderOpen
                className={cn(
                  "shrink-0 text-muted-foreground",
                  isMobile ? "h-4 w-4" : "h-3.5 w-3.5",
                )}
              />
            ) : (
              <Folder
                className={cn(
                  "shrink-0 text-muted-foreground",
                  isMobile ? "h-4 w-4" : "h-3.5 w-3.5",
                )}
              />
            )}
            <span className="flex-1 truncate">{node.name}</span>
            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
              <Plus
                className="h-3 w-3 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCreateTeamDoc(team, node.path);
                }}
              />
              <FolderPlus
                className="h-3 w-3 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setCreatingTeamFolderIn({
                    teamId: team.id,
                    parent: node.path,
                  });
                  setNewTeamFolderName("");
                }}
              />
              <Trash2
                className="h-3 w-3 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  const docCount = allTeamDocs.filter(
                    (d) =>
                      d.folder === node.path ||
                      d.folder.startsWith(node.path + "/"),
                  ).length;
                  const msg =
                    docCount > 0
                      ? `「${node.name}」とその中の ${docCount} 件のドキュメントを削除しますか？`
                      : `「${node.name}」を削除しますか？`;
                  if (confirm(msg)) handleDeleteTeamFolder(team.id, node.path);
                }}
              />
            </div>
          </div>
        )}

        {creatingTeamFolderIn?.teamId === team.id &&
          creatingTeamFolderIn?.parent === node.path && (
            <div
              className="flex items-center gap-1 px-2 py-1"
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
            >
              <Folder className="h-3 w-3 text-muted-foreground shrink-0" />
              <input
                autoFocus
                className="flex-1 bg-transparent text-xs outline-none border-b border-input"
                placeholder="Folder name"
                value={newTeamFolderName}
                onChange={(e) => setNewTeamFolderName(e.target.value)}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
                onKeyDown={(e) => {
                  if (ime.isComposing()) return;
                  if (e.key === "Enter")
                    handleCreateTeamFolder(team.id, node.path);
                  if (e.key === "Escape") setCreatingTeamFolderIn(null);
                }}
                onBlur={() => {
                  if (newTeamFolderName.trim())
                    handleCreateTeamFolder(team.id, node.path);
                  else setCreatingTeamFolderIn(null);
                }}
              />
            </div>
          )}

        {(isRoot || isExpanded) && (
          <>
            {node.children.map((child) =>
              renderTeamFolder(
                child,
                team,
                allTeamDocs,
                isRoot ? depth : depth + 1,
              ),
            )}
            <div data-folder-path={node.path} data-team-id={team.id}>
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

  // Dismiss handled by inline backdrop rendered in renderDoc

  // Pointer-based drag & drop (replaces HTML5 drag API for WKWebView compatibility)
  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const { startX, startY } = dragRef.current;
      const dist = Math.sqrt(
        (e.clientX - startX) ** 2 + (e.clientY - startY) ** 2,
      );
      if (!dragRef.current.active && dist > 5) {
        dragRef.current.active = true;
      }
      if (dragRef.current.active) {
        const label =
          dragRef.current.docId ||
          dragRef.current.folderPath?.split("/").pop() ||
          "";
        setDragIndicator({ docId: label, x: e.clientX, y: e.clientY });
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const folderEl = (el as HTMLElement)?.closest?.(
          "[data-folder-path]",
        ) as HTMLElement | null;
        const fp = folderEl?.dataset.folderPath || null;
        const tid = folderEl?.dataset.teamId;
        if (tid && fp) {
          setDragOverTeamFolder(`${tid}:${fp}`);
          setDragOverFolder(null);
        } else if (fp) {
          setDragOverFolder(fp);
          setDragOverTeamFolder(null);
        } else {
          setDragOverFolder(null);
          setDragOverTeamFolder(null);
        }
      }
    };

    const handleUp = (e: PointerEvent) => {
      if (dragRef.current?.active) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const folderEl = (el as HTMLElement)?.closest?.(
          "[data-folder-path]",
        ) as HTMLElement | null;
        const targetFolder = folderEl?.dataset.folderPath;
        const targetTeamId = folderEl?.dataset.teamId;

        if (dragRef.current.folderPath && targetFolder) {
          // Folder → Folder: move folder into target
          const srcPath = dragRef.current.folderPath;
          if (
            srcPath !== targetFolder &&
            !targetFolder.startsWith(srcPath + "/")
          ) {
            const folderName = srcPath.split("/").pop() || "";
            const newPath =
              targetFolder === "/"
                ? `/${folderName}`
                : `${targetFolder}/${folderName}`;
            if (newPath !== srcPath) {
              const { renameFolder: rf } = useAppStore.getState();
              rf(srcPath, newPath);
            }
          }
        } else if (dragRef.current.docId && targetFolder) {
          const srcTeamId = dragRef.current.teamId;
          const docId = dragRef.current.docId;
          if (srcTeamId && targetTeamId) {
            moveTeamDocFnRef.current(docId, targetFolder);
          } else if (!srcTeamId && !targetTeamId) {
            moveDocRef.current(docId, targetFolder);
          } else if (srcTeamId && !targetTeamId) {
            crossCopyRef.current(docId, targetFolder);
          } else if (!srcTeamId && targetTeamId) {
            crossMoveToTeamRef.current(docId, targetTeamId, targetFolder);
          }
        }
        dragHappenedRef.current = true;
        setTimeout(() => {
          dragHappenedRef.current = false;
        }, 100);
      }
      dragRef.current = null;
      setDragIndicator(null);
      setDragOverFolder(null);
      setDragOverTeamFolder(null);
    };

    // pointercancel fires instead of pointerup on OS interruption — ABORT the
    // drag (reset state only, never perform the drop) so a canceled gesture
    // doesn't leave a stuck drag indicator or fire an unintended move.
    const handleCancel = () => {
      dragRef.current = null;
      setDragIndicator(null);
      setDragOverFolder(null);
      setDragOverTeamFolder(null);
    };

    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
    document.addEventListener("pointercancel", handleCancel);
    return () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.removeEventListener("pointercancel", handleCancel);
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col border-r border-border bg-sidebar-background">
      {/* Header. On mobile the sidebar is a drawer — it closes by tapping the
          backdrop, swiping, or the hardware back button — so the explicit close
          button is redundant clutter and is shown on desktop only (where it is
          the collapse control). */}
      <div className="flex items-center justify-between px-3 pt-2 pb-2">
        <span className="text-sm font-semibold text-sidebar-foreground tracking-wide">
          MarkFlow
        </span>
        {!isMobile && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-sidebar-foreground"
            onClick={toggleSidebar}
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div
          className={cn(
            "flex items-center gap-2 rounded-md bg-sidebar-accent px-2",
            isMobile ? "py-1" : "py-1.5",
          )}
        >
          <Search
            className={
              isMobile
                ? "h-4.5 w-4.5 text-muted-foreground"
                : "h-3.5 w-3.5 text-muted-foreground"
            }
          />
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
              {searchResults.length} result
              {searchResults.length !== 1 ? "s" : ""}
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
                  className={cn(
                    "flex flex-1 items-center gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground transition-colors",
                    isMobile ? "py-1" : "py-1.5",
                  )}
                  onClick={() => setMyDocsExpanded((v) => !v)}
                >
                  {myDocsExpanded ? (
                    <ChevronDown
                      className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"}
                    />
                  ) : (
                    <ChevronRight
                      className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"}
                    />
                  )}
                  <Lock className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"} />
                  <span className="font-medium">My Documents</span>
                  <span className="ml-auto text-[10px]">
                    {personalDocs.length}
                  </span>
                </button>
                <div
                  className={cn("flex pr-2", isMobile ? "gap-1" : "gap-0.5")}
                >
                  <span
                    title="New document"
                    className={
                      isMobile
                        ? "flex items-center justify-center rounded-md p-1.5 -my-1 active:bg-accent"
                        : ""
                    }
                    onClick={() => {
                      handleNew();
                      setMyDocsExpanded(true);
                    }}
                  >
                    <Plus
                      className={cn(
                        "text-muted-foreground hover:text-foreground cursor-pointer",
                        isMobile ? "h-5 w-5" : "h-3.5 w-3.5",
                      )}
                    />
                  </span>
                  {/* Standalone mind-map creation is hidden until the
                      dedicated MindMapEditor is refined. Existing standalone
                      mind-map docs still open; only the entry point is gated.
                      Re-enable by restoring this <span title="New mind map">. */}
                  <span
                    title="New folder"
                    className={
                      isMobile
                        ? "flex items-center justify-center rounded-md p-1.5 -my-1 active:bg-accent"
                        : ""
                    }
                    onClick={() => {
                      setCreatingFolderIn("/");
                      setNewFolderName("");
                      setMyDocsExpanded(true);
                    }}
                  >
                    <FolderPlus
                      className={cn(
                        "text-muted-foreground hover:text-foreground cursor-pointer",
                        isMobile ? "h-5 w-5" : "h-3.5 w-3.5",
                      )}
                    />
                  </span>
                </div>
              </div>
              {myDocsExpanded && (
                <div className="space-y-0.5 pl-3">
                  {user && !teamsLoaded ? null : personalDocs.length === 0 ? (
                    <p className="px-2 py-2 text-[10px] text-muted-foreground italic">
                      No documents yet
                    </p>
                  ) : (
                    renderFolder(tree)
                  )}
                </div>
              )}
            </div>

            {/* ─── Teams ─── */}
            {user && (
              <>
                <Separator className="my-2" />
                <div className="px-1 pb-1">
                  <button
                    className={cn(
                      "flex w-full items-center gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground transition-colors",
                      isMobile ? "py-1" : "py-1.5",
                    )}
                    onClick={() => setTeamsExpanded((v) => !v)}
                  >
                    {teamsExpanded ? (
                      <ChevronDown
                        className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"}
                      />
                    ) : (
                      <ChevronRight
                        className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"}
                      />
                    )}
                    <Users className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"} />
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
                        const firestoreIds = new Set(
                          team.docs.map((d) => d.id),
                        );
                        const localTeamDocs = documents.filter(
                          (d) =>
                            d.teamId === team.id && !firestoreIds.has(d.id),
                        );
                        const allTeamDocs: {
                          id: string;
                          title: string;
                          folder: string;
                          updatedAt: number;
                        }[] = [
                          ...team.docs,
                          ...localTeamDocs.map((d) => ({
                            id: d.id,
                            title: d.title,
                            folder: d.folder || "/",
                            updatedAt: d.updatedAt ?? Date.now(),
                          })),
                        ];
                        // Build folder tree for this team's docs
                        const teamFolders = ["/", ...(team.folders || [])];
                        const teamTree = buildTree(
                          teamFolders,
                          allTeamDocs.map((td) => {
                            const localDoc = documents.find(
                              (d) => d.id === td.id,
                            );
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
                          }),
                        );

                        return (
                          <div key={team.id}>
                            <div className="flex items-center">
                              <button
                                className={cn(
                                  "flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors",
                                  isMobile && "py-2",
                                )}
                                onClick={() =>
                                  setExpandedTeams((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(team.id)) next.delete(team.id);
                                    else next.add(team.id);
                                    return next;
                                  })
                                }
                              >
                                {isExpanded ? (
                                  <ChevronDown
                                    className={cn(
                                      "shrink-0",
                                      isMobile ? "h-3.5 w-3.5" : "h-3 w-3",
                                    )}
                                  />
                                ) : (
                                  <ChevronRight
                                    className={cn(
                                      "shrink-0",
                                      isMobile ? "h-3.5 w-3.5" : "h-3 w-3",
                                    )}
                                  />
                                )}
                                <Users
                                  className={cn(
                                    "shrink-0",
                                    isMobile ? "h-3.5 w-3.5" : "h-3 w-3",
                                  )}
                                />
                                <span className="flex-1 truncate">
                                  {team.name || "(no name)"}
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  {allTeamDocs.length}
                                </span>
                              </button>
                              <div
                                className={cn(
                                  "flex pr-1",
                                  isMobile ? "gap-1" : "gap-0.5",
                                )}
                              >
                                <span
                                  title="New team document"
                                  className={
                                    isMobile
                                      ? "flex items-center justify-center rounded-md p-1.5 -my-1 active:bg-accent"
                                      : ""
                                  }
                                  onClick={() => handleCreateTeamDoc(team)}
                                >
                                  <Plus
                                    className={cn(
                                      "text-muted-foreground hover:text-foreground shrink-0 cursor-pointer",
                                      isMobile ? "h-5 w-5" : "h-3 w-3",
                                    )}
                                  />
                                </span>
                                <span
                                  title="New team folder"
                                  className={
                                    isMobile
                                      ? "flex items-center justify-center rounded-md p-1.5 -my-1 active:bg-accent"
                                      : ""
                                  }
                                  onClick={() => {
                                    setCreatingTeamFolderIn({
                                      teamId: team.id,
                                      parent: "/",
                                    });
                                    setNewTeamFolderName("");
                                    setExpandedTeams(
                                      (prev) => new Set([...prev, team.id]),
                                    );
                                  }}
                                >
                                  <FolderPlus
                                    className={cn(
                                      "text-muted-foreground hover:text-foreground shrink-0 cursor-pointer",
                                      isMobile ? "h-5 w-5" : "h-3 w-3",
                                    )}
                                  />
                                </span>
                              </div>
                            </div>
                            {isExpanded && (
                              <div className="space-y-0.5 pl-3">
                                {allTeamDocs.length === 0 &&
                                (team.folders || []).length === 0 ? (
                                  <p className="text-[10px] text-muted-foreground italic px-2 py-1">
                                    No documents
                                  </p>
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
                    className={cn(
                      "flex w-full items-center gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground transition-colors",
                      isMobile ? "py-1" : "py-1.5",
                    )}
                    onClick={() => setSharedExpanded((v) => !v)}
                  >
                    {sharedExpanded ? (
                      <ChevronDown
                        className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"}
                      />
                    ) : (
                      <ChevronRight
                        className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"}
                      />
                    )}
                    <Share2 className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"} />
                    <span className="font-medium">Shared with me</span>
                    <span className="ml-auto text-[10px]">
                      {sharedDocs.length}
                    </span>
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
                            "group flex w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs transition-colors",
                            isMobile ? "pl-3 py-2" : "pl-2.5 py-1.5",
                            activeDocId === sd.id
                              ? "bg-sidebar-accent text-sidebar-accent-foreground"
                              : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                          )}
                        >
                          <FileText
                            className={cn(
                              "shrink-0",
                              isMobile ? "h-4 w-4" : "h-3.5 w-3.5",
                            )}
                          />
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
                                await removeCollaborator(sd.id, {
                                  uid: user.uid,
                                  email: user.email || "",
                                  role: sd.role,
                                  addedAt: 0,
                                });
                              } catch {
                                /* ignore */
                              }
                              setSharedDocs((prev) =>
                                prev.filter((d) => d.id !== sd.id),
                              );
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
      <div
        className={cn(
          "flex items-center justify-between text-[10px] text-muted-foreground",
          isIOS ? "pb-7 px-6 pt-2" : "px-4",
        )}
        style={
          !isIOS
            ? {
                paddingTop: "0.5rem",
                paddingBottom: "max(var(--safe-area-bottom), 0.5rem)",
              }
            : undefined
        }
      >
        <span>
          {personalDocs.length} doc{personalDocs.length !== 1 ? "s" : ""}
          {teams.length > 0 &&
            ` / ${teams.length} team${teams.length !== 1 ? "s" : ""}`}
          {sharedDocs.length > 0 && ` / ${sharedDocs.length} shared`}
        </span>
        <span className="opacity-50">v{__APP_VERSION__}</span>
      </div>

      {/* Floating context menu — portaled to body to avoid overflow clipping on iOS */}
      {contextMenu &&
        createPortal(
          (() => {
            const doc = documents.find((d) => d.id === contextMenu.docId);
            const teamDoc = teams
              .flatMap((t) => t.docs.map((d) => ({ ...d, team: t })))
              .find((d) => d.id === contextMenu.docId);
            const isTeam = !!teamDoc;
            const folderList = isTeam
              ? ["/", ...(teamDoc.team.folders || [])]
              : personalFolders;
            const docFolder = isTeam
              ? teamDoc.folder || "/"
              : doc?.folder || "/";
            const title = doc?.title || teamDoc?.title || "";
            const onMove = isTeam
              ? (id: string, f: string) => handleMoveTeamDoc(id, f)
              : (id: string, f: string) => moveDocument(id, f);
            const onDelete = isTeam
              ? (id: string) => handleDeleteTeamDoc(id, teamDoc.team)
              : (id: string) => deleteDocument(id);
            // Clamp position to viewport. The menu can be taller than the
            // screen (long folder list), so open it toward whichever side has
            // more room and cap its height there — the body scrolls if needed.
            const menuW = 180;
            const margin = 8;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const x = Math.max(
              margin,
              Math.min(contextMenu.x, vw - menuW - margin),
            );
            const spaceBelow = vh - contextMenu.y - margin;
            const spaceAbove = contextMenu.y - margin;
            const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
            const maxMenuH = Math.max(160, openUp ? spaceAbove : spaceBelow);
            const y = openUp
              ? Math.max(margin, contextMenu.y - maxMenuH)
              : contextMenu.y;
            return (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 9998 }}
                  onClick={() => setContextMenu(null)}
                  onPointerDown={() => setContextMenu(null)}
                />
                <div
                  data-context-menu
                  style={{
                    position: "fixed",
                    left: x,
                    top: y,
                    zIndex: 9999,
                    minWidth: menuW,
                    maxHeight: maxMenuH,
                    overflowY: "auto",
                    overscrollBehavior: "contain",
                    WebkitOverflowScrolling: "touch",
                    background: isDark ? "#262626" : "#fff",
                    border: `1px solid ${isDark ? "#404040" : "#e5e5e5"}`,
                    borderRadius: 8,
                    padding: "4px 0",
                    fontSize: 12,
                    boxShadow: isDark
                      ? "0 8px 24px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)"
                      : "0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
                  }}
                >
                  {folderList.length > 1 && (
                    <>
                      <p
                        style={{
                          padding: "2px 10px",
                          fontSize: 10,
                          color: "#999",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        Move to
                      </p>
                      {folderList.map((f) => {
                        const isCurrent = docFolder === f;
                        return (
                          <button
                            key={f}
                            style={{
                              display: "flex",
                              width: "100%",
                              alignItems: "center",
                              gap: 6,
                              padding: "4px 10px",
                              fontSize: 11,
                              textAlign: "left",
                              border: "none",
                              background: "transparent",
                              cursor: isCurrent ? "default" : "pointer",
                              color: isCurrent ? "#999" : "inherit",
                            }}
                            disabled={isCurrent}
                            onClick={() => {
                              onMove(contextMenu.docId, f);
                              setContextMenu(null);
                            }}
                          >
                            <Folder
                              style={{ width: 11, height: 11, flexShrink: 0 }}
                            />
                            {f === "/" ? "Root" : f.split("/").pop()}
                            {isCurrent && (
                              <span style={{ fontSize: 9, marginLeft: "auto" }}>
                                (current)
                              </span>
                            )}
                          </button>
                        );
                      })}
                      <hr
                        style={{
                          margin: "3px 0",
                          border: "none",
                          borderTop: `1px solid ${isDark ? "#404040" : "#e5e5e5"}`,
                        }}
                      />
                    </>
                  )}
                  <button
                    style={{
                      display: "flex",
                      width: "100%",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 10px",
                      fontSize: 11,
                      textAlign: "left",
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      color: "inherit",
                    }}
                    onClick={() => {
                      setRenamingDocId(contextMenu.docId);
                      setRenameValue(title);
                      setContextMenu(null);
                    }}
                  >
                    <PenLine style={{ width: 11, height: 11, flexShrink: 0 }} />
                    Rename
                  </button>
                  <button
                    style={{
                      display: "flex",
                      width: "100%",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 10px",
                      fontSize: 11,
                      textAlign: "left",
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      color: "#ef4444",
                    }}
                    onClick={() => {
                      // Deleting a document also removes it from the cloud and
                      // is not undoable — confirm first, matching folder delete.
                      if (confirm(`「${title}」を削除しますか？`)) {
                        onDelete(contextMenu.docId);
                      }
                      setContextMenu(null);
                    }}
                  >
                    <Trash2 style={{ width: 11, height: 11, flexShrink: 0 }} />
                    Delete
                  </button>
                </div>
              </>
            );
          })(),
          document.body,
        )}

      {/* Drag indicator — follows pointer during drag */}
      {dragIndicator &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: dragIndicator.x + 16,
              top: dragIndicator.y - 10,
              pointerEvents: "none",
              zIndex: 99999,
              background: "rgba(0,0,0,0.8)",
              color: "#fff",
              padding: "3px 10px",
              borderRadius: 6,
              fontSize: 11,
              whiteSpace: "nowrap",
              boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
              fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            }}
          >
            {documents.find((d) => d.id === dragIndicator.docId)?.title ||
              dragIndicator.docId}
          </div>,
          document.body,
        )}
    </div>
  );
}
