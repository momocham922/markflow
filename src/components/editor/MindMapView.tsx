import { useEffect, useMemo, useState } from "react";
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
import {
  MindMapNode,
  type MindMapNodeData,
  mindMapThemes,
  type MindMapThemeId,
  type EdgeStyle,
} from "./MindMapNode";
import { useAppStore } from "@/stores/app-store";

const nodeTypes = { mindmap: MindMapNode };

interface HeadingNode {
  id: string;
  label: string;
  level: number;
  lineNumber: number;
  children: HeadingNode[];
}

/**
 * Parse markdown content into a heading tree.
 * Returns a root node whose children are the top-level headings.
 */
function parseHeadings(content: string, docTitle: string): HeadingNode {
  const root: HeadingNode = {
    id: "root",
    label: docTitle || "Document",
    level: 0,
    lineNumber: 0,
    children: [],
  };
  const lines = content.split("\n");

  const stack: HeadingNode[] = [root];

  let headingIdx = 0;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (!match) continue;

    const level = match[1].length;
    const label = match[2].trim();
    const node: HeadingNode = {
      id: `h-${headingIdx++}`,
      label,
      level,
      lineNumber: lineIdx,
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
      (cp >= 0x3000 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    )
      count++;
  }
  return count;
}

function estimateNodeWidth(label: string, level: number): number {
  const idx = Math.min(level, LEVEL_CHAR_WIDTHS.length - 1);
  const charW = LEVEL_CHAR_WIDTHS[idx];
  const wide = countWideChars(label);
  const narrow = label.length - wide;
  return Math.max(
    narrow * charW + wide * charW * 1.8 + LEVEL_PADDING_X[idx],
    60,
  );
}

// Estimate node height per level
const LEVEL_NODE_HEIGHTS = [40, 36, 32, 30, 28, 26];

function estimateNodeHeight(level: number): number {
  return LEVEL_NODE_HEIGHTS[Math.min(level, LEVEL_NODE_HEIGHTS.length - 1)];
}

// Layout constants
const H_GAP = 60; // horizontal gap between node edge and child node start
const V_GAP = 24; // vertical gap between sibling nodes

// Bloom entrance: each deeper tree level starts this many ms later, so the
// animation ripples outward from the root ("ぶわっと吹き出す").
const BLOOM_STAGGER = 55;

/**
 * Compute tree layout positions with dynamic sizing.
 * Returns flat arrays of nodes and edges for ReactFlow.
 */
function layoutTree(
  root: HeadingNode,
  themeId: MindMapThemeId = "lavender",
): { nodes: Node[]; edges: Edge[] } {
  const themeObj = mindMapThemes[themeId] ?? mindMapThemes.lavender;
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

  // Second pass: assign positions.
  // `depth` is the distance from the root (0 = root) and drives the bloom
  // stagger. `parentPos` is the parent node's top-left in canvas space; the
  // child's bloom offset (dx,dy) is the vector from the child back to the
  // parent, so the entrance keyframe starts the child sitting on its parent.
  function layout(
    node: HeadingNode,
    x: number,
    yStart: number,
    yEnd: number,
    depth: number,
    parentPos?: { x: number; y: number },
  ) {
    const nodeH = estimateNodeHeight(node.level);
    const yCenter = (yStart + yEnd) / 2;
    const nodeY = yCenter - nodeH / 2;

    nodes.push({
      id: node.id,
      type: "mindmap",
      position: { x, y: nodeY },
      // Give React Flow up-front dimensions. Without them it renders each node
      // wrapper with `visibility:hidden` until its ResizeObserver measures the
      // box — but CSS animations keep running while hidden, so on a slow mobile
      // WebView the whole bloom plays out invisibly and nodes just pop in. With
      // initial sizes the wrapper is visible from first paint, so the bloom is
      // actually seen; the observer still refines to the measured size after.
      initialWidth: estimateNodeWidth(node.label, node.level),
      initialHeight: nodeH,
      data: {
        label: node.label,
        level: node.level,
        themeId,
        lineNumber: node.lineNumber,
        dx: parentPos ? parentPos.x - x : 0,
        dy: parentPos ? parentPos.y - nodeY : 0,
        delay: depth * BLOOM_STAGGER,
      } satisfies MindMapNodeData,
    });

    if (node.children.length === 0) return;

    const nodeW = estimateNodeWidth(node.label, node.level);
    const childX = x + nodeW + H_GAP;
    const totalChildHeight =
      node.children.reduce((sum, c) => sum + subtreeHeight(c), 0) +
      (node.children.length - 1) * V_GAP;

    let childY = yCenter - totalChildHeight / 2;

    for (const child of node.children) {
      const h = subtreeHeight(child);
      const childYEnd = childY + h;

      const edgeTypeMap: Record<EdgeStyle, string> = {
        bezier: "default",
        straight: "straight",
        step: "smoothstep",
      };
      edges.push({
        id: `${node.id}-${child.id}`,
        source: node.id,
        target: child.id,
        type: edgeTypeMap[themeObj.edgeStyle] ?? "default",
        style: {
          stroke: themeObj.edgeColor,
          strokeWidth: themeObj.edgeStyle === "step" ? 2 : 1.5,
        },
      });

      layout(child, childX, childY, childYEnd, depth + 1, { x, y: nodeY });
      childY = childYEnd + V_GAP;
    }
  }

  const totalH = subtreeHeight(root);
  layout(root, 50, -totalH / 2, totalH / 2, 0);

  return { nodes, edges };
}

