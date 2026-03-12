import { useMemo } from "react";
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

    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  return root;
}

// Estimate rendered node width from label text and level
// Accounts for font size + padding differences per level
const LEVEL_CHAR_WIDTHS = [8.5, 8, 7, 6.5, 6.5, 6]; // px per char
const LEVEL_PADDING_X = [40, 32, 28, 24, 24, 20]; // total horizontal padding

/** Count CJK/fullwidth characters that render ~2x wider than Latin */
function countWideChars(text: string): number {
  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x3000 && cp <= 0x9FFF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFF01 && cp <= 0xFF60) ||
      (cp >= 0xAC00 && cp <= 0xD7AF)
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

// Estimate node height per level
const LEVEL_NODE_HEIGHTS = [40, 36, 32, 30, 28, 26];

function estimateNodeHeight(level: number): number {
  return LEVEL_NODE_HEIGHTS[Math.min(level, LEVEL_NODE_HEIGHTS.length - 1)];
}

// Layout constants
const H_GAP = 60;    // horizontal gap between node edge and child node start
const V_GAP = 24;    // vertical gap between sibling nodes

/**
 * Compute tree layout positions with dynamic sizing.
 * Returns flat arrays of nodes and edges for ReactFlow.
 */
function layoutTree(root: HeadingNode): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // First pass: compute subtree heights
  function subtreeHeight(node: HeadingNode): number {
    if (node.children.length === 0) return estimateNodeHeight(node.level);
    let total = 0;
    for (const child of node.children) {
      total += subtreeHeight(child);
    }
    total += (node.children.length - 1) * V_GAP;
    return total;
  }

  // Second pass: assign positions
  function layout(node: HeadingNode, x: number, yStart: number, yEnd: number) {
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
        type: "default",
        style: { stroke: "oklch(0.65 0.15 270 / 0.35)", strokeWidth: 1.5 },
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
        connectionLineType={ConnectionLineType.Bezier}
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
          className="bg-card! border-border! shadow-sm! [&>button]:bg-card! [&>button]:border-border! [&>button]:text-foreground!"
        />
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  );
}
