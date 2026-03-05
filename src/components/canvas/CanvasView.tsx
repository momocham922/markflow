import { useCallback, useMemo } from "react";
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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { DocumentNode, type DocumentNodeData } from "./DocumentNode";
import { useAppStore } from "@/stores/app-store";

const nodeTypes = { document: DocumentNode };

function stripHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

export function CanvasView() {
  const { documents, setActiveDocId } = useAppStore();

  const initialNodes: Node[] = useMemo(
    () =>
      documents.map((doc, i) => ({
        id: doc.id,
        type: "document",
        position: {
          x: (i % 4) * 280 + 50,
          y: Math.floor(i / 4) * 200 + 50,
        },
        data: {
          label: doc.title,
          preview: stripHtml(doc.content).slice(0, 120),
          docId: doc.id,
        } satisfies DocumentNodeData,
      })),
    [documents],
  );

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

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
        onNodesChange={onNodesChange}
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
