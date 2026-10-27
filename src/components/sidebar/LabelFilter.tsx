import { useState, useRef, useEffect, useMemo } from "react";
import { Tag, ChevronDown, Check, X, Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Label (tag) filter for the sidebar. A single compact control — not a wrapping
 * row of pills — so any number of labels costs one line at the top and the
 * document tree keeps the height. Clicking opens a searchable, scrollable list;
 * the active label shows inline with a clear button. Styled with the sidebar's
 * own tokens (hairline border, ink / muted two-tone, no rounded-pill chips),
 * and adapts to light and dark.
 */
export function LabelFilter({
  tags,
  selectedTag,
  onSelect,
}: {
  tags: string[];
  selectedTag: string | null;
  onSelect: (tag: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape, and reset the search when closing.
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tags.filter((t) => t.toLowerCase().includes(q)) : tags;
  }, [tags, query]);

  return (
    <div ref={rootRef} className="relative px-3 pb-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="listbox"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
            selectedTag
              ? "bg-sidebar-accent text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
          )}
        >
          <Tag className="h-3 w-3 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedTag ?? "ラベル"}
          </span>
          {!selectedTag && tags.length > 0 && (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {tags.length}
            </span>
          )}
          <ChevronDown
            className={cn(
              "h-3 w-3 shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
        {selectedTag && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            aria-label="ラベルの絞り込みを解除"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute inset-x-3 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-background shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="絞り込み…"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {selectedTag && (
              <button
                type="button"
                onClick={() => {
                  onSelect(null);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              >
                <X className="h-3 w-3 shrink-0 opacity-70" />
                絞り込みを解除
              </button>
            )}
            {filtered.length === 0 ? (
              <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">
                該当なし
              </p>
            ) : (
              filtered.map((tag) => {
                const active = tag === selectedTag;
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => {
                      onSelect(active ? null : tag);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-sidebar-accent",
                      active
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Tag className="h-3 w-3 shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1 truncate">{tag}</span>
                    {active && <Check className="h-3 w-3 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
