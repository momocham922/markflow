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
import { MindMapNode, type MindMapNodeData, mindMapThemes, type MindMapThemeId, type EdgeStyle } from "./MindMapNode";
import { Plus, Trash2, Pencil, Palette } from "lucide-react";
import { useAppStore } from "@/stores/app-store";

const nodeTypes = { mindmap: MindMapNode };

/** Data model for a mind map stored in document content */
export interface MindMapData {
  nodes: MindMapTreeNode[];
  theme?: MindMapThemeId;
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

/** Count CJK/fullwidth characters that render ~2x wider than Latin */
function countWideChars(text: string): number {
  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x3000 && cp <= 0x9FFF) || // CJK, hiragana, katakana
      (cp >= 0xF900 && cp <= 0xFAFF) || // CJK Compatibility
      (cp >= 0xFF01 && cp <= 0xFF60) || // Fullwidth forms
      (cp >= 0xAC00 && cp <= 0xD7AF)    // Korean Hangul
    ) count++;
  }
  return count;
}

function estimateNodeWidth(label: string, level: number): number {
  const idx = Math.min(level, LEVEL_CHAR_WIDTHS.length - 1);
  const charW = LEVEL_CHAR_WIDTHS[idx];
  const wide = countWideChars(label);
  const narrow = label.length - wide;
  return Math.max(narrow * charW + wide * charW * 1.8 + LEVEL_PADDING_X[idx], 60);
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

function layoutTree(root: LayoutNode, themeId: MindMapThemeId = "lavender"): { nodes: Node[]; edges: Edge[] } {
  const themeObj = mindMapThemes[themeId] ?? mindMapThemes.lavender;
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
      data: { label: node.label, level: node.level, themeId } satisfies MindMapNodeData,
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
      const edgeTypeMap: Record<EdgeStyle, string> = { bezier: "default", straight: "straight", step: "smoothstep" };
      edges.push({
        id: `${node.id}-${child.id}`,
        source: node.id,
        target: child.id,
        type: edgeTypeMap[themeObj.edgeStyle] ?? "default",
        style: { stroke: themeObj.edgeColor, strokeWidth: themeObj.edgeStyle === "step" ? 2 : 1.5 },
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
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const editCancelledRef = useRef(false);
  const { themeSettings, setThemeSettings } = useAppStore();
  const currentTheme = (themeSettings.mindMapTheme || "lavender") as MindMapThemeId;

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

  const addChildTo = useCallback((parentId: string) => {
    const newId = `n-${Date.now()}`;
    const newNode: MindMapTreeNode = { id: newId, label: "New topic", children: [] };
    const updatedNodes = data.nodes.map((n) =>
      n.id === parentId ? { ...n, children: [...n.children, newId] } : n,
    );
    updatedNodes.push(newNode);
    save({ ...data, nodes: updatedNodes });
    setSelectedNodeId(newId);
    setEditingNodeId(newId);
    setEditLabel("New topic");
  }, [data, save]);

  const handleAddChild = useCallback(() => {
    addChildTo(selectedNodeId ?? "root");
  }, [selectedNodeId, addChildTo]);

  // Add sibling: find parent of selected node, add new child to that parent
  const handleAddSibling = useCallback(() => {
    if (!selectedNodeId || selectedNodeId === "root") return;
    const parentNode = data.nodes.find((n) => n.children.includes(selectedNodeId));
    if (!parentNode) return;
    addChildTo(parentNode.id);
  }, [selectedNodeId, data, addChildTo]);

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
    save({ ...data, nodes: updatedNodes });
    setSelectedNodeId(null);
  }, [selectedNodeId, data, nodeMap, save]);

  const handleStartEdit = useCallback(() => {
    if (!selectedNodeId) return;
    const node = nodeMap.get(selectedNodeId);
    if (!node) return;
    setEditingNodeId(selectedNodeId);
    setEditLabel(node.label);
  }, [selectedNodeId, nodeMap]);

  const handleEditCancel = useCallback(() => {
    editCancelledRef.current = true;
    setEditingNodeId(null);
  }, []);

  const handleFinishEdit = useCallback(() => {
    if (editCancelledRef.current) {
      editCancelledRef.current = false;
      return;
    }
    if (!editingNodeId || !editLabel.trim()) {
      setEditingNodeId(null);
      return;
    }
    const updatedNodes = data.nodes.map((n) =>
      n.id === editingNodeId ? { ...n, label: editLabel.trim() } : n,
    );
    save({ ...data, nodes: updatedNodes });
    setEditingNodeId(null);
  }, [editingNodeId, editLabel, data, save]);

  const handleThemeChange = useCallback((themeId: MindMapThemeId) => {
    setThemeSettings({ mindMapTheme: themeId });
    setThemeMenuOpen(false);
  }, [setThemeSettings]);

  // Find parent of a node
  const findParent = useCallback((nodeId: string): MindMapTreeNode | null => {
    return data.nodes.find((n) => n.children.includes(nodeId)) ?? null;
  }, [data]);

  // Arrow key navigation: find next node in given direction
  const navigateTo = useCallback((direction: "left" | "right" | "up" | "down") => {
    if (!selectedNodeId) { setSelectedNodeId("root"); return; }

    if (direction === "right") {
      // Go to first child
      const node = nodeMap.get(selectedNodeId);
      if (node && node.children.length > 0) setSelectedNodeId(node.children[0]);
    } else if (direction === "left") {
      // Go to parent
      if (selectedNodeId === "root") return;
      const parent = findParent(selectedNodeId);
      if (parent) setSelectedNodeId(parent.id);
    } else {
      // Up/Down: navigate among siblings
      const parent = findParent(selectedNodeId);
      if (!parent) return;
      const idx = parent.children.indexOf(selectedNodeId);
      if (direction === "up" && idx > 0) setSelectedNodeId(parent.children[idx - 1]);
      if (direction === "down" && idx < parent.children.length - 1) setSelectedNodeId(parent.children[idx + 1]);
    }
  }, [selectedNodeId, nodeMap, findParent]);

  // Document-level keyboard handler (bypasses ReactFlow event capture)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when editing or when an input/textarea is focused
      if (editingNodeId) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "Enter") {
        e.preventDefault();
        handleAddChild();
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (selectedNodeId && selectedNodeId !== "root") {
          handleAddSibling();
        } else {
          handleAddChild();
        }
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedNodeId && selectedNodeId !== "root") {
        e.preventDefault();
        handleDelete();
      } else if ((e.key === "F2" || e.key === " ") && selectedNodeId) {
        e.preventDefault();
        handleStartEdit();
      } else if (e.key === "Escape") {
        setSelectedNodeId(null);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        navigateTo("right");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        navigateTo("left");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        navigateTo("up");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        navigateTo("down");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [editingNodeId, selectedNodeId, handleAddChild, handleAddSibling, handleDelete, handleStartEdit, navigateTo]);


  // Layout
  const layoutRoot = useMemo(() => buildLayoutTree(data), [data]);
  const { nodes, edges } = useMemo(() => layoutTree(layoutRoot, currentTheme), [layoutRoot, currentTheme]);

  // Make selected node visually distinct + inject editing state
  const nodesWithSelection = useMemo(() =>
    nodes.map((n) => ({
      ...n,
      selected: n.id === selectedNodeId,
      data: {
        ...n.data,
        ...(n.id === editingNodeId ? {
          editing: true,
          editLabel,
          onEditChange: setEditLabel,
          onEditFinish: handleFinishEdit,
          onEditCancel: handleEditCancel,
        } : {}),
      },
    })),
    [nodes, selectedNodeId, editingNodeId, editLabel, handleFinishEdit, handleEditCancel],
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
        <div className="relative">
          <button
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-foreground bg-secondary hover:bg-accent transition-colors"
            onClick={() => setThemeMenuOpen((v) => !v)}
            title="Change theme"
          >
            <Palette className="h-3.5 w-3.5" />
            Theme
          </button>
          {themeMenuOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-lg p-2 w-36">
              {(Object.keys(mindMapThemes) as MindMapThemeId[]).map((id) => (
                <button
                  key={id}
                  className={`flex items-center gap-2 w-full rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                    currentTheme === id ? "bg-accent font-medium" : "hover:bg-accent/50"
                  }`}
                  onClick={() => handleThemeChange(id)}
                >
                  <span
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: mindMapThemes[id].swatch }}
                  />
                  {mindMapThemes[id].name}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground truncate">
          {selectedNode ? selectedNode.label : "Enter: child / Tab: sibling / Arrows: navigate"}
        </span>
      </div>

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
          onPaneClick={() => { setSelectedNodeId(null); setThemeMenuOpen(false); }}
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
