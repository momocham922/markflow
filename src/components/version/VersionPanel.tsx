import { useState, useEffect, useCallback } from "react";
import {
  History,
  Save,
  RotateCcw,
  X,
} from "lucide-react";
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

export function VersionPanel({ onClose }: VersionPanelProps) {
  const { activeDocId, documents, updateDocument } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const [versions, setVersions] = useState<Version[]>([]);
  const [saving, setSaving] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<Version | null>(null);

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
        message: null,
      });
      await loadVersions();
    } catch (err) {
      console.error("Failed to save version:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (version: Version) => {
    if (!activeDocId || !activeDoc) return;
    // Auto-save current state as a snapshot before restoring
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
    setSelectedVersion(null);
    await loadVersions();
  };

  if (!activeDoc) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        Select a document to view versions
      </div>
    );
  }

  return (
    <div className="flex h-full w-72 flex-col border-l border-border bg-background">
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
      <div className="p-3">
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
              No versions saved yet
            </p>
          )}
          {versions.map((v) => (
            <div
              key={v.id}
              className={`rounded-md border p-2 text-xs cursor-pointer transition-colors ${
                selectedVersion?.id === v.id
                  ? "border-primary bg-accent"
                  : "border-border hover:bg-accent/50"
              }`}
              onClick={() =>
                setSelectedVersion(selectedVersion?.id === v.id ? null : v)
              }
            >
              <div className="font-medium truncate">{v.title}</div>
              <div className="text-muted-foreground mt-0.5">
                {new Date(v.createdAt).toLocaleString()}
              </div>
              {v.message && (
                <div className="text-muted-foreground mt-1 italic">
                  {v.message}
                </div>
              )}
              {selectedVersion?.id === v.id && (
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
                    Restore
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
