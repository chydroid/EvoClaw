/**
 * MemoryHubPage — 分层记忆中心
 *
 * 展示 EvoClaw v0.68+ 借鉴 TencentDB-Agent-Memory 的 L0→L3 语义金字塔：
 *   L0 ConversationRecorder  — 原始对话流水（JSONL 持久化）
 *   L1 AtomicMemoryExtractor — 原子记忆（5 类：fact/preference/skill/scene/persona）
 *   L2 SceneBlockAggregator  — 情境块（按 sessionKey + 时间窗口聚合）
 *   L3 PersonaProfileGenerator — 人格画像（长期偏好与习惯）
 *   +  SymbolicMemoryCanvas  — 符号画布（任务节点图，借鉴 Infinite-Canvas）
 *   +  RecallBudget          — 召回预算（防止单条超长记忆撑爆 prompt）
 *
 * 同时展示工具结果缓存（ToolResultCache）与 Token 预算（TokenBudgetOptimizer）状态。
 */
import React, { useEffect, useState, useCallback } from "react";
import { PageHeader, Card, Badge, Loading, ErrorBanner } from "./shared";
import { useTranslation } from "./i18n";

// ── API 响应类型 ──────────────────────────────────────────────

interface LayeredStats {
  active: boolean;
  turnCount: number;
  l0: {
    sessionCount: number;
    totalMessages: number;
    sessions: Array<{ key: string; messageCount: number }>;
  };
  l1: {
    totalMemories: number;
    pendingCount: number;
    dedupSkippedTotal: number;
    byType: Record<string, number>;
    byPriority: Record<string, number>;
  };
  l2: {
    sceneCount: number;
    lastTrigger: unknown;
  };
  l3: {
    personaEntries: number;
    lastUpdatedAt: number | null;
  };
  canvas: {
    nodeCount: number;
    edgeCount: number;
    active: boolean;
    sessionKey: string | null;
  };
  config: Record<string, unknown>;
}

interface ToolCacheStats {
  enabled: boolean;
  hits?: number;
  misses?: number;
  size?: number;
  hitRate?: number;
  byTool?: Record<string, { hits: number; misses: number }>;
}

interface TokenBudgetReport {
  enabled: boolean;
  report?: {
    allocated: { systemPrompt: number; memories: number; history: number; toolResults: number; userMessage: number; output: number };
    used: { systemPrompt: number; memories: number; history: number; toolResults: number; userMessage: number; output: number };
    total: { input: number; output: number };
    totalUsed: number;
    overflow: boolean;
    recommendation: string;
  };
}

interface SemanticSearchResult {
  id: string;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
}

// ── 样式 ──────────────────────────────────────────────────────

const s = {
  container: { padding: "20px", overflow: "auto", height: "100%" } as React.CSSProperties,
  intro: {
    background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "10px",
    padding: "14px 18px", marginBottom: "16px", fontSize: "13px",
    color: "var(--text-secondary)", lineHeight: 1.6,
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "14px" } as React.CSSProperties,
  layerCard: {
    background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "10px",
    padding: "16px", display: "flex", flexDirection: "column" as const, gap: "10px",
  },
  layerHeader: { display: "flex", alignItems: "center", gap: "10px" } as React.CSSProperties,
  layerIcon: { fontSize: "22px", lineHeight: 1 } as React.CSSProperties,
  layerTitle: { fontSize: "14px", fontWeight: 700, color: "var(--text-primary)" } as React.CSSProperties,
  layerSubtitle: { fontSize: "11px", color: "var(--text-muted)" } as React.CSSProperties,
  metricRow: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px" } as React.CSSProperties,
  metricLabel: { color: "var(--text-muted)" } as React.CSSProperties,
  metricValue: { color: "var(--text-primary)", fontWeight: 600, fontVariantNumeric: "tabular-nums" } as React.CSSProperties,
  progressBar: { width: "100%", height: "4px", background: "var(--bg-hover)", borderRadius: "2px", overflow: "hidden" } as React.CSSProperties,
  progressFill: (percent: number, color = "var(--accent)"): React.CSSProperties => ({
    width: `${Math.min(100, Math.max(0, percent))}%`, height: "100%", background: color, transition: "width 0.3s",
  }),
  badge: (active: boolean): React.CSSProperties => ({
    display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px",
    padding: "2px 8px", borderRadius: "10px", fontWeight: 600,
    background: active ? "var(--success-bg)" : "var(--bg-hover)",
    color: active ? "var(--success)" : "var(--text-muted)",
    border: `1px solid ${active ? "var(--success)" : "var(--border)"}`,
    marginLeft: "auto",
  }),
  tag: {
    fontSize: "10px", padding: "2px 7px", borderRadius: "10px",
    background: "var(--accent-bg)", color: "var(--accent)",
    border: "1px solid var(--accent)",
  } as React.CSSProperties,
  tagsWrap: { display: "flex", gap: "5px", flexWrap: "wrap" as const } as React.CSSProperties,
  searchBox: {
    display: "flex", gap: "8px", marginBottom: "14px",
  } as React.CSSProperties,
  searchInput: {
    flex: 1, padding: "8px 12px", borderRadius: "6px",
    border: "1px solid var(--input-border)", background: "var(--bg-input)",
    color: "var(--text-primary)", fontSize: "13px", outline: "none",
  } as React.CSSProperties,
  searchBtn: {
    padding: "8px 18px", borderRadius: "6px", border: "none",
    background: "var(--accent)", color: "#fff", cursor: "pointer",
    fontSize: "13px", fontWeight: 600,
  } as React.CSSProperties,
  searchResults: { display: "flex", flexDirection: "column" as const, gap: "6px" } as React.CSSProperties,
  searchItem: {
    background: "var(--bg-card)", border: "1px solid var(--border)",
    borderRadius: "6px", padding: "10px 12px",
  } as React.CSSProperties,
  searchScore: { fontSize: "10px", color: "var(--text-muted)", marginBottom: "4px" } as React.CSSProperties,
  searchText: { fontSize: "12px", color: "var(--text-primary)", lineHeight: 1.5 } as React.CSSProperties,
  refreshBtn: {
    padding: "5px 12px", borderRadius: "6px", border: "1px solid var(--accent)",
    background: "transparent", color: "var(--accent)", cursor: "pointer",
    fontSize: "11px", opacity: 1,
  } as React.CSSProperties,
};

