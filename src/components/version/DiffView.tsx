import { useMemo } from "react";
import { diffLines, type Change } from "diff";

interface DiffViewProps {
  oldText: string;
  newText: string;
  /** Full-page mode: no max-height, larger text */
  fullPage?: boolean;
}

export function DiffView({ oldText, newText, fullPage }: DiffViewProps) {
  const { changes, stats } = useMemo(() => {
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
    return { changes, stats };
  }, [oldText, newText]);

  return (
    <div className={fullPage ? "" : "mt-2"}>
      <div className={`flex gap-2 mb-1.5 ${fullPage ? "text-xs" : "text-[10px]"}`}>
        <span className="text-green-600 dark:text-green-400">+{stats.added}</span>
        <span className="text-red-600 dark:text-red-400">-{stats.removed}</span>
      </div>
      <div
        className={`rounded-md border border-border overflow-hidden font-mono leading-relaxed ${
          fullPage
            ? "text-sm overflow-y-auto"
            : "text-[11px] max-h-[300px] overflow-y-auto"
        }`}
      >
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
              <span className={`inline-block text-center opacity-50 select-none ${fullPage ? "w-8 text-xs" : "w-5 text-[9px]"}`}>
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
