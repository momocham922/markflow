import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Tag } from "lucide-react";

export function TagNode({ data }: NodeProps) {
  const { label, docCount } = data as { label: string; docCount: number };

  return (
    <div className="rounded-full border border-primary/30 bg-primary/5 px-3 py-1.5 shadow-sm">
      <div className="flex items-center gap-1.5">
        <Tag className="h-3 w-3 text-primary" />
        <span className="text-xs font-medium text-primary">{label}</span>
        <span className="text-[9px] text-muted-foreground">({docCount})</span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-primary !w-1.5 !h-1.5 !border-0" />
    </div>
  );
}