interface MindMapViewProps {
  content: string;
  title: string;
  onNodeClick?: (info: { lineNumber: number; text: string }) => void;
  // Remounts ReactFlow when the doc changes so the bloom entrance replays on
  // every open / doc switch (CSS animations only fire on mount).
  docId?: string;
}

export function MindMapView({
  content,
  title,
  onNodeClick,
  docId,
}: MindMapViewProps) {
  const mindMapTheme = (useAppStore((s) => s.themeSettings.mindMapTheme) ||
    "lavender") as MindMapThemeId;

  // The bloom entrance is MEASUREMENT-driven, not mount-driven. React Flow lays
  // nodes out around the origin and only centers them on-screen once it has
  // measured every node and run fitView — signalled by onInit (which fires when
  // the viewport is initialized). On a slow mobile WebView that lands well after
  // mount, so a mount-triggered CSS animation plays out entirely OFF-SCREEN
  // before fitView and the user never sees it (desktop is usually fast enough
  // that it doesn't). So we keep nodes hidden (opacity:0 in CSS) until `bloomArmed`
  // is set by onInit, and only then let the keyframe run — guaranteeing the burst
  // plays while the map is actually visible. Re-armed on each doc switch.
  const [bloomArmed, setBloomArmed] = useState(false);
  // Fail-safe: nodes start at opacity:0, so if the animation never fires (onInit
  // never arrives, backgrounded tab) they'd stay invisible. `bloom-settled`
  // force-shows every node/edge regardless of animation state.
  const [bloomSettled, setBloomSettled] = useState(false);
  // Reset DURING render (not in a passive effect) when the doc changes. This
  // component persists across doc switches — only the inner ReactFlow is keyed
  // by docId — so these flags survive. A passive useEffect reset fires AFTER
  // paint, letting the remounted ReactFlow paint its first frame carrying the
  // stale classes from the previous doc: the new map would flash fully-formed,
  // then collapse and re-bloom. React's "adjust state during render" pattern
  // applies the reset before paint, so no stale frame ships.
  const [prevDocId, setPrevDocId] = useState(docId);
  if (docId !== prevDocId) {
    setPrevDocId(docId);
    setBloomArmed(false);
    setBloomSettled(false);
  }
  // Once armed, settle to a plain static state after the bloom's worst-case
  // duration (0.42s keyframe + level stagger + edge fade).
  useEffect(() => {
    if (!bloomArmed) return;
    const t = setTimeout(() => setBloomSettled(true), 1200);
    return () => clearTimeout(t);
  }, [bloomArmed]);
  // Absolute fallback: if onInit somehow never fires, force-show the map anyway
  // so it can never stay invisible.
  useEffect(() => {
    const t = setTimeout(() => setBloomSettled(true), 4000);
    return () => clearTimeout(t);
  }, [docId]);

  const { nodes, edges } = useMemo(() => {
    const tree = parseHeadings(content, title);
    if (tree.children.length === 0) {
      return {
        nodes: [
          {
            id: "root",
            type: "mindmap",
            position: { x: 200, y: 200 },
            initialWidth: estimateNodeWidth(title || "Document", 0),
            initialHeight: estimateNodeHeight(0),
            data: {
              label: title || "Document",
              level: 0,
              themeId: mindMapTheme,
            } satisfies MindMapNodeData,
          },
        ],
        edges: [],
      };
    }
    return layoutTree(tree, mindMapTheme);
  }, [content, title, mindMapTheme]);

  return (
    <div className="relative h-full w-full">
      {/* Mind-map theme is chosen from the shared Theme dialog (Paintbrush in the
          editor toolbar), alongside the preview/editor themes — no separate
          floating picker here. */}
      <ReactFlow
        key={docId}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        connectionLineType={ConnectionLineType.Bezier}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        // Arm the bloom only once the viewport is initialized (all nodes measured
        // + fitView applied), so the entrance never plays off-screen on mobile.
        onInit={(instance) => {
          setBloomArmed(true);
          // The `fitView` PROP runs a single fit at viewport init, but on a slow
          // mobile WebView the pane often has no measured size and the node
          // ResizeObserver hasn't reported yet at that instant — so the one-shot
          // fit lands on wrong bounds and the tree stays clipped (root off the
          // left, deep labels off the right) and off-center. Re-fit once layout
          // settles (mirrors VisualizationView): rAF waits for the pane's real
          // dimensions, the timeouts cover async node measurement. duration:0 so
          // it snaps rather than animating over the bloom entrance.
          requestAnimationFrame(() =>
            instance.fitView({ padding: 0.3, duration: 0 }),
          );
          setTimeout(() => instance.fitView({ padding: 0.3, duration: 0 }), 80);
          setTimeout(
            () => instance.fitView({ padding: 0.3, duration: 0 }),
            350,
          );
        }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={!!onNodeClick}
        onNodeClick={
          onNodeClick
            ? (_event, node) => {
                const data = node.data as unknown as MindMapNodeData;
                if (data.lineNumber != null)
                  onNodeClick({
                    lineNumber: data.lineNumber,
                    text: data.label,
                  });
              }
            : undefined
        }
        panOnDrag
        zoomOnScroll
        className={`bg-background mindmap-bloom${bloomArmed ? " bloom-armed" : ""}${bloomSettled ? " bloom-settled" : ""}`}
      >
        <Controls
          showInteractive={false}
          className="bg-card! border-border! shadow-sm! [&>button]:bg-card! [&>button]:border-border! [&>button]:text-foreground!"
        />
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--border)"
        />
      </ReactFlow>
    </div>
  );
}
