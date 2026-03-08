import { useState, useEffect, useCallback, useMemo } from "react";
import { FileText, AlertCircle, ArrowLeft, Copy, Check, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchDocumentByToken } from "@/services/sharing";
import { marked } from "marked";
import hljs from "highlight.js";

// Configure marked for preview
const sharedRenderer = new marked.Renderer();
sharedRenderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
  const highlighted = hljs.highlight(text, { language }).value;
  return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
};

interface SharedDocViewProps {
  token: string;
  onBack: () => void;
}

export function SharedDocView({ token, onBack }: SharedDocViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<{
    id: string;
    title: string;
    content: string;
    permission: "view" | "edit";
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchDocumentByToken(token)
      .then((result) => {
        if (result) {
          setDoc(result);
          setEditContent(result.content);
        } else {
          setError("Document not found or link has expired");
        }
      })
      .catch(() => {
        setError("Failed to load shared document");
      })
      .finally(() => setLoading(false));
  }, [token]);

  const previewHtml = useMemo(() => {
    if (!doc) return "";
    const content = editing ? editContent : doc.content;
    try {
      return marked.parse(content, { renderer: sharedRenderer, gfm: true, breaks: true }) as string;
    } catch {
      return content;
    }
  }, [doc, editing, editContent]);

  const handleCopy = async () => {
    if (!doc) return;
    await navigator.clipboard.writeText(doc.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = useCallback(async () => {
    if (!doc) return;
    try {
      const { updateDoc, doc: firestoreDoc } = await import("firebase/firestore");
      const { firestore } = await import("@/services/firebase");
      await updateDoc(firestoreDoc(firestore, "documents", doc.id), {
        content: editContent,
        title: editContent.split("\n")[0]?.replace(/^#+\s*/, "").trim().slice(0, 50) || doc.title,
      });
      setDoc((prev) => prev ? { ...prev, content: editContent } : null);
      setEditing(false);
    } catch {
      // Silently fail
    }
  }, [doc, editContent]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading shared document...</div>
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <div className="text-center">
          <h2 className="text-lg font-medium">{error || "Document not found"}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The share link may be invalid, disabled, or expired.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to my documents
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={onBack}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          <div className="h-4 w-px bg-border" />
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{doc.title}</span>
          <span className="rounded-md bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {doc.permission === "edit" ? "Can edit" : "View only"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {doc.permission === "edit" && (
            editing ? (
              <Button
                variant="default"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={handleSave}
              >
                <Check className="h-3 w-3" />
                Save
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-3 w-3" />
                Edit
              </Button>
            )
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={handleCopy}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            Copy
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {editing ? (
          <div className="flex h-full">
            <textarea
              className="flex-1 resize-none border-r border-border bg-background p-6 font-mono text-sm outline-none"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
            />
            <div
              className="flex-1 overflow-auto prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-8"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        ) : (
          <div
            className="prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-8"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        )}
      </div>
    </div>
  );
}
