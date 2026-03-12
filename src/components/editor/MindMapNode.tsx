import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export interface MindMapNodeData {
  label: string;
  level: number;
}

const levelColors = [
  "bg-blue-500 text-white",       // root (doc title)
  "bg-indigo-500 text-white",     // h1
  "bg-violet-500 text-white",     // h2
  "bg-purple-400 text-white",     // h3
  "bg-fuchsia-400 text-white",    // h4
  "bg-pink-400 text-white",       // h5+
];

const levelSizes = [
  "text-sm font-semibold px-5 py-2",     // root
  "text-[13px] font-medium px-4 py-1.5", // h1
  "text-xs font-medium px-3.5 py-1.5",   // h2
  "text-[11px] px-3 py-1",               // h3
  "text-[11px] px-3 py-1",               // h4
  "text-[10px] px-2.5 py-0.5",           // h5+
];

export const MindMapNode = memo(function MindMapNode({
  data,
  selected,
}: NodeProps) {
  const nodeData = data as unknown as MindMapNodeData;
  const colorIdx = Math.min(nodeData.level, levelColors.length - 1);

  return (
    <div
      className={`rounded-full shadow-sm ${levelColors[colorIdx]} ${levelSizes[colorIdx]} ${
        selected ? "ring-2 ring-white/50 shadow-md scale-105" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="bg-transparent! w-0! h-0! min-w-0! min-h-0! border-0! -left-px!"
      />
      <span className="whitespace-nowrap">{nodeData.label}</span>
      <Handle
        type="source"
        position={Position.Right}
        className="bg-transparent! w-0! h-0! min-w-0! min-h-0! border-0! -right-px!"
      />
    </div>
  );
});
