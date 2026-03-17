import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
  ConnectionLineType,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAppStore, type Document } from "@/stores/app-store";
import { FolderNode } from "./FolderNode";
import { DocNode } from "./DocNode";
import { TagNode } from "./TagNode";

const nodeTypes = {
  folder: FolderNode,
  doc: DocNode,
  tag: TagNode,
};

interface FolderGroup {
  path: string;
  label: string;
  docs: Document[];
}

function buildFolderGroups(documents: Document[]): FolderGroup[] {
  const map = new Map<string, Document[]>();
  for (const doc of documents) {
    const folder = doc.folder || "/";
    if (!map.has(folder)) map.set(folder, []);
    map.get(folder)!.push(doc);
  }
  const groups: FolderGroup[] = [];
  for (const [path, docs] of map) {
    const label = path === "/" ? "Root" : path.split("/").filter(Boolean).pop() || path;
    groups.push({ path, label, docs });
  }
  // Sort: root first, then alphabetically
  groups.sort((a, b) => {
    if (a.path === "/") return -1;
    if (b.path === "/") return 1;
    return a.path.localeCompare(b.path);
  });
  return groups;
}

function getWordCount(content: string): number {
  const text = content.replace(/<[^>]*>/g, "").trim();
  if (!text) return 0;
  return text.split(/\s+/).length;
}

function buildGraph(
  documents: Document[],
  showTags: boolean,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const groups = buildFolderGroups(documents);

  // Layout constants
  const folderSpacingX = 320;
  const docSpacingY = 60;
  const folderStartY = 0;
  const tagStartX = -300;

  // Collect all tags for tag view
  const tagMap = new Map<string, string[]>(); // tag → docIds

  let folderX = 0;
  for (const group of groups) {
    const totalDocs = group.docs.length;
    const totalWords = group.docs.reduce((sum, d) => sum + getWordCount(d.content), 0);

    // Folder node
    nodes.push({
      id: `folder-${group.path}`,
      type: "folder",
      position: { x: folderX, y: folderStartY },
      data: {
        label: group.label,
        path: group.path,
        docCount: totalDocs,
        wordCount: totalWords,
      },
    });

    // Document nodes under this folder
    let docY = folderStartY + 80;
    for (const doc of group.docs) {
      const docNodeId = `doc-${doc.id}`;
      nodes.push({
        id: docNodeId,
        type: "doc",
        position: { x: folderX, y: docY },
        data: {
          label: doc.title,
          docId: doc.id,
          wordCount: getWordCount(doc.content),
          tags: doc.tags,
          isShared: doc.isShared,
        },
      });

      edges.push({
        id: `e-folder-${group.path}-${doc.id}`,
        source: `folder-${group.path}`,
        target: docNodeId,
        type: ConnectionLineType.SmoothStep,
        style: { stroke: "var(--border)", strokeWidth: 1.5 },
      });

      // Track tags
      if (showTags) {
        for (const tag of doc.tags) {
          if (!tagMap.has(tag)) tagMap.set(tag, []);
          tagMap.get(tag)!.push(docNodeId);
        }
      }

      docY += docSpacingY;
    }

    folderX += folderSpacingX;
  }

  // Tag nodes
  if (showTags && tagMap.size > 0) {
    let tagY = 0;
    for (const [tag, docIds] of tagMap) {
      const tagNodeId = `tag-${tag}`;
      nodes.push({
        id: tagNodeId,
        type: "tag",
        position: { x: tagStartX, y: tagY },
        data: { label: tag, docCount: docIds.length },
      });

      for (const docId of docIds) {
        edges.push({
          id: `e-tag-${tag}-${docId}`,
          source: tagNodeId,
          target: docId,
          type: ConnectionLineType.SmoothStep,
          animated: true,
          style: { stroke: "var(--primary)", strokeWidth: 1, opacity: 0.4 },
        });
      }

      tagY += 50;
    }
  }

  return { nodes, edges };
}

export function VisualizationView() {
  const { documents, setActiveDocId } = useAppStore();

  const { initialNodes, initialEdges } = useMemo(() => {
    const hasTags = documents.some((d) => d.tags.length > 0);
    const { nodes, edges } = buildGraph(documents, hasTags);
    return { initialNodes: nodes, initialEdges: edges };
  }, [documents]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [reactEdges, , onEdgesChange] = useEdgesState(initialEdges);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type === "doc" && node.data.docId) {
        setActiveDocId(node.data.docId as string);
      }
    },
    [setActiveDocId],
  );

  // Summary stats
  const totalDocs = documents.length;
  const totalWords = documents.reduce((sum, d) => sum + getWordCount(d.content), 0);
  const folderCount = new Set(documents.map((d) => d.folder || "/")).size;
  const tagCount = new Set(documents.flatMap((d) => d.tags)).size;

  return (
    <div className="h-full w-full flex flex-col">
      {/* Summary bar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-muted/30 text-xs text-muted-foreground shrink-0">
        <span>{totalDocs} documents</span>
        <span>{folderCount} folders</span>
        {tagCount > 0 && <span>{tagCount} tags</span>}
        <span>{totalWords.toLocaleString()} words total</span>
      </div>
      {/* Graph */}
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={reactEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} />
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        </ReactFlow>
      </div>
    </div>
  );
}