// ── Layer 配置 ────────────────────────────────────────────────

interface LayerConfig {
  id: string;
  icon: string;
  titleKey: string;
  titleFallback: string;
  descKey: string;
  descFallback: string;
  color: string;
}

const LAYERS: LayerConfig[] = [
  {
    id: "l0",
    icon: "📝",
    titleKey: "memory.l0.title",
    titleFallback: "L0 · 对话记录",
    descKey: "memory.l0.desc",
    descFallback: "原始对话流水，原子追加到 JSONL 文件（per-session 隔离）",
    color: "var(--accent)",
  },
  {
    id: "l1",
    icon: "⚛️",
    titleKey: "memory.l1.title",
    titleFallback: "L1 · 原子记忆",
    descKey: "memory.l1.desc",
    descFallback: "抽取的原子事实/偏好/技能/情境/人格（带优先级与去重）",
    color: "var(--success)",
  },
  {
    id: "l2",
    icon: "🧩",
    titleKey: "memory.l2.title",
    titleFallback: "L2 · 情境块",
    descKey: "memory.l2.desc",
    descFallback: "按 sessionKey + 时间窗口聚合的情境块",
    color: "var(--warning)",
  },
  {
    id: "l3",
    icon: "👤",
    titleKey: "memory.l3.title",
    titleFallback: "L3 · 人格画像",
    descKey: "memory.l3.desc",
    descFallback: "长期偏好与习惯（每 N 轮自动刷新）",
    color: "#a855f7",
  },
  {
    id: "canvas",
    icon: "🗺️",
    titleKey: "memory.canvas.title",
    titleFallback: "符号画布",
    descKey: "memory.canvas.desc",
    descFallback: "任务节点图（借鉴 Infinite-Canvas）",
    color: "#22c55e",
  },
];

// ── 主组件 ────────────────────────────────────────────────────

