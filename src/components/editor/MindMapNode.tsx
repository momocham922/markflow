import { memo, useRef, useEffect } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export type MindMapThemeId = "lavender" | "ocean" | "forest" | "sunset" | "mono";

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
  editLabel?: string;
  selectAll?: boolean;
  onEditChange?: (value: string) => void;
  onEditFinish?: () => void;
  onEditCancel?: () => void;
  onTabInEdit?: () => void;
  onEnterInEdit?: () => void;
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
  const shape = shapeClass[theme.nodeShape];
  const isUnderline = theme.nodeShape === "underline";
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  // Suppress onBlur when Tab/Enter/Escape caused the blur (prevents stale save)
  const suppressBlurRef = useRef(false);

  // Focus input with retry — ReactFlow may steal focus or delay node rendering
  useEffect(() => {
    if (!nodeData.editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.value = nodeData.editLabel ?? "";

    let cancelled = false;
    let attempts = 0;
    const tryFocus = () => {
      if (cancelled || !inputRef.current) return;
      inputRef.current.focus();
      if (document.activeElement === inputRef.current) {
        // Focus succeeded
        if (nodeData.selectAll) {
          inputRef.current.select();
        } else {
          const len = inputRef.current.value.length;
          inputRef.current.setSelectionRange(len, len);
        }
      } else if (++attempts < 8) {
        // Focus failed (ReactFlow stole it), retry next frame
        requestAnimationFrame(tryFocus);
      }
    };
    requestAnimationFrame(tryFocus);
    return () => { cancelled = true; };
    // Only run when editing state starts — not on every editLabel change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeData.editing]);

  return (
    <div
      className={`${shape} ${isUnderline ? "" : "shadow-sm"} ${theme.nodeColors[colorIdx]} ${levelSizes[Math.min(nodeData.level, levelSizes.length - 1)]} ${
        selected ? (isUnderline ? "ring-1 ring-current/30 bg-current/5!" : "ring-2 ring-white/50 shadow-md scale-105") : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="bg-transparent! w-0! h-0! min-w-0! min-h-0! border-0! -left-px!"
      />
      {nodeData.editing ? (
        <input
          ref={inputRef}
          className="bg-transparent outline-none border-none text-inherit font-inherit whitespace-nowrap min-w-[3ch] w-[8ch]"
          defaultValue={nodeData.editLabel ?? ""}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            nodeData.onEditChange?.((e.target as HTMLInputElement).value);
          }}
          onInput={(e) => {
            if (!composingRef.current) {
              nodeData.onEditChange?.((e.target as HTMLInputElement).value);
            }
            // Auto-size input width
            const el = e.target as HTMLInputElement;
            el.style.width = `${Math.max(el.value.length + 1, 3)}ch`;
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (composingRef.current) return;
            if (e.key === "Tab") {
              e.preventDefault();
              suppressBlurRef.current = true;
              nodeData.onTabInEdit?.();
            } else if (e.key === "Enter") {
              suppressBlurRef.current = true;
              nodeData.onEnterInEdit?.();
            } else if (e.key === "Escape") {
              suppressBlurRef.current = true;
              nodeData.onEditCancel?.();
            }
          }}
          onBlur={() => {
            if (suppressBlurRef.current) {
              suppressBlurRef.current = false;
              return;
            }
            if (!composingRef.current) nodeData.onEditFinish?.();
          }}
        />
      ) : (
        <span className="whitespace-nowrap">{nodeData.label}</span>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="bg-transparent! w-0! h-0! min-w-0! min-h-0! border-0! -right-px!"
      />
    </div>
  );
});
