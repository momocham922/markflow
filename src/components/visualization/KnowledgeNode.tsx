import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { FileText, Link2, ArrowLeftRight } from "lucide-react";

export interface KnowledgeNodeData {
  label: string;
  docId: string;
  linkCount: number;
  backlinkCount: number;
  isOrphan: boolean;
  isActive: boolean;
  folder: string;
  tags: string[];
}

export const KnowledgeNode = memo(function KnowledgeNode({
  data,
  selected,
}: NodeProps) {
  const d = data as unknown as KnowledgeNodeData;
  const totalConnections = d.linkCount + d.backlinkCount;

  // Size based on connections
  const size = Math.min(12 + totalConnections * 2, 28);

  return (
    <div
      className={`relative flex flex-col items-center gap-1 group ${
        d.isActive ? "z-10" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-transparent !w-0 !h-0 !border-0"
      />
      {/* Node circle */}
      <div
        className={`rounded-full flex items-center justify-center transition-all cursor-pointer ${
          d.isOrphan
            ? "border-2 border-dashed border-muted-foreground/40 bg-muted/50"
            : d.isActive
              ? "border-2 border-primary bg-primary/20 shadow-lg shadow-primary/20"
              : selected
                ? "border-2 border-primary bg-primary/10 shadow-md"
                : "border border-border bg-card shadow-sm hover:border-primary/50 hover:shadow-md"
        }`}
        style={{ width: `${size * 2}px`, height: `${size * 2}px` }}
      >
        <FileText
          className="text-muted-foreground"
          style={{ width: `${Math.max(size * 0.6, 12)}px`, height: `${Math.max(size * 0.6, 12)}px` }}
        />
      </div>
      {/* Label */}
      <div className="absolute top-full mt-1 flex flex-col items-center pointer-events-none">
        <span
          className={`text-[10px] font-medium text-center leading-tight max-w-[120px] truncate ${
            d.isActive ? "text-primary" : "text-foreground"
          }`}
        >
          {d.label}
        </span>
        {/* Connection badges */}
        {totalConnections > 0 && (
          <div className="flex items-center gap-1 mt-0.5">
            {d.linkCount > 0 && (
              <span className="flex items-center gap-0.5 text-[8px] text-blue-500">
                <Link2 className="h-2 w-2" />
                {d.linkCount}
              </span>
            )}
            {d.backlinkCount > 0 && (
              <span className="flex items-center gap-0.5 text-[8px] text-emerald-500">
                <ArrowLeftRight className="h-2 w-2" />
                {d.backlinkCount}
              </span>
            )}
          </div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-transparent !w-0 !h-0 !border-0"
      />
    </div>
  );
});