export function MemoryHubPage(): React.ReactElement {
  const { t } = useTranslation();
  const [stats, setStats] = useState<LayeredStats | null>(null);
  const [toolCache, setToolCache] = useState<ToolCacheStats | null>(null);
  const [budgetReport, setBudgetReport] = useState<TokenBudgetReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 语义搜索
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SemanticSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, cacheRes, budgetRes] = await Promise.all([
        fetch("/api/memory/layered-stats").then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch("/api/agent/tool-cache-stats").then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch("/api/agent/token-budget-report").then((r) => r.ok ? r.json() : null).catch(() => null),
      ]);
      setStats(statsRes);
      setToolCache(cacheRes);
      setBudgetReport(budgetRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/memory/semantic-search?q=${encodeURIComponent(searchQuery)}&limit=10`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(Array.isArray(data?.results) ? data.results : []);
      } else {
        setSearchResults([]);
      }
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [searchQuery]);

  // ── 渲染辅助 ──

  function renderL0Card() {
    const l0 = stats?.l0;
    return (
      <div style={s.layerCard}>
        <div style={s.layerHeader}>
          <span style={s.layerIcon}>📝</span>
          <div>
            <div style={s.layerTitle}>{t("memory.l0.title", "L0 · 对话记录")}</div>
            <div style={s.layerSubtitle}>{t("memory.l0.desc", "原始对话流水")}</div>
          </div>
          <span style={s.badge(!!l0 && l0.sessionCount > 0)}>
            {l0?.sessionCount ?? 0} {t("memory.sessions", "会话")}
          </span>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.total_messages", "总消息数")}</span>
          <span style={s.metricValue}>{l0?.totalMessages ?? 0}</span>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.session_count", "会话数")}</span>
          <span style={s.metricValue}>{l0?.sessionCount ?? 0}</span>
        </div>
        {l0 && l0.sessions.length > 0 && (
          <div>
            <div style={{ ...s.metricLabel, fontSize: "10px", marginBottom: "4px" }}>
              {t("memory.recent_sessions", "最近会话")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              {l0.sessions.slice(0, 5).map((sess) => (
                <div key={sess.key} style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                  <span style={{ color: "var(--text-secondary)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "200px" }}>
                    {sess.key}
                  </span>
                  <span style={{ color: "var(--text-muted)" }}>{sess.messageCount} {t("memory.msgs", "条")}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderL1Card() {
    const l1 = stats?.l1;
    const total = l1?.totalMemories ?? 0;
    return (
      <div style={s.layerCard}>
        <div style={s.layerHeader}>
          <span style={s.layerIcon}>⚛️</span>
          <div>
            <div style={s.layerTitle}>{t("memory.l1.title", "L1 · 原子记忆")}</div>
            <div style={s.layerSubtitle}>{t("memory.l1.desc", "原子事实/偏好/技能/情境/人格")}</div>
          </div>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.total_memories", "总记忆数")}</span>
          <span style={s.metricValue}>{total}</span>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.pending", "待聚合")}</span>
          <span style={s.metricValue}>{l1?.pendingCount ?? 0}</span>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.dedup_skipped", "累计去重跳过")}</span>
          <span style={s.metricValue}>{l1?.dedupSkippedTotal ?? 0}</span>
        </div>
        {l1?.byType && Object.keys(l1.byType).length > 0 && (
          <div>
            <div style={{ ...s.metricLabel, fontSize: "10px", marginBottom: "4px" }}>
              {t("memory.by_type", "按类型分布")}
            </div>
            <div style={s.tagsWrap}>
              {Object.entries(l1.byType).map(([type, count]) => (
                <span key={type} style={s.tag}>{type}: {count}</span>
              ))}
            </div>
          </div>
        )}
        {l1?.byPriority && Object.keys(l1.byPriority).length > 0 && (
          <div>
            <div style={{ ...s.metricLabel, fontSize: "10px", marginBottom: "4px" }}>
              {t("memory.by_priority", "按优先级分布")}
            </div>
            <div style={s.tagsWrap}>
              {Object.entries(l1.byPriority).map(([p, count]) => (
                <span key={p} style={s.tag}>P{p}: {count}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderL2Card() {
    const l2 = stats?.l2;
    return (
      <div style={s.layerCard}>
        <div style={s.layerHeader}>
          <span style={s.layerIcon}>🧩</span>
          <div>
            <div style={s.layerTitle}>{t("memory.l2.title", "L2 · 情境块")}</div>
            <div style={s.layerSubtitle}>{t("memory.l2.desc", "按 sessionKey + 时间窗口聚合")}</div>
          </div>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.scene_count", "情境块数")}</span>
          <span style={s.metricValue}>{l2?.sceneCount ?? 0}</span>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.last_trigger", "最近触发状态")}</span>
          <span style={{ ...s.metricValue, fontSize: "11px" }}>
            {l2?.lastTrigger ? JSON.stringify(l2.lastTrigger).slice(0, 50) : "—"}
          </span>
        </div>
      </div>
    );
  }

  function renderL3Card() {
    const l3 = stats?.l3;
    return (
      <div style={s.layerCard}>
        <div style={s.layerHeader}>
          <span style={s.layerIcon}>👤</span>
          <div>
            <div style={s.layerTitle}>{t("memory.l3.title", "L3 · 人格画像")}</div>
            <div style={s.layerSubtitle}>{t("memory.l3.desc", "长期偏好与习惯")}</div>
          </div>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.persona_entries", "画像条目数")}</span>
          <span style={s.metricValue}>{l3?.personaEntries ?? 0}</span>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.last_updated", "最近更新")}</span>
          <span style={{ ...s.metricValue, fontSize: "11px" }}>
            {l3?.lastUpdatedAt ? new Date(l3.lastUpdatedAt).toLocaleString() : "—"}
          </span>
        </div>
      </div>
    );
  }

  function renderCanvasCard() {
    const canvas = stats?.canvas;
    return (
      <div style={s.layerCard}>
        <div style={s.layerHeader}>
          <span style={s.layerIcon}>🗺️</span>
          <div>
            <div style={s.layerTitle}>{t("memory.canvas.title", "符号画布")}</div>
            <div style={s.layerSubtitle}>{t("memory.canvas.desc", "任务节点图")}</div>
          </div>
          <span style={s.badge(!!canvas?.active)}>
            {canvas?.active ? t("memory.canvas.active", "激活") : t("memory.canvas.inactive", "未激活")}
          </span>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.node_count", "节点数")}</span>
          <span style={s.metricValue}>{canvas?.nodeCount ?? 0}</span>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.edge_count", "连线数")}</span>
          <span style={s.metricValue}>{canvas?.edgeCount ?? 0}</span>
        </div>
        {canvas?.sessionKey && (
          <div style={s.metricRow}>
            <span style={s.metricLabel}>{t("memory.session_key", "会话键")}</span>
            <span style={{ ...s.metricValue, fontSize: "11px", fontFamily: "monospace" }}>
              {canvas.sessionKey.slice(0, 30)}
            </span>
          </div>
        )}
      </div>
    );
  }

  function renderToolCacheCard() {
    const cache = toolCache;
    const enabled = !!cache?.enabled;
    const hits = cache?.hits ?? 0;
    const misses = cache?.misses ?? 0;
    const total = hits + misses;
    const hitRate = total > 0 ? (hits / total) * 100 : 0;
    return (
      <div style={s.layerCard}>
        <div style={s.layerHeader}>
          <span style={s.layerIcon}>⚡</span>
          <div>
            <div style={s.layerTitle}>{t("memory.tool_cache.title", "工具结果缓存")}</div>
            <div style={s.layerSubtitle}>{t("memory.tool_cache.desc", "LRU + TTL，减少重复 API 调用")}</div>
          </div>
          <span style={s.badge(enabled)}>
            {enabled ? t("memory.enabled", "已启用") : t("memory.disabled", "未启用")}
          </span>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.cache_hits", "命中")}</span>
          <span style={{ ...s.metricValue, color: "var(--success)" }}>{hits}</span>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.cache_misses", "未命中")}</span>
          <span style={{ ...s.metricValue, color: "var(--text-muted)" }}>{misses}</span>
        </div>
        <div>
          <div style={{ ...s.metricRow, marginBottom: "4px" }}>
            <span style={s.metricLabel}>{t("memory.hit_rate", "命中率")}</span>
            <span style={s.metricValue}>{hitRate.toFixed(1)}%</span>
          </div>
          <div style={s.progressBar}>
            <div style={s.progressFill(hitRate, "var(--success)")} />
          </div>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.cache_size", "缓存条数")}</span>
          <span style={s.metricValue}>{cache?.size ?? 0}</span>
        </div>
        {cache?.byTool && Object.keys(cache.byTool).length > 0 && (
          <div>
            <div style={{ ...s.metricLabel, fontSize: "10px", marginBottom: "4px" }}>
              {t("memory.by_tool", "按工具分布")}
            </div>
            <div style={s.tagsWrap}>
              {Object.entries(cache.byTool).slice(0, 8).map(([tool, c]) => (
                <span key={tool} style={s.tag}>{tool}: {c.hits}/{c.hits + c.misses}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderTokenBudgetCard() {
    const report = budgetReport?.report;
    const enabled = !!budgetReport?.enabled;
    if (!enabled || !report) {
      return (
        <div style={s.layerCard}>
          <div style={s.layerHeader}>
            <span style={s.layerIcon}>💰</span>
            <div>
              <div style={s.layerTitle}>{t("memory.token_budget.title", "Token 预算")}</div>
              <div style={s.layerSubtitle}>{t("memory.token_budget.desc", "动态分配 context window")}</div>
            </div>
            <span style={s.badge(false)}>
              {t("memory.disabled", "未启用")}
            </span>
          </div>
        </div>
      );
    }
    const allocated = report.allocated;
    const used = report.used;
    const total = report.total;
    const totalUsedPct = total.input > 0 ? (report.totalUsed / total.input) * 100 : 0;
    return (
      <div style={s.layerCard}>
        <div style={s.layerHeader}>
          <span style={s.layerIcon}>💰</span>
          <div>
            <div style={s.layerTitle}>{t("memory.token_budget.title", "Token 预算")}</div>
            <div style={s.layerSubtitle}>{t("memory.token_budget.desc", "动态分配 context window")}</div>
          </div>
          <span style={s.badge(true)}>
            {t("memory.enabled", "已启用")}
          </span>
        </div>
        <div style={s.metricRow}>
          <span style={s.metricLabel}>{t("memory.total_used", "已用 / 总输入")}</span>
          <span style={s.metricValue}>
            {report.totalUsed} / {total.input} ({totalUsedPct.toFixed(1)}%)
          </span>
        </div>
        <div>
          <div style={s.progressBar}>
            <div style={s.progressFill(totalUsedPct, report.overflow ? "var(--error)" : "var(--accent)")} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", fontSize: "11px" }}>
          <div style={s.metricRow}>
            <span style={s.metricLabel}>System</span>
            <span style={s.metricValue}>{used.systemPrompt}/{allocated.systemPrompt}</span>
          </div>
          <div style={s.metricRow}>
            <span style={s.metricLabel}>Memories</span>
            <span style={s.metricValue}>{used.memories}/{allocated.memories}</span>
          </div>
          <div style={s.metricRow}>
            <span style={s.metricLabel}>History</span>
            <span style={s.metricValue}>{used.history}/{allocated.history}</span>
          </div>
          <div style={s.metricRow}>
            <span style={s.metricLabel}>ToolResults</span>
            <span style={s.metricValue}>{used.toolResults}/{allocated.toolResults}</span>
          </div>
        </div>
        <div style={{
          fontSize: "11px", color: report.overflow ? "var(--error)" : "var(--success)",
          padding: "4px 8px", background: report.overflow ? "var(--error-bg)" : "var(--success-bg)",
          borderRadius: "4px",
        }}>
          {report.recommendation}
        </div>
      </div>
    );
  }

  return (
    <div style={s.container}>
      <PageHeader
        title={t("memory.title", "分层记忆中心")}
        actions={
          <button
            style={{ ...s.refreshBtn, opacity: loading ? 0.6 : 1 }}
            onClick={load}
            disabled={loading}
          >
            {t("common.refresh", "刷新")}
          </button>
        }
      />

      <div style={s.intro}>
        {t("memory.intro", "L0→L3 语义金字塔：对话记录 → 原子记忆 → 情境块 → 人格画像，配合符号画布与召回预算，构建多层记忆系统。借鉴 TencentDB-Agent-Memory。")}
        {stats && (
          <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-muted)" }}>
            {t("memory.turn_count", "Turn 计数")}: <strong style={{ color: "var(--text-primary)" }}>{stats.turnCount}</strong>
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {loading && <Loading />}

      {/* L0 → L3 + Canvas 分层卡片 */}
      <div style={s.grid}>
        {renderL0Card()}
        {renderL1Card()}
        {renderL2Card()}
        {renderL3Card()}
        {renderCanvasCard()}
        {renderToolCacheCard()}
        {renderTokenBudgetCard()}
      </div>

      {/* 语义搜索 */}
      <div style={{ marginTop: "20px" }}>
        <h3 style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "10px" }}>
          {t("memory.semantic_search", "语义搜索")}
        </h3>
        <div style={s.searchBox}>
          <input
            style={s.searchInput}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
            placeholder={t("memory.search_placeholder", "输入查询，回车搜索...")}
          />
          <button style={{ ...s.searchBtn, opacity: searching ? 0.6 : 1 }} onClick={runSearch} disabled={searching}>
            {searching ? t("memory.searching", "搜索中...") : t("memory.search_btn", "搜索")}
          </button>
        </div>
        {searchResults && (
          <div style={s.searchResults}>
            {searchResults.length === 0 ? (
              <div style={{ fontSize: "12px", color: "var(--text-muted)", padding: "12px" }}>
                {t("memory.no_results", "无匹配结果")}
              </div>
            ) : (
              searchResults.map((r) => (
                <div key={r.id} style={s.searchItem}>
                  <div style={s.searchScore}>
                    score: {r.score.toFixed(4)} · id: {r.id}
                  </div>
                  <div style={s.searchText}>{r.text}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 配置信息 */}
      {stats?.config && Object.keys(stats.config).length > 0 && (
        <div style={{ marginTop: "20px" }}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "10px" }}>
            {t("memory.config", "配置")}
          </h3>
          <div style={s.tagsWrap}>
            {Object.entries(stats.config).map(([k, v]) => (
              <span key={k} style={s.tag}>{k}: {String(v)}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default MemoryHubPage;
