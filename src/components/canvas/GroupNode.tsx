import { memo, useState, useRef, useEffect, useCallback } from "react";
import { type NodeProps, NodeResizer } from "@xyflow/react";

export interface GroupNodeData {
  label: string;
  onLabelChange?: (nodeId: string, label: string) => void;
}

export const GroupNode = memo(function GroupNode({
  id,
  data,
  selected,
}: NodeProps) {
  const d = data as unknown as GroupNodeData;
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(d.label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleBlur = useCallback(() => {
    setEditing(false);
    if (d.onLabelChange) {
      d.onLabelChange(id, label);
    }
  }, [id, label, d]);

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={120}
        lineClassName="!border-primary/30"
        handleClassName="!bg-primary !w-2 !h-2"
      />
      <div
        className={`w-full h-full rounded-lg border-2 border-dashed transition-colors ${
          selected
            ? "border-primary/40 bg-primary/5"
            : "border-border bg-muted/20"
        }`}
      >
        <div
          className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider cursor-text"
          onDoubleClick={() => setEditing(true)}
        >
          {editing ? (
            <input
              ref={inputRef}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") handleBlur();
              }}
              className="bg-transparent outline-none text-[10px] font-medium uppercase tracking-wider w-full"
            />
          ) : (
            d.label || "Group"
          )}
        </div>
      </div>
    </>
  );
});
