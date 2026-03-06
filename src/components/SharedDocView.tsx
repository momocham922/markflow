import { useState, useEffect } from "react";
import { FileText, AlertCircle, ArrowLeft, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchDocumentByToken } from "@/services/sharing";

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

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchDocumentByToken(token)
      .then((result) => {
        if (result) {
          setDoc(result);
        } else {
          setError("Document not found or link has expired");
        }
      })
      .catch(() => {
        setError("Failed to load shared document");
      })
      .finally(() => setLoading(false));
  }, [token]);

  const handleCopy = async () => {
    if (!doc) return;
    const div = document.createElement("div");
    div.innerHTML = doc.content;
    await navigator.clipboard.writeText(div.textContent || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div
          className="prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-8"
          dangerouslySetInnerHTML={{ __html: doc.content }}
        />
      </div>
    </div>
  );
}
