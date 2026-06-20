import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  FileText,
  AlertCircle,
  ArrowLeft,
  Copy,
  Check,
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchDocumentByToken } from "@/services/sharing";
import { Marked } from "marked";
import hljs from "highlight.js";
import mermaid from "mermaid";
import { useAppStore } from "@/stores/app-store";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const sharedMarked = new Marked({ gfm: true, breaks: true });
const sharedRenderer = new sharedMarked.Renderer();
sharedRenderer.code = function ({
  text,
  lang,
}: {
  text: string;
  lang?: string;
}) {
  if (lang === "mermaid") {
    const escaped = escapeHtml(text);
    return `<div class="mermaid" data-mermaid-source="${escaped}"></div>`;
  }
  const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
  const highlighted = hljs.highlight(text, { language }).value;
  return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
};
sharedRenderer.link = function ({
  href,
  text,
}: {
  href: string;
  text: string;
}) {
  if (/^(javascript|data|vbscript):/i.test(href.trim())) {
    return escapeHtml(text);
  }
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
};
sharedMarked.use({ renderer: sharedRenderer });

mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  themeVariables: {
    fontFamily:
      'ui-sans-serif, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif',
    fontSize: "14px",
  },
  flowchart: { htmlLabels: false, padding: 15, useMaxWidth: true },
  sequence: { useMaxWidth: true },
});

function fixMermaidSvg(el: HTMLElement, dark: boolean) {
  const svg = el.querySelector("svg") as SVGSVGElement | null;
  if (!svg) return;

  let modified = false;
  const SKIP_CLASSES = new Set([
    "actor",
    "note",
    "activation0",
    "activation1",
    "activation2",
  ]);
  const allRects = Array.from(svg.querySelectorAll("rect"));

  for (const noteRect of allRects.filter((r) => r.classList.contains("note"))) {
    const g = noteRect.parentElement;
    if (!g) continue;
    const textEls = g.querySelectorAll("text");
    if (textEls.length === 0) continue;
    const rx = parseFloat(noteRect.getAttribute("x") || "0");
    const rw = parseFloat(noteRect.getAttribute("width") || "0");
    let minTx = Infinity;
    let maxTr = -Infinity;
    for (const t of Array.from(textEls)) {
      try {
        const bb = (t as SVGTextElement).getBBox();
        if (bb.width > 0) {
          minTx = Math.min(minTx, bb.x);
          maxTr = Math.max(maxTr, bb.x + bb.width);
        }
      } catch {
        /* getBBox fails if not visible */
      }
    }
    if (maxTr === -Infinity) continue;
    const pad = 18;
    const newX = Math.min(rx, minTx - pad);
    const newRight = Math.max(rx + rw, maxTr + pad);
    if (newRight - newX > rw + 1) {
      noteRect.setAttribute("x", String(newX));
      noteRect.setAttribute("width", String(newRight - newX));
      modified = true;
    }
  }

  const sectionRects = allRects.filter((r) => {
    for (const c of r.classList) if (SKIP_CLASSES.has(c)) return false;
    const fill = r.getAttribute("fill") || "";
    return /^rgba?\s*\(/i.test(fill);
  });

  if (sectionRects.length >= 2) {
    let minX = Infinity;
    let maxR = 0;
    for (const r of sectionRects) {
      const x = parseFloat(r.getAttribute("x") || "0");
      const w = parseFloat(r.getAttribute("width") || "0");
      minX = Math.min(minX, x);
      maxR = Math.max(maxR, x + w);
    }
    for (const r of sectionRects) {
      r.setAttribute("x", String(minX));
      r.setAttribute("width", String(maxR - minX));
    }
    modified = true;
  }

  if (dark) {
    let mainBg: Element | null = null;
    let maxArea = 0;
    for (const r of allRects) {
      if (sectionRects.includes(r)) continue;
      const a =
        parseFloat(r.getAttribute("width") || "0") *
        parseFloat(r.getAttribute("height") || "0");
      if (a > maxArea) {
        maxArea = a;
        mainBg = r;
      }
    }
    if (mainBg) {
      mainBg.setAttribute("fill", "transparent");
      modified = true;
    }
    for (const r of sectionRects) {
      const fill = r.getAttribute("fill") || "";
      const m = fill.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) {
        r.setAttribute(
          "fill",
          `rgba(${Math.round(Number(m[1]) * 0.25)}, ${Math.round(Number(m[2]) * 0.25)}, ${Math.round(Number(m[3]) * 0.25)}, 0.6)`,
        );
      }
      const stroke = r.getAttribute("stroke") || "";
      const sm = stroke.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (sm) {
        r.setAttribute(
          "stroke",
          `rgba(${Math.round(Number(sm[1]) * 0.35)}, ${Math.round(Number(sm[2]) * 0.35)}, ${Math.round(Number(sm[3]) * 0.35)}, 0.5)`,
        );
      }
    }
  }

  if (modified) {
    try {
      const bbox = svg.getBBox();
      if (bbox.width > 10 && bbox.height > 10) {
        const pad = 8;
        svg.setAttribute(
          "viewBox",
          `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`,
        );
        svg.style.maxWidth = `${bbox.width + pad * 2}px`;
      }
    } catch {
      /* getBBox may fail if SVG not yet laid out */
    }
  }
}

