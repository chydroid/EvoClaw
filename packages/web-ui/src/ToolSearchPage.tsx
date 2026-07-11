/**
 * ToolSearchPage — 工具搜索页
 *
 * 搜索框、搜索结果列表（name/score/matchedTerms/reason）、
 * 已索引工具列表，以及统计信息。
 */

import { useState, useEffect, useCallback } from "react";
import {
  PageHeader, Card, Badge, Loading, EmptyState,
  PrimaryButton, SecondaryButton, Section,
  StatsGrid, DataTable, TextInput,
} from "./shared";
import { useApiCall } from "./useApiCall";
import { useTranslation } from "./i18n";
import {
  toolSearchApi,
  type ToolSearchResultItem,
  type IndexedTool,
  type ToolSearchStats,
} from "./api-client";

export default function ToolSearchPage() {
  const { t } = useTranslation();
  const { call } = useApiCall();
  const [stats, setStats] = useState<ToolSearchStats | null>(null);
  const [tools, setTools] = useState<IndexedTool[]>([]);
  const [loadingState, setLoadingState] = useState(true);

  // Search state
  const [query, setQuery] = useState("");
  const [maxResults, setMaxResults] = useState("10");
  const [results, setResults] = useState<ToolSearchResultItem[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(async () => {
    setLoadingState(true);
    const [s, tl] = await Promise.all([
      toolSearchApi.stats(),
      toolSearchApi.tools(),
    ]);
    setStats(s);
    setTools(tl.tools || []);
    setLoadingState(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleSearch() {
    if (!query.trim()) return;
    setSearching(true);
    setSearched(true);
    const max = Number(maxResults);
    const result = await call(
      () => toolSearchApi.search(query.trim(), Number.isFinite(max) && max > 0 ? max : undefined),
      { errorMessage: t("ts.search_failed", "搜索失败") },
    );
    if (result) {
      setResults(result.results || []);
    }
    setSearching(false);
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSearch();
  }

  if (loadingState) {
    return <Loading text={t("ts.loading", "加载工具索引...")} />;
  }

  const statsItems = stats ? [
    { label: t("ts.total_tools", "已索引工具"), value: stats.totalTools, color: "var(--text-primary)" },
    { label: t("ts.visible", "始终可见"), value: stats.visibleTools, color: "var(--accent)" },
    { label: t("ts.deferrable", "按需加载"), value: stats.deferrableTools, color: "var(--warning)" },
    { label: t("ts.mode", "模式"), value: stats.mode, color: "var(--text-primary)" },
    { label: t("ts.activated", "已激活"), value: stats.activated ? "✓" : "✗", color: stats.activated ? "var(--success)" : "var(--text-muted)" },
  ] : [];

  return (
    <div style={{ padding: 24 }}>
      <PageHeader
        title={t("ts.title", "工具搜索")}
        subtitle={t("ts.subtitle", "BM25 工具检索：按需披露工具，降低 token 成本")}
        actions={
          <SecondaryButton onClick={refresh}>
            {t("ts.refresh", "刷新")}
          </SecondaryButton>
        }
      />

      {/* Stats */}
      {stats && (
        <Section>
          <StatsGrid items={statsItems} />
        </Section>
      )}

      {/* Search */}
      <Section title={t("ts.search_title", "搜索工具")}>
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <TextInput
                  value={query}
                  onChange={setQuery}
                  placeholder={t("ts.query_placeholder", "输入搜索词（如：读取文件 / read file）")}
                />
              </div>
              <div style={{ width: 100 }}>
                <TextInput
                  value={maxResults}
                  onChange={setMaxResults}
                  placeholder="10"
                  type="number"
                />
              </div>
              <PrimaryButton onClick={handleSearch} disabled={!query.trim() || searching}>
                {searching ? t("ts.searching", "搜索中...") : t("ts.search", "搜索")}
              </PrimaryButton>
            </div>

            {/* Results */}
            {searched && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>
                  {t("ts.results", "搜索结果")} ({results.length})
                </div>
                {results.length === 0 ? (
                  <EmptyState title={t("ts.no_results", "无匹配工具")} />
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {results.map((r, i) => (
                      <ToolSearchResultRow key={i} result={r} rank={i + 1} t={t} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      </Section>

      {/* Indexed Tools */}
      <Section title={t("ts.indexed_tools", "已索引工具")} >
        {tools.length === 0 ? (
          <EmptyState title={t("ts.no_tools", "暂无已索引工具")} description={t("ts.no_tools_desc", "工具搜索引擎未注册或未索引任何工具")} />
        ) : (
          <DataTable
            columns={[
              { key: "name", label: t("ts.col_name", "名称"), width: "200px" },
              { key: "category", label: t("ts.col_category", "类别"), width: "120px" },
              { key: "description", label: t("ts.col_description", "描述") },
              { key: "alwaysVisible", label: t("ts.col_visible", "始终可见"), width: "100px" },
            ]}
            data={tools}
            keyFn={(tool, i) => tool.name || `tool-${i}`}
            emptyText={t("ts.no_tools", "暂无已索引工具")}
            rowStyle={{ fontSize: 12 }}
          />
        )}
      </Section>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────

function ToolSearchResultRow({ result, rank, t }: {
  result: ToolSearchResultItem;
  rank: number;
  t: (key: string, fallback?: string) => string;
}) {
  const scorePercent = Math.min(100, Math.round(result.score * 100));
  const scoreVariant: "success" | "info" | "warning" | "default" =
    scorePercent >= 75 ? "success" : scorePercent >= 50 ? "info" : scorePercent >= 25 ? "warning" : "default";

  return (
    <div style={{
      padding: "10px 14px", background: "var(--bg-hover)", borderRadius: 8,
      border: "1px solid var(--border)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, minWidth: 20 }}>
            #{rank}
          </span>
          <code style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>
            {result.name}
          </code>
        </div>
        <Badge variant={scoreVariant}>
          {t("ts.score", "分数")}: {result.score.toFixed(3)}
        </Badge>
      </div>
      {result.reason && (
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
          {result.reason}
        </div>
      )}
      {result.matchedTerms.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {result.matchedTerms.map((term, i) => (
            <span key={i} style={{
              fontSize: 10, background: "var(--accent-bg)", color: "var(--accent)",
              padding: "1px 6px", borderRadius: 4,
            }}>
              {term}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
