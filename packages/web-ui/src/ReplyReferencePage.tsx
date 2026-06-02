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
import { useTranslation } from "./i18n";

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
  const { t } = useTranslation();
  const [refs, setRefs] = useState<ReplyRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  const [filterChannelId, setFilterChannelId] = useState("");
  const [filterRootId, setFilterRootId] = useState("");

  const [chainModal, setChainModal] = useState(false);
  const [chainData, setChainData] = useState<ReplyRef[]>([]);
  const [chainLoading, setChainLoading] = useState(false);

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
      setError(err instanceof Error ? err.message : "加载引用记录失败");
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
      showToast("加载回复链失败", "error");
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
      showToast("加载对话树失败", "error");
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

  if (loading && refs.length === 0) return <div style={s.container}><Loading text={t("app.loading")} /></div>;
  if (error && refs.length === 0) return <div style={s.container}><ErrorBanner message={error} onRetry={loadRefs} /></div>;

  return (
    <div style={s.container}>
      <PageHeader title={t("reply_refs.title")} subtitle={t("reply_refs.subtitle")} />

      <div style={s.filterBar}>
        <div style={s.filterGroup}>
          <span style={s.filterLabel}>{t("reply_refs.channel")}</span>
          <TextInput
            value={filterChannelId}
            onChange={setFilterChannelId}
            placeholder={t("reply_refs.filter_channel")}
          />
        </div>
        <div style={s.filterGroup}>
          <span style={s.filterLabel}>根消息 ID</span>
          <TextInput
            value={filterRootId}
            onChange={setFilterRootId}
            placeholder="按根消息 ID 筛选..."
          />
        </div>
        <div style={s.filterActions}>
          <PrimaryButton small onClick={handleFilter}>应用</PrimaryButton>
          <GhostButton small onClick={() => { setFilterChannelId(""); setFilterRootId(""); }}>清除</GhostButton>
        </div>
      </div>

      <Card>
        {refs.length === 0 ? (
          <EmptyState title={t("reply_refs.no_refs")} description="未找到匹配当前筛选条件的引用记录" />
        ) : (
          <DataTable
            columns={[
              { key: "id", label: "ID", width: "90px", render: (r: ReplyRef) => (
                <span style={{ fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                  {r.id.slice(0, 8)}...
                </span>
              )},
              { key: "author", label: t("reply_refs.author"), render: (r: ReplyRef) => (
                <span style={{ fontWeight: 500 }}>{r.author || "-"}</span>
              )},
              { key: "content", label: t("reply_refs.content"), render: (r: ReplyRef) => (
                <span style={{ fontSize: "12px", color: "var(--text-secondary)", maxWidth: "300px", display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {truncate(r.content, 60)}
                </span>
              )},
              { key: "channelId", label: t("reply_refs.channel"), render: (r: ReplyRef) => (
                <span style={{ fontFamily: "monospace", fontSize: "11px" }}>{r.channelId || "-"}</span>
              )},
              { key: "timestamp", label: t("reply_refs.timestamp"), render: (r: ReplyRef) => (
                <span style={{ fontSize: "12px" }}>{formatTs(r.timestamp)}</span>
              )},
              {
                key: "actions", label: "操作", render: (r: ReplyRef) => (
                  <div style={{ display: "flex", gap: "4px" }}>
                    <GhostButton small onClick={() => handleViewChain(r.rootId)}>
                      {t("reply_refs.chain_view")}
                    </GhostButton>
                    <GhostButton small onClick={() => handleViewTree(r.rootId)}>
                      {t("reply_refs.tree_view")}
                    </GhostButton>
                  </div>
                ),
              },
            ]}
            data={refs}
            keyFn={(r, i) => r.id || String(i)}
            emptyText={t("reply_refs.no_refs")}
          />
        )}
      </Card>

      {chainModal && (
        <Modal
          title="回复链"
          onClose={() => setChainModal(false)}
          width={680}
        >
          {chainLoading ? (
            <Loading text={t("app.loading")} />
          ) : chainData.length === 0 ? (
            <EmptyState title="空链" description="此链中未找到回复" />
          ) : (
            <div style={s.timelineContainer}>
              {chainData.map((ref, idx) => (
                <div key={ref.id} style={s.timelineItem}>
                  {idx < chainData.length - 1 && <div style={s.timelineLine} />}
                  <div style={s.timelineDot}>{idx + 1}</div>
                  <div style={s.timelineContent}>
                    <div style={s.timelineAuthor}>{ref.author || "未知"}</div>
                    <div style={s.timelineText}>{ref.content}</div>
                    <div style={s.timelineMeta}>
                      <span>ID: {ref.id.slice(0, 12)}...</span>
                      <span>{formatTs(ref.timestamp)}</span>
                      {ref.channelId && <span>通道: {ref.channelId}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {treeModal && (
        <Modal
          title="对话树"
          onClose={() => setTreeModal(false)}
          width={720}
        >
          {treeLoading ? (
            <Loading text={t("app.loading")} />
          ) : !treeData || Object.keys(treeData.nodes).length === 0 ? (
            <EmptyState title="空树" description="无对话树数据" />
          ) : (
            <div style={s.treeContainer}>
              {(() => {
                const nodeIds = new Set(Object.keys(treeData.nodes));
                const childrenMap = buildChildrenMap(treeData.nodes, treeData.edges);
                const roots = findRootEdges(treeData.edges, nodeIds);
                if (roots.length === 0 && nodeIds.size > 0) {
                  return renderTreeNodes(Array.from(nodeIds), treeData.nodes, childrenMap, 0);
                }
                return renderTreeNodes(roots, treeData.nodes, childrenMap, 0);
              })()}
            </div>
          )}
        </Modal>
      )}

      <div style={s.footer}>
        每 15 秒自动刷新 &middot; {refs.length} 条引用
      </div>
    </div>
  );
}