interface SharedDocViewProps {
  token: string;
  onBack: () => void;
}

export function SharedDocView({ token, onBack }: SharedDocViewProps) {
  const theme = useAppStore((s) => s.theme);
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const editPreviewRef = useRef<HTMLDivElement>(null);

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
      return sharedMarked.parse(content) as string;
    } catch {
      return content;
    }
  }, [doc, editing, editContent]);

  useEffect(() => {
    const container = contentRef.current || editPreviewRef.current;
    if (!container) return;
    const isDark = theme === "dark";
    const renderDiagrams = () => {
      const divs = Array.from(
        container.querySelectorAll<HTMLElement>(".mermaid"),
      ).filter((el) => !el.querySelector("svg"));
      if (divs.length === 0) return;
      (async () => {
        for (const el of divs) {
          if (!el.isConnected || el.querySelector("svg")) continue;
          const source = el.getAttribute("data-mermaid-source") || "";
          if (!source) continue;
          el.setAttribute("data-mermaid-processed", "true");
          try {
            const { svg, bindFunctions } = await mermaid.render(
              `mermaid-${Math.random().toString(36).slice(2)}`,
              source,
            );
            if (!el.isConnected) continue;
            el.innerHTML = svg;
            bindFunctions?.(el);
            try {
              fixMermaidSvg(el, isDark);
            } catch {
              /* OK */
            }
          } catch (e) {
            el.textContent = String(e);
          }
        }
      })();
    };
    renderDiagrams();
    const t1 = setTimeout(renderDiagrams, 150);
    const t2 = setTimeout(renderDiagrams, 600);
    const t3 = setTimeout(renderDiagrams, 2000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [previewHtml, theme]);

  const handleCopy = async () => {
    if (!doc) return;
    await navigator.clipboard.writeText(doc.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = useCallback(async () => {
    if (!doc) return;
    setSaveError(null);
    try {
      const { updateDoc, doc: firestoreDoc } =
        await import("firebase/firestore");
      const { firestore } = await import("@/services/firebase");
      await updateDoc(firestoreDoc(firestore, "documents", doc.id), {
        content: editContent,
        title:
          editContent
            .split("\n")[0]
            ?.replace(/^#+\s*/, "")
            .trim()
            .slice(0, 50) || doc.title,
      });
      setDoc((prev) => (prev ? { ...prev, content: editContent } : null));
      setEditing(false);
    } catch {
      setSaveError("保存に失敗しました。編集権限がない可能性があります。");
    }
  }, [doc, editContent]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-muted-foreground">
          Loading shared document...
        </div>
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <div className="text-center">
          <h2 className="text-lg font-medium">
            {error || "Document not found"}
          </h2>
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
          {doc.permission === "edit" &&
            (editing ? (
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
            ))}
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3 w-3" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            Copy
          </Button>
        </div>
      </div>

      {/* Save error */}
      {saveError && (
        <div className="mx-4 mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {saveError}
        </div>
      )}

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
              ref={editPreviewRef}
              className="flex-1 overflow-auto prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-8"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        ) : (
          <div
            ref={contentRef}
            className="prose prose-sm dark:prose-invert mx-auto max-w-3xl px-6 py-8"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        )}
      </div>
    </div>
  );
}
