import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
  ConnectionLineType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { MindMapNode, type MindMapNodeData } from "./MindMapNode";
import { Plus, Trash2, Pencil } from "lucide-react";

const nodeTypes = { mindmap: MindMapNode };

/** Data model for a mind map stored in document content */
export interface MindMapData {
  nodes: MindMapTreeNode[];
}

export interface MindMapTreeNode {
  id: string;
  label: string;
  children: string[]; // child node IDs
}

/** Create initial mind map data for a new mind map document */
export function createInitialMindMapData(title: string): MindMapData {
  return {
    nodes: [{ id: "root", label: title || "Central Topic", children: [] }],
  };
}

/** Parse mind map JSON from document content. Returns null if invalid. */
export function parseMindMapData(content: string): MindMapData | null {
  try {
    const data = JSON.parse(content);
    if (data?.nodes && Array.isArray(data.nodes)) return data as MindMapData;
  } catch { /* not valid JSON */ }
  return null;
}

// Layout
const LEVEL_CHAR_WIDTHS = [8.5, 8, 7, 6.5, 6.5, 6];
const LEVEL_PADDING_X = [40, 32, 28, 24, 24, 20];
const LEVEL_NODE_HEIGHTS = [40, 36, 32, 30, 28, 26];
const H_GAP = 60;
const V_GAP = 24;

function estimateNodeWidth(label: string, level: number): number {
  const idx = Math.min(level, LEVEL_CHAR_WIDTHS.length - 1);
  return Math.max(label.length * LEVEL_CHAR_WIDTHS[idx] + LEVEL_PADDING_X[idx], 60);
}

function estimateNodeHeight(level: number): number {
  return LEVEL_NODE_HEIGHTS[Math.min(level, LEVEL_NODE_HEIGHTS.length - 1)];
}

interface LayoutNode {
  id: string;
  label: string;
  level: number;
  children: LayoutNode[];
}

function buildLayoutTree(data: MindMapData): LayoutNode {
  const map = new Map<string, MindMapTreeNode>();
  for (const n of data.nodes) map.set(n.id, n);

  function build(id: string, level: number): LayoutNode {
    const node = map.get(id);
    if (!node) return { id, label: "?", level, children: [] };
    return {
      id: node.id,
      label: node.label,
      level,
      children: node.children.map((cid) => build(cid, level + 1)),
    };
  }

  return build("root", 0);
}

function layoutTree(root: LayoutNode): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  function subtreeHeight(node: LayoutNode): number {
    if (node.children.length === 0) return estimateNodeHeight(node.level);
    let total = 0;
    for (const child of node.children) total += subtreeHeight(child);
    total += (node.children.length - 1) * V_GAP;
    return total;
  }

  function layout(node: LayoutNode, x: number, yStart: number, yEnd: number) {
    const nodeH = estimateNodeHeight(node.level);
    const yCenter = (yStart + yEnd) / 2;

    nodes.push({
      id: node.id,
      type: "mindmap",
      position: { x, y: yCenter - nodeH / 2 },
      data: { label: node.label, level: node.level } satisfies MindMapNodeData,
    });

    if (node.children.length === 0) return;

    const nodeW = estimateNodeWidth(node.label, node.level);
    const childX = x + nodeW + H_GAP;
    const totalChildHeight = node.children.reduce(
      (sum, c) => sum + subtreeHeight(c), 0,
    ) + (node.children.length - 1) * V_GAP;

    let childY = yCenter - totalChildHeight / 2;
    for (const child of node.children) {
      const h = subtreeHeight(child);
      edges.push({
        id: `${node.id}-${child.id}`,
        source: node.id,
        target: child.id,
        type: "default",
        style: { stroke: "oklch(0.65 0.15 270 / 0.35)", strokeWidth: 1.5 },
      });
      layout(child, childX, childY, childY + h);
      childY += h + V_GAP;
    }
  }

  const totalH = subtreeHeight(root);
  layout(root, 50, -totalH / 2, totalH / 2);
  return { nodes, edges };
}

interface MindMapEditorProps {
  content: string;
  title: string;
  onChange: (content: string) => void;
  onTitleChange: (title: string) => void;
}

