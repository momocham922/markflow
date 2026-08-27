import { memo, type CSSProperties } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export type MindMapThemeId =
  "lavender" | "ocean" | "forest" | "sunset" | "mono";

export type NodeShape = "pill" | "rounded" | "rect" | "underline";
export type EdgeStyle = "bezier" | "straight" | "step";

export interface MindMapTheme {
  name: string;
  swatch: string;
  nodeColors: string[]; // tailwind classes per level
  edgeColor: string;
  nodeShape: NodeShape;
  edgeStyle: EdgeStyle;
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
    nodeShape: "pill",
    edgeStyle: "bezier",
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
    nodeShape: "rounded",
    edgeStyle: "straight",
  },
  forest: {
    name: "Forest",
    swatch: "#22c55e",
    nodeColors: [
      "border-emerald-600 text-emerald-700 dark:text-emerald-300",
      "border-green-500 text-green-700 dark:text-green-300",
      "border-teal-500 text-teal-700 dark:text-teal-300",
      "border-lime-500 text-lime-700 dark:text-lime-300",
      "border-green-400 text-green-600 dark:text-green-400",
      "border-emerald-400 text-emerald-600 dark:text-emerald-400",
    ],
    edgeColor: "oklch(0.60 0.14 155 / 0.35)",
    nodeShape: "underline",
    edgeStyle: "step",
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
    nodeShape: "rect",
    edgeStyle: "bezier",
  },
  mono: {
    name: "Mono",
    swatch: "#64748b",
    nodeColors: [
      "border-slate-500 text-slate-700 dark:text-slate-200",
      "border-slate-400 text-slate-600 dark:text-slate-300",
      "border-gray-400 text-gray-600 dark:text-gray-300",
      "border-gray-300 text-gray-500 dark:text-gray-400",
      "border-gray-300 text-gray-500 dark:text-gray-400",
      "border-gray-200 text-gray-400 dark:text-gray-500",
    ],
    edgeColor: "oklch(0.55 0.01 260 / 0.30)",
    nodeShape: "rounded",
    edgeStyle: "step",
  },
};

const shapeClass: Record<NodeShape, string> = {
  pill: "rounded-full",
  rounded: "rounded-lg",
  rect: "rounded-sm",
  underline: "rounded-none border-b-2 bg-transparent!",
};

export interface MindMapNodeData {
  label: string;
  level: number;
  themeId?: MindMapThemeId;
  editing?: boolean;
  lineNumber?: number;
  // Bloom entrance: offset (canvas px) from this node toward its parent, plus a
  // depth-based delay. The CSS keyframe (globals.css `mm-bloom`) starts the node
  // at translate(dx,dy) scale(0.4) — i.e. sitting on top of its parent — then
  // springs it out to its real position, so children appear to burst from the
  // root outward. Undefined → no offset (the empty-tree single root node).
  dx?: number;
  dy?: number;
  delay?: number;
}

export const levelSizes = [
  "text-sm font-semibold px-5 py-2", // root
  "text-[13px] font-medium px-4 py-1.5", // h1
  "text-xs font-medium px-3.5 py-1.5", // h2
  "text-[11px] px-3 py-1", // h3
  "text-[11px] px-3 py-1", // h4
  "text-[10px] px-2.5 py-0.5", // h5+
];

export const MindMapNode = memo(function MindMapNode({
  data,
  selected,
}: NodeProps) {
  const nodeData = data as unknown as MindMapNodeData;
  // `?? "lavender"` only guards null/undefined. A stored themeId that is a
  // non-empty but unknown string (e.g. a theme renamed/removed in a later
  // build, or a corrupted setting) would otherwise index to `undefined` and
  // make `theme.nodeColors` throw — which unmounts the tree into a black
  // screen on mobile. Fall back to lavender for any unknown id.
  const theme =
    mindMapThemes[nodeData.themeId ?? "lavender"] ?? mindMapThemes.lavender;
  const colorIdx = Math.min(nodeData.level, theme.nodeColors.length - 1);
  const shape = shapeClass[theme.nodeShape];
  const isUnderline = theme.nodeShape === "underline";

  // Outer wrapper carries the bloom entrance animation (scoped to MindMapView
  // via the `.mindmap-bloom` ancestor in globals.css — MindMapEditor reuses this
  // node but has no such ancestor, so it never animates). The animation lives on
  // this wrapper, NOT the styled inner div, because the keyframe uses
  // fill-mode:both and would otherwise clobber the `selected` scale-105.
  const bloomVars = {
    "--mm-dx": `${nodeData.dx ?? 0}px`,
    "--mm-dy": `${nodeData.dy ?? 0}px`,
    "--mm-delay": `${nodeData.delay ?? 0}ms`,
  } as CSSProperties;

  // The <Handle>s live OUTSIDE the animated .mm-node (as siblings within
  // React Flow's .react-flow__node), NOT inside it. Reason: the bloom keyframe
  // puts a `transform` on .mm-node, and a transformed element becomes the
  // containing block for its abs-positioned descendants. React Flow measures
  // handle positions once at mount via getBoundingClientRect (transform-
  // dependent) and caches them forever. If the handles were inside .mm-node,
  // that one measurement lands mid-bloom (scale 0.4 / mid-translate), so every
  // parent's outgoing edge would stay anchored inside the node after the
  // animation settles. As siblings they anchor to .react-flow__node (whose own
  // positioning transform cancels in getHandleBounds), so they're always
  // measured un-transformed. Handles are w-0/transparent, so not blooming with
  // the body is invisible; edges fade in via `mm-edge-fade` anyway. This is a
  // no-op for MindMapEditor, where .mm-node has no transform and the handles
  // already anchored to .react-flow__node.
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        className="bg-transparent! w-0! h-0! min-w-0! min-h-0! border-0! -left-px!"
      />
      <div className="mm-node" style={bloomVars}>
        <div
          className={`${shape} ${isUnderline ? "" : "shadow-sm"} ${theme.nodeColors[colorIdx]} ${levelSizes[Math.min(nodeData.level, levelSizes.length - 1)]} ${
            selected
              ? isUnderline
                ? "ring-1 ring-current/30 bg-current/5!"
                : "ring-2 ring-white/50 shadow-md scale-105"
              : ""
          }`}
        >
          <span
            className={`whitespace-nowrap ${nodeData.editing ? "opacity-0" : ""}`}
          >
            {nodeData.label}
          </span>
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="bg-transparent! w-0! h-0! min-w-0! min-h-0! border-0! -right-px!"
      />
    </>
  );
});
