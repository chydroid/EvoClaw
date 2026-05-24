/**
 * ReplyReferencePage — Reply reference chain visualization.
 *
 * Browse message reply references, view reply chains as vertical timelines,
 * and explore conversation trees with hierarchical indentation.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState, Section,
  DataTable, TextInput, PrimaryButton, SecondaryButton, GhostButton, Modal, showToast,
} from "./shared";
import { replyRefApi } from "./api-client";
import type { ReplyRef } from "./api-client";

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)", width: "100%", boxSizing: "border-box" },
  filterBar: {
    display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap",
    marginBottom: "16px", padding: "12px 16px", background: "var(--bg-card)",
    borderRadius: "8px", border: "1px solid var(--border)",
  },
  filterGroup: { display: "flex", flexDirection: "column", gap: "4px", flex: "1", minWidth: "160px" },
  filterLabel: { fontSize: "11px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const },
  filterActions: { display: "flex", gap: "6px", alignItems: "flex-end" },
  timelineContainer: { padding: "16px 0" },
  timelineItem: { display: "flex", gap: "16px", position: "relative" as const, paddingBottom: "24px" },
  timelineLine: {
    position: "absolute" as const, left: "12px", top: "30px", bottom: 0,
    width: "2px", background: "var(--border)",
  },
  timelineDot: {
    width: "26px", height: "26px", borderRadius: "50%", flexShrink: 0,
    background: "var(--accent-bg)", border: "2px solid var(--accent)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "11px", fontWeight: 700, color: "var(--accent)", zIndex: 1,
  },
  timelineContent: {
    flex: 1, minWidth: 0, background: "var(--bg-card)", border: "1px solid var(--border)",
    borderRadius: "8px", padding: "14px 16px",
  },
  timelineAuthor: { fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" },
  timelineText: { fontSize: "13px", color: "var(--text-secondary)", marginTop: "6px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  timelineMeta: { fontSize: "11px", color: "var(--text-muted)", marginTop: "6px", display: "flex", gap: "12px" },
  treeContainer: { padding: "8px 0", fontFamily: "monospace" },
  treeNode: { padding: "6px 0" },
  treeLabel: { fontSize: "12px", color: "var(--text-secondary)" },
  treeId: { fontSize: "11px", color: "var(--text-muted)", marginLeft: "8px", fontFamily: "monospace" },
  treeAuthor: { fontWeight: 600, color: "var(--accent)" },
  treeContent: { color: "var(--text-primary)" },
  footer: { color: "var(--text-muted)", fontSize: "10px", textAlign: "center", marginTop: "16px" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text: string, maxLen = 80): string {
  if (!text) return "-";
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

function formatTs(ts: string): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "numeric" });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ReplyReferencePage() {
  const [refs, setRefs] = useState<ReplyRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  // Filters
  const [filterChannelId, setFilterChannelId] = useState("");
  const [filterRootId, setFilterRootId] = useState("");

  // Chain modal
  const [chainModal, setChainModal] = useState(false);
  const [chainData, setChainData] = useState<ReplyRef[]>([]);
  const [chainLoading, setChainLoading] = useState(false);

  // Tree modal
  const [treeModal, setTreeModal] = useState(false);
  const [treeData, setTreeData] = useState<{
    nodes: Record<string, ReplyRef>;
    edges: Array<{ from: string; to: string }>;
  } | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);

  // ─── Data loading ─────────────────────────────────────────────────────────

  const loadRefs = useCallback(async () => {
    try {
      const data = await replyRefApi.list({
        channelId: filterChannelId || undefined,
        rootId: filterRootId || undefined,
      });
      setRefs(data.refs || []);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load reply refs");
    } finally {
      setLoading(false);
    }
  }, [filterChannelId, filterRootId]);

  useEffect(() => {
    loadRefs();
    const interval = setInterval(loadRefs, 15000);
    return () => clearInterval(interval);
  }, [loadRefs]);

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleViewChain = useCallback(async (rootId: string) => {
    setChainModal(true);
    setChainLoading(true);
    setChainData([]);
    try {
      const data = await replyRefApi.getChain(rootId);
      setChainData(data.chain || []);
    } catch {
      showToast("Failed to load reply chain", "error");
    } finally {
      setChainLoading(false);
    }
  }, []);

  const handleViewTree = useCallback(async (rootId: string) => {
    setTreeModal(true);
    setTreeLoading(true);
    setTreeData(null);
    try {
      const data = await replyRefApi.getTree(rootId);
      setTreeData(data.tree);
    } catch {
      showToast("Failed to load conversation tree", "error");
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const handleFilter = useCallback(() => {
    setLoading(true);
    loadRefs();
  }, [loadRefs]);

  // ─── Tree rendering ──────────────────────────────────────────────────────

  function buildChildrenMap(
    nodes: Record<string, ReplyRef>,
    edges: Array<{ from: string; to: string }>,
  ): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const e of edges) {
      if (!map[e.from]) map[e.from] = [];
      map[e.from].push(e.to);
    }
    return map;
  }

  function findRootEdges(edges: Array<{ from: string; to: string }>, nodeIds: Set<string>): string[] {
    // Root nodes are those that appear as "from" but not as "to"
    const toSet = new Set(edges.map((e) => e.to));
    return Array.from(nodeIds).filter((id) => !toSet.has(id));
  }

  function renderTreeNodes(
    nodeIds: string[],
    nodes: Record<string, ReplyRef>,
    childrenMap: Record<string, string[]>,
    depth: number,
  ): React.ReactNode[] {
    const results: React.ReactNode[] = [];
    for (const id of nodeIds) {
      const node = nodes[id];
      if (!node) continue;
      const indent = "\u2502  ".repeat(depth);
      const prefix = depth > 0 ? "\u251c\u2500 " : "";
      results.push(
        <div key={id} style={{ ...s.treeNode, paddingLeft: `${depth * 20}px` }}>
          <span style={s.treeLabel}>
            <span style={s.treeAuthor}>{node.author}</span>
            <span style={s.treeId}>{node.id.slice(0, 8)}</span>
          </span>
          <div style={{ ...s.treeContent, marginTop: "2px" }}>{truncate(node.content, 100)}</div>
        </div>,
      );
      const children = childrenMap[id];
      if (children && children.length > 0) {
        results.push(...renderTreeNodes(children, nodes, childrenMap, depth + 1));
      }
    }
    return results;
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading && refs.length === 0) return <div style={s.container}><Loading text="Loading reply references..." /></div>;
  if (error && refs.length === 0) return <div style={s.container}><ErrorBanner message={error} onRetry={loadRefs} /></div>;

  return (
    <div style={s.container}>
      <PageHeader title="Reply References" subtitle="View message reply chains and conversation trees" />

      {/* Filter Bar */}
      <div style={s.filterBar}>
        <div style={s.filterGroup}>
          <span style={s.filterLabel}>Channel ID</span>
          <TextInput
            value={filterChannelId}
            onChange={setFilterChannelId}
            placeholder="Filter by channel..."
          />
        </div>
        <div style={s.filterGroup}>
          <span style={s.filterLabel}>Root Message ID</span>
          <TextInput
            value={filterRootId}
            onChange={setFilterRootId}
            placeholder="Filter by root ID..."
          />
        </div>
        <div style={s.filterActions}>
          <PrimaryButton small onClick={handleFilter}>Apply</PrimaryButton>
          <GhostButton small onClick={() => { setFilterChannelId(""); setFilterRootId(""); }}>Clear</GhostButton>
        </div>
      </div>

      {/* Data Table */}
      <Card>
        {refs.length === 0 ? (
          <EmptyState title="No reply references" description="No reply references found matching the current filters." />
        ) : (
          <DataTable
            columns={[
              { key: "id", label: "ID", width: "90px", render: (r: ReplyRef) => (
                <span style={{ fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                  {r.id.slice(0, 8)}...
                </span>
              )},
              { key: "author", label: "Author", render: (r: ReplyRef) => (
                <span style={{ fontWeight: 500 }}>{r.author || "-"}</span>
              )},
              { key: "content", label: "Content", render: (r: ReplyRef) => (
                <span style={{ fontSize: "12px", color: "var(--text-secondary)", maxWidth: "300px", display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {truncate(r.content, 60)}
                </span>
              )},
              { key: "channelId", label: "Channel", render: (r: ReplyRef) => (
                <span style={{ fontFamily: "monospace", fontSize: "11px" }}>{r.channelId || "-"}</span>
              )},
              { key: "timestamp", label: "Timestamp", render: (r: ReplyRef) => (
                <span style={{ fontSize: "12px" }}>{formatTs(r.timestamp)}</span>
              )},
              {
                key: "actions", label: "Actions", render: (r: ReplyRef) => (
                  <div style={{ display: "flex", gap: "4px" }}>
                    <GhostButton small onClick={() => handleViewChain(r.rootId)}>
                      View Chain
                    </GhostButton>
                    <GhostButton small onClick={() => handleViewTree(r.rootId)}>
                      View Tree
                    </GhostButton>
                  </div>
                ),
              },
            ]}
            data={refs}
            keyFn={(r, i) => r.id || String(i)}
            emptyText="No reply references"
          />
        )}
      </Card>

      {/* Chain Modal */}
      {chainModal && (
        <Modal
          title="Reply Chain"
          onClose={() => setChainModal(false)}
          width={680}
        >
          {chainLoading ? (
            <Loading text="Loading chain..." />
          ) : chainData.length === 0 ? (
            <EmptyState title="Empty chain" description="No replies found in this chain." />
          ) : (
            <div style={s.timelineContainer}>
              {chainData.map((ref, idx) => (
                <div key={ref.id} style={s.timelineItem}>
                  {idx < chainData.length - 1 && <div style={s.timelineLine} />}
                  <div style={s.timelineDot}>{idx + 1}</div>
                  <div style={s.timelineContent}>
                    <div style={s.timelineAuthor}>{ref.author || "Unknown"}</div>
                    <div style={s.timelineText}>{ref.content}</div>
                    <div style={s.timelineMeta}>
                      <span>ID: {ref.id.slice(0, 12)}...</span>
                      <span>{formatTs(ref.timestamp)}</span>
                      {ref.channelId && <span>Channel: {ref.channelId}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {/* Tree Modal */}
      {treeModal && (
        <Modal
          title="Conversation Tree"
          onClose={() => setTreeModal(false)}
          width={720}
        >
          {treeLoading ? (
            <Loading text="Loading tree..." />
          ) : !treeData || Object.keys(treeData.nodes).length === 0 ? (
            <EmptyState title="Empty tree" description="No conversation tree data available." />
          ) : (
            <div style={s.treeContainer}>
              {(() => {
                const nodeIds = new Set(Object.keys(treeData.nodes));
                const childrenMap = buildChildrenMap(treeData.nodes, treeData.edges);
                const roots = findRootEdges(treeData.edges, nodeIds);
                if (roots.length === 0 && nodeIds.size > 0) {
                  // Fallback: show all nodes at root level
                  return renderTreeNodes(Array.from(nodeIds), treeData.nodes, childrenMap, 0);
                }
                return renderTreeNodes(roots, treeData.nodes, childrenMap, 0);
              })()}
            </div>
          )}
        </Modal>
      )}

      <div style={s.footer}>
        Auto-refreshing every 15 seconds &middot; {refs.length} references
      </div>
    </div>
  );
}