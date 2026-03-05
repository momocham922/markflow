import { useState, useEffect, useCallback } from "react";
import {
  History,
  Save,
  RotateCcw,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { diffLines, type Change } from "diff";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useAppStore } from "@/stores/app-store";
import * as db from "@/services/database";

interface Version {
  id: string;
  documentId: string;
  content: string;
  title: string;
  message: string | null;
  createdAt: number;
}

interface VersionPanelProps {
  onClose: () => void;
}

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const changes = diffLines(oldText, newText);
  const stats = changes.reduce(
    (acc, c) => {
      const lines = c.count ?? 0;
      if (c.added) acc.added += lines;
      if (c.removed) acc.removed += lines;
      return acc;
    },
    { added: 0, removed: 0 },
  );

  return (
    <div className="mt-2">
      <div className="flex gap-2 text-[10px] mb-1.5">
        <span className="text-green-600 dark:text-green-400">+{stats.added}</span>
        <span className="text-red-600 dark:text-red-400">-{stats.removed}</span>
      </div>
      <div className="rounded-md border border-border overflow-hidden text-[11px] font-mono leading-relaxed max-h-[300px] overflow-y-auto">
        {changes.map((change: Change, i: number) => {
          const lines = change.value.replace(/\n$/, "").split("\n");
          return lines.map((line, j) => (
            <div
              key={`${i}-${j}`}
              className={
                change.added
                  ? "bg-green-500/10 text-green-700 dark:text-green-300"
                  : change.removed
                    ? "bg-red-500/10 text-red-700 dark:text-red-300"
                    : "text-muted-foreground"
              }
            >
              <span className="inline-block w-5 text-center text-[9px] opacity-50 select-none">
                {change.added ? "+" : change.removed ? "-" : " "}
              </span>
              <span className="whitespace-pre-wrap break-all">
                {line || "\u00A0"}
              </span>
            </div>
          ));
        })}
      </div>
    </div>
  );
}

export function VersionPanel({ onClose }: VersionPanelProps) {
  const { activeDocId, documents, updateDocument } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const [versions, setVersions] = useState<Version[]>([]);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [snapshotMsg, setSnapshotMsg] = useState("");

  const loadVersions = useCallback(async () => {
    if (!activeDocId) return;
    try {
      const rows = await db.getVersions(activeDocId);
      setVersions(
        rows.map((r) => ({
          id: r.id,
          documentId: r.document_id,
          content: r.content,
          title: r.title,
          message: r.message,
          createdAt: r.created_at,
        })),
      );
    } catch {
      // No DB available (browser mode)
    }
  }, [activeDocId]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  const handleSave = async () => {
    if (!activeDoc) return;
    setSaving(true);
    try {
      await db.createVersion({
        id: crypto.randomUUID(),
        documentId: activeDoc.id,
        content: activeDoc.content,
        title: activeDoc.title,
        message: snapshotMsg.trim() || null,
      });
      setSnapshotMsg("");
      await loadVersions();
    } catch (err) {
      console.error("Failed to save version:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (version: Version) => {
    if (!activeDocId || !activeDoc) return;
    try {
      await db.createVersion({
        id: crypto.randomUUID(),
        documentId: activeDoc.id,
        content: activeDoc.content,
        title: `Before restore: ${activeDoc.title}`,
        message: null,
      });
    } catch {
      // Best-effort backup
    }
    updateDocument(activeDocId, {
      content: version.content,
      updatedAt: Date.now(),
    });
    setExpandedId(null);
    await loadVersions();
  };

  if (!activeDoc) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        Select a document to view versions
      </div>
    );
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="flex h-full w-80 flex-col border-l border-border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4" />
          <span className="text-sm font-medium">Versions</span>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Save snapshot */}
      <div className="p-3 space-y-2">
        <input
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          placeholder="Snapshot message (optional)"
          value={snapshotMsg}
          onChange={(e) => setSnapshotMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
        />
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={handleSave}
          disabled={saving}
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? "Saving..." : "Save Snapshot"}
        </Button>
      </div>

      <Separator />

      {/* Version list */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {versions.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No versions saved yet.
              <br />
              <span className="text-[10px]">Save a snapshot to track changes.</span>
            </p>
          )}
          {versions.map((v, idx) => {
            const isExpanded = expandedId === v.id;
            const olderVersion = versions[idx + 1];
            const oldContent = olderVersion?.content ?? "";

            return (
              <div
                key={v.id}
                className={`rounded-md border p-2 text-xs transition-colors ${
                  isExpanded
                    ? "border-primary bg-accent/50"
                    : "border-border hover:bg-accent/30"
                }`}
              >
                <div
                  className="flex items-center gap-1.5 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : v.id)}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">
                      {v.message || v.title}
                      {!v.message && (
                        <span className="ml-1 text-[9px] text-muted-foreground font-normal">(auto)</span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {formatTime(v.createdAt)}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="mt-2">
                    <DiffView oldText={oldContent} newText={v.content} />
                    <div className="mt-2 flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 gap-1 text-[10px]"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRestore(v);
                        }}
                      >
                        <RotateCcw className="h-3 w-3" />
                        Restore this version
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
