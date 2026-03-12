import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export type MindMapThemeId = "lavender" | "ocean" | "forest" | "sunset" | "mono";

export interface MindMapTheme {
  name: string;
  swatch: string; // preview color for the picker
  nodeColors: string[]; // tailwind classes per level
  edgeColor: string;
}

export const mindMapThemes: Record<MindMapThemeId, MindMapTheme> = {
  lavender: {
    name: "Lavender",
    swatch: "#8b5cf6",
    nodeColors: [
      "bg-violet-500 text-white",
      "bg-indigo-500 text-white",
      "bg-blue-500 text-white",
      "bg-purple-400 text-white",
      "bg-fuchsia-400 text-white",
      "bg-pink-400 text-white",
    ],
    edgeColor: "oklch(0.65 0.15 270 / 0.35)",
  },
  ocean: {
    name: "Ocean",
    swatch: "#0ea5e9",
    nodeColors: [
      "bg-sky-600 text-white",
      "bg-blue-500 text-white",
      "bg-cyan-500 text-white",
      "bg-teal-500 text-white",
      "bg-sky-400 text-white",
      "bg-cyan-400 text-white",
    ],
    edgeColor: "oklch(0.65 0.12 220 / 0.35)",
  },
  forest: {
    name: "Forest",
    swatch: "#22c55e",
    nodeColors: [
      "bg-emerald-600 text-white",
      "bg-green-600 text-white",
      "bg-teal-500 text-white",
      "bg-lime-600 text-white",
      "bg-green-400 text-white",
      "bg-emerald-400 text-white",
    ],
    edgeColor: "oklch(0.60 0.14 155 / 0.35)",
  },
  sunset: {
    name: "Sunset",
    swatch: "#f97316",
    nodeColors: [
      "bg-rose-500 text-white",
      "bg-orange-500 text-white",
      "bg-amber-500 text-white",
      "bg-red-400 text-white",
      "bg-orange-400 text-white",
      "bg-yellow-500 text-white",
    ],
    edgeColor: "oklch(0.65 0.16 40 / 0.35)",
  },
  mono: {
    name: "Mono",
    swatch: "#64748b",
    nodeColors: [
      "bg-slate-700 text-white",
      "bg-slate-600 text-white",
      "bg-slate-500 text-white",
      "bg-gray-500 text-white",
      "bg-gray-400 text-white",
      "bg-slate-400 text-white",
    ],
    edgeColor: "oklch(0.55 0.01 260 / 0.30)",
  },
};

export interface MindMapNodeData {
  label: string;
  level: number;
  themeId?: MindMapThemeId;
}

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
  const theme = mindMapThemes[nodeData.themeId ?? "lavender"];
  const colorIdx = Math.min(nodeData.level, theme.nodeColors.length - 1);

  return (
    <div
      className={`rounded-full shadow-sm ${theme.nodeColors[colorIdx]} ${levelSizes[Math.min(nodeData.level, levelSizes.length - 1)]} ${
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
