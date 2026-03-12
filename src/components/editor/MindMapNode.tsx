import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export interface MindMapNodeData {
  label: string;
  level: number;
}

const levelColors = [
  "bg-blue-500 text-white",       // root (h1 / doc title)
  "bg-indigo-500 text-white",     // h1
  "bg-violet-500 text-white",     // h2
  "bg-purple-400 text-white",     // h3
  "bg-fuchsia-400 text-white",    // h4
  "bg-pink-400 text-white",       // h5+
];

const levelSizes = [
  "text-sm font-semibold px-5 py-2.5",  // root
  "text-[13px] font-medium px-4 py-2",  // h1
  "text-xs font-medium px-3.5 py-1.5",  // h2
  "text-[11px] px-3 py-1.5",            // h3
  "text-[11px] px-3 py-1",              // h4
  "text-[10px] px-2.5 py-1",            // h5+
];

export const MindMapNode = memo(function MindMapNode({
  data,
  selected,
}: NodeProps) {
  const nodeData = data as unknown as MindMapNodeData;
  const colorIdx = Math.min(nodeData.level, levelColors.length - 1);

  return (
    <div
      className={`rounded-full shadow-sm transition-all ${levelColors[colorIdx]} ${levelSizes[colorIdx]} ${
        selected ? "ring-2 ring-white/50 shadow-md scale-105" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-white/50 !w-1.5 !h-1.5 !border-0 !-left-0.5"
      />
      <span className="whitespace-nowrap">{nodeData.label}</span>
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-white/50 !w-1.5 !h-1.5 !border-0 !-right-0.5"
      />
    </div>
  );
});
