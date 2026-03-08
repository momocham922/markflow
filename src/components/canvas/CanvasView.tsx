import { useCallback, useMemo, useEffect, useRef } from "react";
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
import { DocumentNode, type DocumentNodeData } from "./DocumentNode";
import { useAppStore } from "@/stores/app-store";

const nodeTypes = { document: DocumentNode };

const STORAGE_KEY = "markflow-canvas-state";

interface CanvasState {
  positions: Record<string, { x: number; y: number }>;
  edges: { id: string; source: string; target: string }[];
}

function loadCanvasState(): CanvasState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { positions: {}, edges: [] };
}

function saveCanvasState(state: CanvasState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

export function CanvasView() {
  const { documents, setActiveDocId } = useAppStore();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const savedState = useMemo(() => loadCanvasState(), []);

  const initialNodes: Node[] = useMemo(
    () =>
      documents.map((doc, i) => ({
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
      })),
    [documents, savedState.positions],
  );

  const initialEdges: Edge[] = useMemo(
    () => savedState.edges
      .filter((e) =>
        documents.some((d) => d.id === e.source) &&
        documents.some((d) => d.id === e.target),
      )
      .map((e) => ({ ...e, id: e.id || `${e.source}-${e.target}` })),
    [savedState.edges, documents],
  );

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);

  // Debounced save of positions and edges
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const positions: Record<string, { x: number; y: number }> = {};
      for (const node of nodes) {
        positions[node.id] = node.position;
      }
      saveCanvasState({
        positions,
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      });
    }, 500);
  }, [nodes, edges]);

  // Save on node position changes
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      const hasPosChange = changes.some(
        (c) => c.type === "position" && c.dragging === false,
      );
      if (hasPosChange) scheduleSave();
    },
    [onNodesChange, scheduleSave],
  );

  // Save on edge changes
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
      setActiveDocId(node.id);
    },
    [setActiveDocId],
  );

  return (
    <div className="h-full w-full">
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
      >
        <Controls className="!bg-card !border-border !shadow-sm [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground" />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
        <MiniMap
          className="!bg-card !border-border"
          nodeColor="var(--primary)"
          maskColor="var(--background)"
        />
      </ReactFlow>
    </div>
  );
}
