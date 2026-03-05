import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { FileText } from "lucide-react";

export interface DocumentNodeData {
  label: string;
  preview: string;
  docId: string;
}

export const DocumentNode = memo(function DocumentNode({
  data,
  selected,
}: NodeProps) {
  const nodeData = data as unknown as DocumentNodeData;
  return (
    <div
      className={`rounded-lg border bg-card p-3 shadow-sm transition-shadow min-w-[180px] max-w-[240px] ${
        selected ? "border-primary shadow-md ring-2 ring-primary/20" : "border-border"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-primary !w-2 !h-2" />
      <div className="flex items-center gap-2 mb-1.5">
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium truncate">{nodeData.label}</span>
      </div>
      <p className="text-[11px] text-muted-foreground line-clamp-3 leading-relaxed">
        {nodeData.preview || "Empty document"}
      </p>
      <Handle type="source" position={Position.Bottom} className="!bg-primary !w-2 !h-2" />
    </div>
  );
});
