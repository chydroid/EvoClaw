/**
 * AnalyticsPage — 系统与代币使用分析（对标 hermes web/src/pages/AnalyticsPage）。
 *
 * 聚合三个已有数据源，统一成一个分析仪表盘（不新增后端、不引入图表库）：
 *   GET /api/metrics（Prometheus 文本，系统 gauge）
 *   GET /api/token-usage/overview（代币/成本汇总 + 最近调用）
 *   GET /api/health（HTTP 指标：请求数、错误率、延迟分位）
 *
 * 与 Dashboard 的分工：Dashboard 看「现在有多少」，AnalyticsPage 看「运行得怎么样」。
 */

import React, { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, StatsGrid, DataTable,
} from "./shared";
import { useTranslation } from "./i18n";
import { errorMessage } from "./api-error";

interface SystemMetrics {
  servicesTotal: number;
  servicesRunning: number;
  uptimeSeconds: number;
  memoryRssBytes: number;
  memoryHeapUsedBytes: number;
  memoryHeapTotalBytes: number;
}

interface TokenOverview {
  totalTokens: number;
  totalCost: number;
  avgTokensPerSession: number;
  totalCalls: number;
  totalInputTokens?: number;
  totalCacheHitTokens?: number;
  totalCacheWriteTokens?: number;
  cacheHitRate?: number;
}

interface HttpMetrics {
  totalRequests: number;
  errorRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  p99LatencyMs: number;
  activeSessions: number;
}

