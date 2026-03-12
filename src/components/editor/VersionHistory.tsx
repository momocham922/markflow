import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RotateCcw, Trash2, Clock } from "lucide-react";
import * as db from "@/services/database";
import {
  fetchVersionsFromCloud,
  deleteVersionFromCloud,
  type FirestoreVersion,
} from "@/services/firebase";
import { useAuthStore } from "@/stores/auth-store";
import { marked } from "marked";

interface VersionHistoryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docId: string | null;
  currentTitle: string;
  onRestore: (content: string) => void;
}

/** Unified version type for display */
interface Version {
  id: string;
  content: string;
  title: string;
  created_at: number;
  ownerName: string | null;
  source: "cloud" | "local";
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return `${d.getFullYear()}/${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")}`;
}

/** Escape HTML special characters to prevent XSS */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function VersionHistory({
  open,
  onOpenChange,
  docId,
  currentTitle,
  onRestore,
}: VersionHistoryProps) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const user = useAuthStore((s) => s.user);

  // Load versions: cloud-first, local fallback
  useEffect(() => {
    if (!open || !docId) {
      setVersions([]);
      setSelectedId(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      let result: Version[] = [];

      // Primary: fetch from Firestore (source of truth)
      if (user) {
        try {
          const cloudVersions = await fetchVersionsFromCloud(docId);
          result = cloudVersions.map((v: FirestoreVersion) => ({
            id: v.id,
            content: v.content,
            title: v.title,
            created_at: v.createdAt,
            ownerName: v.ownerName || null,
            source: "cloud" as const,
          }));
        } catch {
          // Cloud unavailable, fall through to local
        }
      }

      // Fallback: merge local versions not yet in cloud
      try {
        const localVersions = await db.getVersions(docId);
        const cloudIds = new Set(result.map((v) => v.id));
        for (const lv of localVersions) {
          if (!cloudIds.has(lv.id)) {
            result.push({
              id: lv.id,
              content: lv.content,
              title: lv.title,
              created_at: lv.created_at,
              ownerName: null,
              source: "local",
            });
          }
        }
      } catch {}

      // Sort by created_at descending
      result.sort((a, b) => b.created_at - a.created_at);

      if (!cancelled) {
        setVersions(result);
        if (result.length > 0) setSelectedId(result[0].id);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, docId, user]);

  const selected = versions.find((v) => v.id === selectedId);

  // Group versions by day
  const grouped = useMemo(() => {
    const groups: { label: string; items: Version[] }[] = [];
    let currentDay = "";
    for (const v of versions) {
      const day = dayKey(v.created_at);
      if (day !== currentDay) {
        currentDay = day;
        groups.push({ label: day, items: [] });
      }
      groups[groups.length - 1].items.push(v);
    }
    return groups;
  }, [versions]);

  // Render selected version's markdown as preview HTML
  const previewHtml = useMemo(() => {
    if (!selected) return "";
    try {
      return marked.parse(selected.content) as string;
    } catch {
      return escapeHtml(selected.content);
    }
  }, [selected]);

  const handleRestore = () => {
    if (!selected) return;
    onRestore(selected.content);
    onOpenChange(false);
  };

  const handleDelete = async (version: Version) => {
    try {
      // Delete from cloud if it's a cloud version
      if (version.source === "cloud") {
        await deleteVersionFromCloud(version.id);
      }
      // Also try to delete locally
      try {
        await db.deleteVersion(version.id);
      } catch {}

      setVersions((prev) => prev.filter((v) => v.id !== version.id));
      if (selectedId === version.id) {
        const remaining = versions.filter((v) => v.id !== version.id);
        setSelectedId(remaining.length > 0 ? remaining[0].id : null);
      }
    } catch {}
  };

  // Content snippet for version list
  const snippet = (content: string) => {
    const lines = content.split("\n").filter((l) => l.trim());
    const first = lines[0]?.replace(/^#+\s*/, "").trim() || "";
    return first.slice(0, 60) + (first.length > 60 ? "..." : "");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[70vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border shrink-0">
          <DialogTitle className="text-sm font-medium">
            Version History
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {currentTitle} — {versions.length} version{versions.length !== 1 ? "s" : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 min-h-0">
          {/* Version list */}
          <div className="w-64 shrink-0 border-r border-border overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                Loading...
              </div>
            ) : versions.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-xs text-muted-foreground gap-2 px-4 text-center">
                <Clock className="h-8 w-8 opacity-30" />
                <p>No versions yet</p>
                <p className="text-[10px]">Versions are saved automatically after you stop editing for 10 seconds</p>
              </div>
            ) : (
              grouped.map((group) => (
                <div key={group.label}>
                  <div className="sticky top-0 bg-muted/80 backdrop-blur-sm px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {group.label}
                  </div>
                  {group.items.map((v) => (
                    <button
                      key={v.id}
                      className={`w-full text-left px-3 py-2.5 border-b border-border/50 transition-colors group ${
                        selectedId === v.id
                          ? "bg-accent"
                          : "hover:bg-accent/50"
                      }`}
                      onClick={() => setSelectedId(v.id)}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-foreground">
                          {relativeTime(v.created_at)}
                        </span>
                        <button
                          className="opacity-0 group-hover:opacity-60 hover:opacity-100! transition-opacity p-0.5"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(v);
                          }}
                          title="Delete this version"
                        >
                          <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                        </button>
                      </div>
                      {v.ownerName && (
                        <p className="text-[10px] text-blue-500 dark:text-blue-400 mt-0.5 truncate">
                          {v.ownerName}
                        </p>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                        {snippet(v.content)}
                      </p>
                      <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                        {formatTimestamp(v.created_at)}
                      </p>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* Preview pane */}
          <div className="flex-1 flex flex-col min-w-0">
            {selected ? (
              <>
                <div className="flex-1 overflow-y-auto px-8 py-6">
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                </div>
                <div className="shrink-0 border-t border-border px-4 py-3 flex items-center justify-between bg-muted/30">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-muted-foreground">
                      {formatTimestamp(selected.created_at)}
                    </span>
                    {selected.ownerName && (
                      <span className="text-[10px] text-blue-500 dark:text-blue-400">
                        by {selected.ownerName}
                      </span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    onClick={handleRestore}
                  >
                    <RotateCcw className="h-3 w-3" />
                    Restore this version
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                Select a version to preview
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
