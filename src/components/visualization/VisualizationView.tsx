import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  FileText,
  Link2,
  ArrowLeftRight,
  AlertCircle,
  Filter,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore, type Document } from "@/stores/app-store";
import { KnowledgeNode } from "./KnowledgeNode";

const nodeTypes = { knowledge: KnowledgeNode };

// --- Wiki-link parsing ---

function extractWikiLinks(content: string): string[] {
  // Strip code blocks first
  const stripped = content.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");
  const links: string[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(stripped)) !== null) {
    links.push(match[1].trim().toLowerCase());
  }
  return [...new Set(links)];
}

interface LinkInfo {
  from: string; // docId
  to: string; // docId
  label: string; // original wiki-link text
}

interface GraphData {
  links: LinkInfo[];
  backlinkMap: Map<string, Set<string>>; // docId → Set of docIds that link TO this doc
  forwardLinkMap: Map<string, Set<string>>; // docId → Set of docIds this doc links TO
  orphanIds: Set<string>;
}

function buildLinkData(documents: Document[]): GraphData {
  const titleToId = new Map<string, string>();
  for (const doc of documents) {
    titleToId.set(doc.title.trim().toLowerCase(), doc.id);
  }

  const links: LinkInfo[] = [];
  const backlinkMap = new Map<string, Set<string>>();
  const forwardLinkMap = new Map<string, Set<string>>();
  const connectedIds = new Set<string>();

  for (const doc of documents) {
    const wikiLinks = extractWikiLinks(doc.content);
    for (const linkTitle of wikiLinks) {
      const targetId = titleToId.get(linkTitle);
      if (targetId && targetId !== doc.id) {
        links.push({ from: doc.id, to: targetId, label: linkTitle });
        connectedIds.add(doc.id);
        connectedIds.add(targetId);

        if (!backlinkMap.has(targetId)) backlinkMap.set(targetId, new Set());
        backlinkMap.get(targetId)!.add(doc.id);

        if (!forwardLinkMap.has(doc.id)) forwardLinkMap.set(doc.id, new Set());
        forwardLinkMap.get(doc.id)!.add(targetId);
      }
    }
  }

  const orphanIds = new Set(
    documents.filter((d) => !connectedIds.has(d.id)).map((d) => d.id),
  );

  return { links, backlinkMap, forwardLinkMap, orphanIds };
}

// --- Force-directed layout ---

interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function forceLayout(
  documents: Document[],
  links: LinkInfo[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const nodes: SimNode[] = documents.map((d) => ({
    id: d.id,
    x: width / 2 + (Math.random() - 0.5) * Math.min(width, 600),
    y: height / 2 + (Math.random() - 0.5) * Math.min(height, 400),
    vx: 0,
    vy: 0,
  }));

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const iterations = 150;
  const repulsion = 5000;
  const attraction = 0.008;
  const centerPull = 0.002;
  const damping = 0.85;

  for (let iter = 0; iter < iterations; iter++) {
    const temp = 1 - iter / iterations;

    // Repulsion between all pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = (repulsion * temp) / (dist * dist);
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        a.vx -= dx;
        a.vy -= dy;
        b.vx += dx;
        b.vy += dy;
      }
    }

    // Attraction along links
    for (const link of links) {
      const a = nodeMap.get(link.from);
      const b = nodeMap.get(link.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const force = attraction * temp;
      a.vx += dx * force;
      a.vy += dy * force;
      b.vx -= dx * force;
      b.vy -= dy * force;
    }

    // Center gravity
    for (const n of nodes) {
      n.vx += (width / 2 - n.x) * centerPull;
      n.vy += (height / 2 - n.y) * centerPull;
    }

    // Apply velocities
    for (const n of nodes) {
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    positions.set(n.id, { x: n.x, y: n.y });
  }
  return positions;
}

// --- Detail Panel ---

function DetailPanel({
  doc,
  documents,
  backlinkMap,
  forwardLinkMap,
  onNavigate,
  onClose,
}: {
  doc: Document;
  documents: Document[];
  backlinkMap: Map<string, Set<string>>;
  forwardLinkMap: Map<string, Set<string>>;
  onNavigate: (docId: string) => void;
  onClose: () => void;
}) {
  const backlinks = backlinkMap.get(doc.id);
  const forwardLinks = forwardLinkMap.get(doc.id);
  const docMap = new Map(documents.map((d) => [d.id, d]));

  return (
    <div className="absolute right-0 top-0 bottom-0 w-64 bg-background border-l border-border shadow-lg z-10 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-sm font-medium truncate">{doc.title}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 cursor-pointer"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 text-xs">
        {/* Forward links */}
        <div>
          <div className="flex items-center gap-1.5 text-blue-500 mb-1.5">
            <Link2 className="h-3 w-3" />
            <span className="font-medium">Links ({forwardLinks?.size ?? 0})</span>
          </div>
          {forwardLinks && forwardLinks.size > 0 ? (
            <ul className="space-y-1">
              {[...forwardLinks].map((id) => {
                const target = docMap.get(id);
                return target ? (
                  <li key={id}>
                    <button
                      className="flex items-center gap-1.5 text-left hover:text-primary transition-colors w-full cursor-pointer"
                      onClick={() => onNavigate(id)}
                    >
                      <FileText className="h-3 w-3 shrink-0" />
                      <span className="truncate">{target.title}</span>
                    </button>
                  </li>
                ) : null;
              })}
            </ul>
          ) : (
            <p className="text-muted-foreground">No outgoing links</p>
          )}
        </div>

        {/* Backlinks */}
        <div>
          <div className="flex items-center gap-1.5 text-emerald-500 mb-1.5">
            <ArrowLeftRight className="h-3 w-3" />
            <span className="font-medium">Backlinks ({backlinks?.size ?? 0})</span>
          </div>
          {backlinks && backlinks.size > 0 ? (
            <ul className="space-y-1">
              {[...backlinks].map((id) => {
                const source = docMap.get(id);
                return source ? (
                  <li key={id}>
                    <button
                      className="flex items-center gap-1.5 text-left hover:text-primary transition-colors w-full cursor-pointer"
                      onClick={() => onNavigate(id)}
                    >
                      <FileText className="h-3 w-3 shrink-0" />
                      <span className="truncate">{source.title}</span>
                    </button>
                  </li>
                ) : null;
              })}
            </ul>
          ) : (
            <p className="text-muted-foreground">No backlinks</p>
          )}
        </div>

        {/* Meta */}
        <div className="text-muted-foreground space-y-1">
          {doc.folder && doc.folder !== "/" && (
            <p>Folder: {doc.folder}</p>
          )}
          {doc.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {doc.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-block rounded-full bg-primary/10 px-1.5 py-0 text-[9px] text-primary"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border p-2 shrink-0">
        <Button
          size="sm"
          variant="secondary"
          className="w-full text-xs cursor-pointer"
          onClick={() => onNavigate(doc.id)}
        >
          Open in Editor
        </Button>
      </div>
    </div>
  );
}

// --- Main Graph Component (needs ReactFlowProvider) ---

function KnowledgeGraphInner() {
  const { documents, setActiveDocId } = useAppStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [filterFolder, setFilterFolder] = useState<string | null>(null);
  const [showOrphans, setShowOrphans] = useState(true);
  const { fitView } = useReactFlow();

  // Build link data
  const graphData = useMemo(() => buildLinkData(documents), [documents]);

  // Filter documents
  const filteredDocs = useMemo(() => {
    let docs = documents;
    if (filterFolder) {
      docs = docs.filter((d) => (d.folder || "/") === filterFolder);
    }
    if (!showOrphans) {
      docs = docs.filter((d) => !graphData.orphanIds.has(d.id));
    }
    return docs;
  }, [documents, filterFolder, showOrphans, graphData.orphanIds]);

  // Compute layout
  const positions = useMemo(() => {
    const w = 800;
    const h = 600;
    const filteredLinks = graphData.links.filter(
      (l) =>
        filteredDocs.some((d) => d.id === l.from) &&
        filteredDocs.some((d) => d.id === l.to),
    );
    return forceLayout(filteredDocs, filteredLinks, w, h);
  }, [filteredDocs, graphData.links]);

  // Build nodes
  const initialNodes: Node[] = useMemo(
    () =>
      filteredDocs.map((doc) => {
        const pos = positions.get(doc.id) || { x: 0, y: 0 };
        return {
          id: doc.id,
          type: "knowledge",
          position: pos,
          data: {
            label: doc.title,
            docId: doc.id,
            linkCount: graphData.forwardLinkMap.get(doc.id)?.size ?? 0,
            backlinkCount: graphData.backlinkMap.get(doc.id)?.size ?? 0,
            isOrphan: graphData.orphanIds.has(doc.id),
            isActive: doc.id === selectedDocId,
            folder: doc.folder || "/",
            tags: doc.tags,
          },
        };
      }),
    [filteredDocs, positions, graphData, selectedDocId],
  );

  // Build edges
  const initialEdges: Edge[] = useMemo(() => {
    const filteredIds = new Set(filteredDocs.map((d) => d.id));
    return graphData.links
      .filter((l) => filteredIds.has(l.from) && filteredIds.has(l.to))
      .map((l, i) => ({
        id: `link-${i}`,
        source: l.from,
        target: l.to,
        animated: l.from === selectedDocId || l.to === selectedDocId,
        style: {
          stroke:
            l.from === selectedDocId
              ? "var(--color-blue-500)"
              : l.to === selectedDocId
                ? "var(--color-emerald-500)"
                : "var(--border)",
          strokeWidth: l.from === selectedDocId || l.to === selectedDocId ? 2 : 1,
          opacity: selectedDocId
            ? l.from === selectedDocId || l.to === selectedDocId
              ? 1
              : 0.15
            : 0.6,
        },
      }));
  }, [graphData.links, filteredDocs, selectedDocId]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  // Re-fit view when layout changes
  useEffect(() => {
    const timer = setTimeout(() => fitView({ padding: 0.15 }), 50);
    return () => clearTimeout(timer);
  }, [positions, fitView]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedDocId((prev) => (prev === node.id ? null : node.id));
  }, []);

  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setActiveDocId(node.id);
    },
    [setActiveDocId],
  );

  const handleNavigate = useCallback(
    (docId: string) => {
      setActiveDocId(docId);
    },
    [setActiveDocId],
  );

  // Stats
  const totalLinks = graphData.links.length;
  const orphanCount = graphData.orphanIds.size;
  const folders = [...new Set(documents.map((d) => d.folder || "/"))].sort();
  const selectedDoc = selectedDocId
    ? documents.find((d) => d.id === selectedDocId)
    : null;

  return (
    <div ref={containerRef} className="h-full w-full flex flex-col relative">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-muted/30 text-xs text-muted-foreground shrink-0 flex-wrap">
        <span>{filteredDocs.length} documents</span>
        <span>{totalLinks} wiki-links</span>
        {orphanCount > 0 && (
          <span className="flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            {orphanCount} orphans
          </span>
        )}
        <div className="flex-1" />
        {/* Filter: show orphans */}
        <button
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors cursor-pointer ${
            showOrphans
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setShowOrphans(!showOrphans)}
        >
          <AlertCircle className="h-3 w-3" />
          Orphans
        </button>
        {/* Filter: folder */}
        {folders.length > 1 && (
          <div className="flex items-center gap-1">
            <Filter className="h-3 w-3" />
            <select
              className="bg-transparent border border-border rounded px-1 py-0.5 text-[10px] cursor-pointer"
              value={filterFolder || ""}
              onChange={(e) =>
                setFilterFolder(e.target.value || null)
              }
            >
              <option value="">All folders</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f === "/" ? "Root" : f}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Hint */}
      {documents.length > 0 && totalLinks === 0 && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 bg-card border border-border rounded-lg px-4 py-3 shadow-md text-center max-w-xs">
          <p className="text-xs text-muted-foreground">
            Use <code className="bg-muted px-1 rounded text-[10px]">[[document title]]</code> in your Markdown to create links between documents. The knowledge graph will visualize these connections.
          </p>
        </div>
      )}

      {/* Graph */}
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          nodeTypes={nodeTypes}
          minZoom={0.1}
          maxZoom={3}
          proOptions={{ hideAttribution: true }}
          onPaneClick={() => setSelectedDocId(null)}
        >
          <Controls showInteractive={false} />
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        </ReactFlow>
      </div>

      {/* Detail panel */}
      {selectedDoc && (
        <DetailPanel
          doc={selectedDoc}
          documents={documents}
          backlinkMap={graphData.backlinkMap}
          forwardLinkMap={graphData.forwardLinkMap}
          onNavigate={handleNavigate}
          onClose={() => setSelectedDocId(null)}
        />
      )}
    </div>
  );
}

export function VisualizationView() {
  return (
    <ReactFlowProvider>
      <KnowledgeGraphInner />
    </ReactFlowProvider>
  );
}
