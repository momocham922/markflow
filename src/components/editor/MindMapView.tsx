import { useMemo } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { MindMapNode, type MindMapNodeData } from "./MindMapNode";

const nodeTypes = { mindmap: MindMapNode };

interface HeadingNode {
  id: string;
  label: string;
  level: number;
  children: HeadingNode[];
}

/**
 * Parse markdown content into a heading tree.
 * Returns a root node whose children are the top-level headings.
 */
function parseHeadings(content: string, docTitle: string): HeadingNode {
  const root: HeadingNode = { id: "root", label: docTitle || "Document", level: 0, children: [] };
  const lines = content.split("\n");

  // Stack tracks the path to the current parent at each level
  const stack: HeadingNode[] = [root];

  let headingIdx = 0;
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (!match) continue;

    const level = match[1].length;
    const label = match[2].trim();
    const node: HeadingNode = {
      id: `h-${headingIdx++}`,
      label,
      level,
      children: [],
    };

    // Pop stack until we find a parent with a lower level
    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  return root;
}

// Layout constants
const H_GAP = 200;    // horizontal gap between levels
const V_GAP = 16;     // vertical gap between sibling nodes
const NODE_HEIGHT = 36;

/**
 * Compute tree layout positions.
 * Returns flat arrays of nodes and edges for ReactFlow.
 */
function layoutTree(root: HeadingNode): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // First pass: compute subtree heights
  function subtreeHeight(node: HeadingNode): number {
    if (node.children.length === 0) return NODE_HEIGHT;
    let total = 0;
    for (const child of node.children) {
      total += subtreeHeight(child);
    }
    total += (node.children.length - 1) * V_GAP;
    return total;
  }

  // Second pass: assign positions
  function layout(node: HeadingNode, x: number, yStart: number, yEnd: number) {
    const yCenter = (yStart + yEnd) / 2;

    nodes.push({
      id: node.id,
      type: "mindmap",
      position: { x, y: yCenter - NODE_HEIGHT / 2 },
      data: { label: node.label, level: node.level } satisfies MindMapNodeData,
    });

    if (node.children.length === 0) return;

    const childX = x + H_GAP;
    const totalChildHeight = node.children.reduce(
      (sum, c) => sum + subtreeHeight(c),
      0,
    ) + (node.children.length - 1) * V_GAP;

    let childY = yCenter - totalChildHeight / 2;

    for (const child of node.children) {
      const h = subtreeHeight(child);
      const childYEnd = childY + h;

      edges.push({
        id: `${node.id}-${child.id}`,
        source: node.id,
        target: child.id,
        type: "smoothstep",
        style: { stroke: "oklch(0.65 0.15 270 / 0.4)", strokeWidth: 2 },
      });

      layout(child, childX, childY, childYEnd);
      childY = childYEnd + V_GAP;
    }
  }

  const totalH = subtreeHeight(root);
  layout(root, 50, -totalH / 2, totalH / 2);

  return { nodes, edges };
}

interface MindMapViewProps {
  content: string;
  title: string;
}

export function MindMapView({ content, title }: MindMapViewProps) {
  const { nodes, edges } = useMemo(() => {
    const tree = parseHeadings(content, title);
    // If no headings found, show just the root
    if (tree.children.length === 0) {
      return {
        nodes: [{
          id: "root",
          type: "mindmap",
          position: { x: 200, y: 200 },
          data: { label: title || "Document", level: 0 } satisfies MindMapNodeData,
        }],
        edges: [],
      };
    }
    return layoutTree(tree);
  }, [content, title]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll
        className="bg-background"
      >
        <Controls
          showInteractive={false}
          className="!bg-card !border-border !shadow-sm [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground"
        />
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  );
}