const s: Record<string, CSSProperties> = {
  container: { padding: 20, height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  toolbar: { display: "flex", gap: "8px", marginBottom: "16px" },
  btn: { padding: "6px 14px", borderRadius: "6px", border: "1px solid var(--border-light)", cursor: "pointer", background: "var(--bg-card)", color: "var(--text-secondary)", fontSize: "12px" },
  bar: { height: "8px", borderRadius: "4px", background: "var(--bg-hover)", marginTop: "6px", overflow: "hidden" },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" },
};

const barFill = (pct: number, color: string): CSSProperties => ({
  height: "100%", width: `${Math.min(100, pct)}%`, borderRadius: "4px", background: color, transition: "width 0.3s",
});

/** 解析 Prometheus text format，只取需要的 gauge。 */
function parsePrometheusMetrics(text: string): SystemMetrics {
  const get = (name: string): number => {
    const re = new RegExp(`^${name}\\s+([0-9.]+)`, "m");
    const m = text.match(re);
    return m ? parseFloat(m[1]) : 0;
  };
  return {
    servicesTotal: get("evoclaw_services_total"),
    servicesRunning: get("evoclaw_services_running"),
    uptimeSeconds: get("evoclaw_process_uptime_seconds"),
    memoryRssBytes: get("evoclaw_process_memory_rss_bytes"),
    memoryHeapUsedBytes: get("evoclaw_process_memory_heap_used_bytes"),
    memoryHeapTotalBytes: get("evoclaw_process_memory_heap_total_bytes"),
  };
}

const formatBytes = (b: number): string => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatUptime = (s: number): string => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分钟`;
  return `${m}分钟`;
};

export function AnalyticsPage() {
  const { t } = useTranslation();
  const [sysMetrics, setSysMetrics] = useState<SystemMetrics | null>(null);
  const [tokenOverview, setTokenOverview] = useState<TokenOverview | null>(null);
  const [httpMetrics, setHttpMetrics] = useState<HttpMetrics | null>(null);
  const [recent, setRecent] = useState<Array<{ id: string; model: string; tokens: number; cost: number; timestamp: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [metricsRes, overviewRes, healthRes] = await Promise.all([
        fetch("/api/metrics"),
        fetch("/api/token-usage/overview"),
        fetch("/api/health"),
      ]);
      if (!metricsRes.ok) throw new Error(`metrics HTTP ${metricsRes.status}`);
      const metricsText = await metricsRes.text();
      setSysMetrics(parsePrometheusMetrics(metricsText));

      if (overviewRes.ok) {
        const data = await overviewRes.json();
        if (data && typeof data === "object") {
          setTokenOverview({
            totalTokens: Number(data.totalTokens) || 0,
            totalCost: Number(data.totalCost) || 0,
            avgTokensPerSession: Number(data.avgTokensPerSession) || 0,
            totalCalls: Number(data.totalCalls) || 0,
            totalInputTokens: Number(data.totalInputTokens) || 0,
            totalCacheHitTokens: Number(data.totalCacheHitTokens) || 0,
            totalCacheWriteTokens: Number(data.totalCacheWriteTokens) || 0,
            cacheHitRate: Number(data.cacheHitRate) || 0,
          });
          if (Array.isArray(data.recentUsage)) setRecent(data.recentUsage);
        }
      }
      if (healthRes.ok) {
        const data = await healthRes.json();
        if (data && typeof data === "object" && data.metrics) {
          setHttpMetrics({
            totalRequests: Number(data.metrics.totalRequests) || 0,
            errorRate: Number(data.metrics.errorRate) || 0,
            avgLatencyMs: Number(data.metrics.avgLatencyMs) || 0,
            p50LatencyMs: Number(data.metrics.p50LatencyMs) || 0,
            p90LatencyMs: Number(data.metrics.p90LatencyMs) || 0,
            p99LatencyMs: Number(data.metrics.p99LatencyMs) || 0,
            activeSessions: Number(data.metrics.activeSessions) || 0,
          });
        }
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) return <Loading />;

  return (
    <div style={s.container}>
      <PageHeader
        title={t("analytics.title", "使用分析")}
        subtitle={t("analytics.subtitle", "系统资源、代币成本与 HTTP 运行指标的聚合视图")}
        actions={<SecondaryButton small onClick={loadData}>{t("analytics.refresh", "刷新")}</SecondaryButton>}
      />
      {error && <ErrorBanner message={error} />}

      {/* System */}
      <Section title={t("analytics.system_header", "系统资源")}>
        {sysMetrics ? (
          <div style={s.twoCol}>
            <Card title={t("analytics.process", "进程")}>
              <StatsGrid items={[
                { label: t("analytics.uptime", "运行时"), value: formatUptime(sysMetrics.uptimeSeconds) },
                { label: t("analytics.services", "服务"), value: `${sysMetrics.servicesRunning}/${sysMetrics.servicesTotal}` },
              ]} />
              <div style={{ marginTop: "12px" }}>
                <div style={{ color: "var(--text-muted)", fontSize: "11px", marginBottom: "2px" }}>{t("analytics.heap", "堆内存")}</div>
                <div style={{ color: "var(--text-primary)", fontSize: "13px" }}>{formatBytes(sysMetrics.memoryHeapUsedBytes)} / {formatBytes(sysMetrics.memoryHeapTotalBytes)}</div>
                <div style={s.bar}><div style={barFill((sysMetrics.memoryHeapUsedBytes / Math.max(1, sysMetrics.memoryHeapTotalBytes)) * 100, "var(--accent)")}></div></div>
              </div>
            </Card>
            <Card title={t("analytics.memory", "内存")}>
              <StatsGrid items={[
                { label: t("analytics.rss", "RSS"), value: formatBytes(sysMetrics.memoryRssBytes) },
                { label: t("analytics.heap_used", "堆已用"), value: formatBytes(sysMetrics.memoryHeapUsedBytes) },
              ]} />
            </Card>
          </div>
        ) : (
          <EmptyState title={t("analytics.unavailable", "暂无系统指标")} description={t("analytics.unavailable_desc", "/api/metrics 暂不可用")} />
        )}
      </Section>

      {/* HTTP / tokens */}
      <Section title={t("analytics.http_header", "HTTP 与代币")}>
        <div style={s.twoCol}>
          <Card title={t("analytics.http", "HTTP 运行")}>
            {httpMetrics ? (
              <>
                <StatsGrid items={[
                  { label: t("analytics.requests", "总请求数"), value: httpMetrics.totalRequests.toLocaleString() },
                  { label: t("analytics.error_rate", "错误率"), value: `${(httpMetrics.errorRate * 100).toFixed(2)}%` },
                  { label: t("analytics.active_sessions", "活跃会话"), value: String(httpMetrics.activeSessions) },
                ]} />
                <div style={{ marginTop: "12px" }}>
                  <div style={{ color: "var(--text-muted)", fontSize: "11px", marginBottom: "2px" }}>{t("analytics.latency", "延迟 (ms)")}</div>
                  <div style={{ color: "var(--text-primary)", fontSize: "13px" }}>
                    {t("analytics.p50", "p50")}: {httpMetrics.p50LatencyMs} · {t("analytics.p90", "p90")}: {httpMetrics.p90LatencyMs} · {t("analytics.p99", "p99")}: {httpMetrics.p99LatencyMs}
                  </div>
                  <div style={{ color: "var(--text-muted)", fontSize: "11px", marginTop: "2px" }}>{t("analytics.avg", "平均")}: {httpMetrics.avgLatencyMs} ms</div>
                </div>
              </>
            ) : (
              <EmptyState title={t("analytics.unavailable", "暂无 HTTP 指标")} description={t("analytics.unavailable_desc", "/api/health 暂不可用")} />
            )}
          </Card>
          <Card title={t("analytics.tokens", "代币与成本")}>
            {tokenOverview ? (
              <>
                <StatsGrid items={[
                  { label: t("analytics.total_tokens", "总代币"), value: tokenOverview.totalTokens.toLocaleString() },
                  { label: t("analytics.cost", "总成本"), value: `$${tokenOverview.totalCost.toFixed(4)}` },
                  { label: t("analytics.calls", "调用次数"), value: String(tokenOverview.totalCalls) },
                  { label: t("analytics.avg_per_session", "人均代币"), value: tokenOverview.avgTokensPerSession.toLocaleString() },
                ]} />
                {tokenOverview.totalCalls > 0 && (
                  <div style={{ marginTop: "12px" }}>
                    <div style={{ color: "var(--text-muted)", fontSize: "11px", marginBottom: "2px" }}>{t("analytics.cache_hit", "缓存命中率")}</div>
                    <div style={{ color: "var(--text-primary)", fontSize: "13px" }}>{(tokenOverview.cacheHitRate || 0).toFixed(1)}%</div>
                    <div style={{ color: "var(--text-muted)", fontSize: "11px", marginTop: "4px" }}>
                      {t("analytics.cache_hit_tokens", "命中")}: {tokenOverview.totalCacheHitTokens?.toLocaleString() || 0} · {t("analytics.cache_write_tokens", "写入")}: {tokenOverview.totalCacheWriteTokens?.toLocaleString() || 0}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <EmptyState title={t("analytics.no_tokens", "暂无代币数据")} description={t("analytics.no_tokens_desc", "还没有 LLM 调用记录")} />
            )}
          </Card>
        </div>
      </Section>

      {/* Recent calls */}
      <Section title={t("analytics.recent_header", "最近调用")}>
        {recent.length === 0 ? (
          <EmptyState title={t("analytics.no_recent", "暂无最近调用")} description={t("analytics.no_recent_desc", "还没有 LLM 调用记录")} />
        ) : (
          <DataTable
            columns={[
              { key: "timestamp", label: t("analytics.col_time", "时间"), render: (r: { timestamp: string }) => r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : "-" },
              { key: "model", label: t("analytics.col_model", "模型"), render: (r: { model: string }) => r.model || "-" },
              { key: "tokens", label: t("analytics.col_tokens", "代币"), render: (r: { tokens: number }) => Number(r.tokens || 0).toLocaleString() },
              { key: "cost", label: t("analytics.col_cost", "成本"), render: (r: { cost: number }) => `$${Number(r.cost || 0).toFixed(4)}` },
            ]}
            data={recent.slice(0, 20)}
            keyFn={(r, i) => r.id || String(i)}
            emptyText={t("analytics.no_recent", "暂无最近调用")}
          />
        )}
      </Section>
    </div>
  );
}