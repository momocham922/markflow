import { useCallback, useMemo, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  BackgroundVariant,
  MiniMap,
  type Connection,
  type Node,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { StickyNote, Group, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentNode, type DocumentNodeData } from "./DocumentNode";
import { StickyNoteNode, type StickyNoteData } from "./StickyNoteNode";
import { GroupNode, type GroupNodeData } from "./GroupNode";
import { useAppStore } from "@/stores/app-store";

const nodeTypes = {
  document: DocumentNode,
  sticky: StickyNoteNode,
  group: GroupNode,
};

const STORAGE_KEY = "markflow-canvas-state";

interface CanvasState {
  positions: Record<string, { x: number; y: number }>;
  edges: { id: string; source: string; target: string }[];
  stickyNotes: { id: string; text: string; colorIndex: number; x: number; y: number }[];
  groups: { id: string; label: string; x: number; y: number; width: number; height: number }[];
}

function loadCanvasState(): CanvasState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { positions: {}, edges: [], stickyNotes: [], groups: [] };
}

function saveCanvasState(state: CanvasState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

export function CanvasView() {
  const { documents, setActiveDocId } = useAppStore();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nextColorIdx, setNextColorIdx] = useState(0);

  const savedState = useMemo(() => loadCanvasState(), []);

  // Callbacks for sticky note and group editing
  const handleStickyTextChange = useCallback((nodeId: string, text: string) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId && n.type === "sticky"
          ? { ...n, data: { ...n.data, text } }
          : n,
      ),
    );
  }, []);

  const handleGroupLabelChange = useCallback((nodeId: string, label: string) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId && n.type === "group"
          ? { ...n, data: { ...n.data, label } }
          : n,
      ),
    );
  }, []);

  const initialNodes: Node[] = useMemo(() => {
    const nodes: Node[] = [];

    // Groups first (rendered behind other nodes)
    for (const group of savedState.groups || []) {
      nodes.push({
        id: group.id,
        type: "group",
        position: { x: group.x, y: group.y },
        style: { width: group.width, height: group.height },
        data: {
          label: group.label,
          onLabelChange: handleGroupLabelChange,
        } satisfies GroupNodeData,
      });
    }

    // Document nodes
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      nodes.push({
        id: doc.id,
        type: "document",
        position: savedState.positions[doc.id] ?? {
          x: (i % 4) * 280 + 50,
          y: Math.floor(i / 4) * 200 + 50,
        },
        data: {
          label: doc.title,
          preview: doc.content.slice(0, 120),
          docId: doc.id,
        } satisfies DocumentNodeData,
      });
    }

    // Sticky notes
    for (const sticky of savedState.stickyNotes || []) {
      nodes.push({
        id: sticky.id,
        type: "sticky",
        position: { x: sticky.x, y: sticky.y },
        data: {
          text: sticky.text,
          colorIndex: sticky.colorIndex,
          onTextChange: handleStickyTextChange,
        } satisfies StickyNoteData,
      });
    }

    return nodes;
  }, [documents, savedState, handleStickyTextChange, handleGroupLabelChange]);

  const initialEdges: Edge[] = useMemo(
    () => (savedState.edges || [])
      .filter((e) => {
        const allNodeIds = new Set([
          ...documents.map((d) => d.id),
          ...(savedState.stickyNotes || []).map((s) => s.id),
          ...(savedState.groups || []).map((g) => g.id),
        ]);
        return allNodeIds.has(e.source) && allNodeIds.has(e.target);
      })
      .map((e) => ({ ...e, id: e.id || `${e.source}-${e.target}` })),
    [savedState, documents],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);

  // Debounced save
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const positions: Record<string, { x: number; y: number }> = {};
      const stickyNotes: CanvasState["stickyNotes"] = [];
      const groups: CanvasState["groups"] = [];

      for (const node of nodes) {
        if (node.type === "document") {
          positions[node.id] = node.position;
        } else if (node.type === "sticky") {
          const d = node.data as unknown as StickyNoteData;
          stickyNotes.push({
            id: node.id,
            text: d.text,
            colorIndex: d.colorIndex,
            x: node.position.x,
            y: node.position.y,
          });
        } else if (node.type === "group") {
          const d = node.data as unknown as GroupNodeData;
          const style = node.style as { width?: number; height?: number } | undefined;
          groups.push({
            id: node.id,
            label: d.label,
            x: node.position.x,
            y: node.position.y,
            width: style?.width ?? 300,
            height: style?.height ?? 200,
          });
        }
      }

      saveCanvasState({
        positions,
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        stickyNotes,
        groups,
      });
    }, 500);
  }, [nodes, edges]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      const hasPosChange = changes.some(
        (c) => c.type === "position" && c.dragging === false,
      );
      const hasResize = changes.some((c) => c.type === "dimensions");
      if (hasPosChange || hasResize) scheduleSave();
    },
    [onNodesChange, scheduleSave],
  );

  useEffect(() => {
    scheduleSave();
  }, [edges, scheduleSave]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge(connection, eds));
    },
    [setEdges],
  );

  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type === "document") {
        setActiveDocId(node.id);
      }
    },
    [setActiveDocId],
  );

  const addStickyNote = useCallback(() => {
    const id = `sticky-${Date.now()}`;
    const colorIndex = nextColorIdx;
    setNextColorIdx((prev) => (prev + 1) % 5);

    setNodes((nds) => [
      ...nds,
      {
        id,
        type: "sticky",
        position: { x: 200 + Math.random() * 200, y: 200 + Math.random() * 200 },
        data: {
          text: "",
          colorIndex,
          onTextChange: handleStickyTextChange,
        } satisfies StickyNoteData,
      },
    ]);
  }, [nextColorIdx, setNodes, handleStickyTextChange]);

  const addGroup = useCallback(() => {
    const id = `group-${Date.now()}`;
    setNodes((nds) => [
      {
        id,
        type: "group",
        position: { x: 100 + Math.random() * 100, y: 100 + Math.random() * 100 },
        style: { width: 300, height: 200 },
        data: {
          label: "New Group",
          onLabelChange: handleGroupLabelChange,
        } satisfies GroupNodeData,
      },
      ...nds,
    ]);
  }, [setNodes, handleGroupLabelChange]);

  const deleteSelected = useCallback(() => {
    setNodes((nds) => nds.filter((n) => !n.selected || n.type === "document"));
    setEdges((eds) => eds.filter((e) => !e.selected));
  }, [setNodes, setEdges]);

  const hasSelection = nodes.some((n) => n.selected && n.type !== "document") ||
    edges.some((e) => e.selected);

  return (
    <div className="h-full w-full flex flex-col">
      {/* Canvas toolbar */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-muted/30 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs cursor-pointer"
          onClick={addStickyNote}
        >
          <StickyNote className="h-3 w-3" />
          Sticky Note
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs cursor-pointer"
          onClick={addGroup}
        >
          <Group className="h-3 w-3" />
          Group
        </Button>
        {hasSelection && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs text-destructive cursor-pointer"
            onClick={deleteSelected}
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        )}
        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground">
          {documents.length} docs · Double-click card to open
        </span>
      </div>

      {/* Canvas */}
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDoubleClick={onNodeDoubleClick}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          className="bg-background"
          deleteKeyCode={null}
        >
          <Controls className="!bg-card !border-border !shadow-sm [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground" />
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
          <MiniMap
            className="!bg-card !border-border"
            nodeColor={(node) => {
              if (node.type === "sticky") return "var(--color-yellow-400)";
              if (node.type === "group") return "var(--border)";
              return "var(--primary)";
            }}
            maskColor="var(--background)"
          />
        </ReactFlow>
      </div>
    </div>
  );
}
