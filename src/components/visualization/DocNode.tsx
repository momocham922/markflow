import { Handle, Position, type NodeProps } from "@xyflow/react";
import { FileText, Share2 } from "lucide-react";

export function DocNode({ data }: NodeProps) {
  const { label, wordCount, tags, isShared } = data as {
    label: string;
    docId: string;
    wordCount: number;
    tags: string[];
    isShared?: boolean;
  };

  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 shadow-sm cursor-pointer hover:border-primary/50 hover:shadow-md transition-all min-w-[120px] max-w-[250px]">
      <Handle type="target" position={Position.Top} className="!bg-border !w-2 !h-2 !border-0" />
      <div className="flex items-center gap-1.5">
        <FileText className="h-3.5 w-3.5 text-blue-500 shrink-0" />
        <span className="text-xs font-medium truncate">{label}</span>
        {isShared && <Share2 className="h-2.5 w-2.5 text-emerald-500 shrink-0" />}
      </div>
      <div className="mt-0.5 text-[9px] text-muted-foreground">
        {wordCount.toLocaleString()} words
      </div>
      {tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-0.5">
          {tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="inline-block rounded-full bg-primary/10 px-1.5 py-0 text-[8px] text-primary"
            >
              {tag}
            </span>
          ))}
          {tags.length > 3 && (
            <span className="text-[8px] text-muted-foreground">+{tags.length - 3}</span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-primary !w-1.5 !h-1.5 !border-0 !opacity-0" />
    </div>
  );
}
