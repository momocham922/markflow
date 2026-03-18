import { memo, useState, useCallback, useRef, useEffect } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

const COLORS = [
  { bg: "bg-yellow-100 dark:bg-yellow-900/40", border: "border-yellow-300 dark:border-yellow-700" },
  { bg: "bg-blue-100 dark:bg-blue-900/40", border: "border-blue-300 dark:border-blue-700" },
  { bg: "bg-green-100 dark:bg-green-900/40", border: "border-green-300 dark:border-green-700" },
  { bg: "bg-pink-100 dark:bg-pink-900/40", border: "border-pink-300 dark:border-pink-700" },
  { bg: "bg-purple-100 dark:bg-purple-900/40", border: "border-purple-300 dark:border-purple-700" },
];

export interface StickyNoteData {
  text: string;
  colorIndex: number;
  onTextChange?: (nodeId: string, text: string) => void;
}

export const StickyNoteNode = memo(function StickyNoteNode({
  id,
  data,
  selected,
}: NodeProps) {
  const d = data as unknown as StickyNoteData;
  const color = COLORS[d.colorIndex % COLORS.length];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(d.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [editing]);

  const handleBlur = useCallback(() => {
    setEditing(false);
    if (d.onTextChange) {
      d.onTextChange(id, text);
    }
  }, [id, text, d]);

  return (
    <div
      className={`rounded-md border ${color.border} ${color.bg} p-3 shadow-sm min-w-[140px] max-w-[200px] transition-shadow ${
        selected ? "shadow-md ring-2 ring-primary/20" : ""
      }`}
      onDoubleClick={() => setEditing(true)}
    >
      <Handle type="target" position={Position.Top} className="!bg-transparent !w-0 !h-0 !border-0" />
      {editing ? (
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === "Escape") handleBlur();
          }}
          className="w-full bg-transparent text-xs resize-none outline-none min-h-[60px]"
          rows={3}
        />
      ) : (
        <p className="text-xs whitespace-pre-wrap leading-relaxed select-text min-h-[40px]">
          {d.text || "Double-click to edit"}
        </p>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !w-0 !h-0 !border-0" />
    </div>
  );
});