export function MindMapEditor({ content, title, onChange, onTitleChange }: MindMapEditorProps) {
  const data = useMemo(() => parseMindMapData(content) ?? createInitialMindMapData(title), [content]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  // Build a lookup map
  const nodeMap = useMemo(() => {
    const m = new Map<string, MindMapTreeNode>();
    for (const n of data.nodes) m.set(n.id, n);
    return m;
  }, [data]);

  const save = useCallback((newData: MindMapData) => {
    onChange(JSON.stringify(newData));
    // Update title from root node label
    const root = newData.nodes.find((n) => n.id === "root");
    if (root) onTitleChange(root.label);
  }, [onChange, onTitleChange]);

  const handleAddChild = useCallback(() => {
    const parentId = selectedNodeId ?? "root";
    const newId = `n-${Date.now()}`;
    const newNode: MindMapTreeNode = { id: newId, label: "New topic", children: [] };
    const updatedNodes = data.nodes.map((n) =>
      n.id === parentId ? { ...n, children: [...n.children, newId] } : n,
    );
    updatedNodes.push(newNode);
    save({ nodes: updatedNodes });
    setSelectedNodeId(newId);
    // Auto-start editing the new node
    setEditingNodeId(newId);
    setEditLabel("New topic");
  }, [selectedNodeId, data, save]);

  const handleDelete = useCallback(() => {
    if (!selectedNodeId || selectedNodeId === "root") return;
    // Collect all descendants
    const toDelete = new Set<string>();
    function collect(id: string) {
      toDelete.add(id);
      const node = nodeMap.get(id);
      if (node) node.children.forEach(collect);
    }
    collect(selectedNodeId);

    const updatedNodes = data.nodes
      .filter((n) => !toDelete.has(n.id))
      .map((n) => ({ ...n, children: n.children.filter((c) => !toDelete.has(c)) }));
    save({ nodes: updatedNodes });
    setSelectedNodeId(null);
  }, [selectedNodeId, data, nodeMap, save]);

  const handleStartEdit = useCallback(() => {
    if (!selectedNodeId) return;
    const node = nodeMap.get(selectedNodeId);
    if (!node) return;
    setEditingNodeId(selectedNodeId);
    setEditLabel(node.label);
  }, [selectedNodeId, nodeMap]);

  const handleFinishEdit = useCallback(() => {
    if (!editingNodeId || !editLabel.trim()) {
      setEditingNodeId(null);
      return;
    }
    const updatedNodes = data.nodes.map((n) =>
      n.id === editingNodeId ? { ...n, label: editLabel.trim() } : n,
    );
    save({ nodes: updatedNodes });
    setEditingNodeId(null);
  }, [editingNodeId, editLabel, data, save]);

  // Focus edit input when editing starts
  useEffect(() => {
    if (editingNodeId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingNodeId]);

  // Layout
  const layoutRoot = useMemo(() => buildLayoutTree(data), [data]);
  const { nodes, edges } = useMemo(() => layoutTree(layoutRoot), [layoutRoot]);

  // Make selected node visually distinct
  const nodesWithSelection = useMemo(() =>
    nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })),
    [nodes, selectedNodeId],
  );

  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) : null;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 shrink-0">
        <button
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-foreground bg-secondary hover:bg-accent transition-colors"
          onClick={handleAddChild}
          title={selectedNodeId ? "Add child to selected node" : "Add child to root"}
        >
          <Plus className="h-3.5 w-3.5" />
          Add topic
        </button>
        <button
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-foreground bg-secondary hover:bg-accent transition-colors disabled:opacity-30"
          onClick={handleStartEdit}
          disabled={!selectedNodeId}
          title="Rename selected node"
        >
          <Pencil className="h-3.5 w-3.5" />
          Rename
        </button>
        <button
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-destructive bg-secondary hover:bg-destructive/10 transition-colors disabled:opacity-30"
          onClick={handleDelete}
          disabled={!selectedNodeId || selectedNodeId === "root"}
          title="Delete selected node and children"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
        {selectedNode && (
          <span className="ml-auto text-[11px] text-muted-foreground truncate max-w-48">
            Selected: {selectedNode.label}
          </span>
        )}
      </div>

      {/* Inline edit overlay */}
      {editingNodeId && (
        <div className="absolute top-0 left-0 right-0 bottom-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
          <div className="bg-card border border-border rounded-lg shadow-lg p-4 w-72">
            <p className="text-xs text-muted-foreground mb-2">Rename node</p>
            <input
              ref={editRef}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleFinishEdit();
                if (e.key === "Escape") setEditingNodeId(null);
              }}
              onBlur={handleFinishEdit}
            />
          </div>
        </div>
      )}

      {/* ReactFlow canvas */}
      <div className="flex-1">
        <ReactFlow
          nodes={nodesWithSelection}
          edges={edges}
          nodeTypes={nodeTypes}
          connectionLineType={ConnectionLineType.Bezier}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={(_e, node) => {
            setSelectedNodeId(node.id);
          }}
          onPaneClick={() => setSelectedNodeId(null)}
          onNodeDoubleClick={(_e, node) => {
            setSelectedNodeId(node.id);
            const n = nodeMap.get(node.id);
            if (n) {
              setEditingNodeId(node.id);
              setEditLabel(n.label);
            }
          }}
          panOnDrag
          zoomOnScroll
          className="bg-background"
        >
          <Controls
            showInteractive={false}
            className="bg-card! border-border! shadow-sm! [&>button]:bg-card! [&>button]:border-border! [&>button]:text-foreground!"
          />
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
        </ReactFlow>
      </div>
    </div>
  );
}
