import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Folder } from "lucide-react";

export function FolderNode({ data }: NodeProps) {
  const { label, docCount, wordCount } = data as {
    label: string;
    path: string;
    docCount: number;
    wordCount: number;
  };

  return (
    <div className="rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-4 py-2.5 shadow-sm min-w-[140px]">
      <div className="flex items-center gap-2">
        <Folder className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-semibold text-foreground">{label}</span>
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground flex gap-2">
        <span>{docCount} docs</span>
        <span>{wordCount.toLocaleString()} words</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-amber-400 !w-2 !h-2 !border-0" />
    </div>
  );
}
