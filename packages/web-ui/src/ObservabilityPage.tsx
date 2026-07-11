/**
 * EvoClaw WebUI — Observability Dashboard
 *
 * Full-chain tracing and agent execution monitoring with 3 tabs:
 * Overview, Traces, and Executions.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Card, Badge, PageHeader, Loading, EmptyState,
  PrimaryButton, SecondaryButton, showToast, StatsGrid, Section,
  TextInput,
} from "./shared";
import { useTranslation } from "./i18n";
import { tracingApi, type TracingSpan } from "./api-client";

// ═══════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════

interface Span {
  spanId: string;
  kind: string;
  name: string;
  startTime: string;
  endTime?: string;
  status?: string;
  attributes?: Record<string, unknown>;
}

interface Trace {
  traceId: string;
  sessionId: string;
  status: string;
  startTime: string;
  endTime?: string;
  spans: Span[];
}

interface Execution {
  id: string;
  status: string;
  duration?: number;
  timestamp?: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════

const API = window.__EVOCLAW_API__ || "";

function calcDuration(start: string, end?: string): number | null {
  if (!end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return ms >= 0 ? ms : null;
}

function formatDuration(ms: number | null, t: (k: string, fb?: string) => string): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}${t("observability.ms", "ms")}`;
  return `${(ms / 1000).toFixed(2)}${t("observability.seconds", "s")}`;
}

function statusBadgeVariant(status: string): "success" | "error" | "warning" | "info" | "default" {
  if (status === "ok" || status === "completed" || status === "success") return "success";
  if (status === "error" || status === "failed") return "error";
  if (status === "active" || status === "running") return "info";
  return "default";
}

function kindBadgeVariant(kind: string): "info" | "warning" | "default" {
  if (kind === "tool") return "info";
  if (kind === "llm") return "warning";
  return "default";
}

// ═══════════════════════════════════════════════
// Tab definitions
// ═══════════════════════════════════════════════

type TabKey = "overview" | "traces" | "executions" | "spans";

const TAB_KEYS: TabKey[] = ["overview", "traces", "executions", "spans"];

// ═══════════════════════════════════════════════
// Overview Tab
// ═══════════════════════════════════════════════

function OverviewTab({ traces, t, locale }: { traces: Trace[]; t: (k: string, fb?: string) => string; locale: string }) {
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const activeTraces = traces.filter(tr => tr.status === "active" || !tr.endTime).length;
  const totalSpans = traces.reduce((sum, tr) => sum + (tr.spans?.length || 0), 0);
  const errorTraces = traces.filter(tr => tr.status === "error" || tr.status === "failed").length;
  const errorRate = traces.length > 0 ? ((errorTraces / traces.length) * 100).toFixed(1) : "0.0";

  const completedTraces = traces.filter(tr => tr.endTime && tr.startTime);
  const avgDurationMs = completedTraces.length > 0
    ? completedTraces.reduce((sum, tr) => {
        const d = calcDuration(tr.startTime, tr.endTime);
        return sum + (d ?? 0);
      }, 0) / completedTraces.length
    : null;

  const filteredTraces = statusFilter === "all"
    ? traces
    : traces.filter(tr => {
        if (statusFilter === "ok") return tr.status === "ok" || tr.status === "completed" || tr.status === "success";
        if (statusFilter === "error") return tr.status === "error" || tr.status === "failed";
        if (statusFilter === "active") return tr.status === "active" || !tr.endTime;
        return true;
      });

  const filterButtons = [
    { key: "all", label: t("observability.filter.all") },
    { key: "ok", label: t("observability.filter.ok") },
    { key: "error", label: t("observability.filter.error") },
    { key: "active", label: t("observability.filter.active") },
  ];

  return (
    <div>
      <StatsGrid items={[
        { label: t("observability.stats.active_traces"), value: activeTraces, color: "var(--accent)" },
        { label: t("observability.stats.total_spans"), value: totalSpans, color: "var(--success)" },
        { label: t("observability.stats.error_rate"), value: `${errorRate}%`, color: errorTraces > 0 ? "var(--error)" : "var(--success)" },
        { label: t("observability.stats.avg_duration"), value: formatDuration(avgDurationMs, t), color: "var(--text-primary)" },
      ]} />

      <Section title={t("observability.recent_traces")}>
        <div style={{ display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" }}>
          {filterButtons.map(fb => (
            <button
              key={fb.key}
              onClick={() => setStatusFilter(fb.key)}
              style={{
                padding: "5px 14px", borderRadius: "6px", border: "1px solid",
                borderColor: statusFilter === fb.key ? "var(--accent)" : "var(--border)",
                background: statusFilter === fb.key ? "var(--accent-bg)" : "var(--bg-hover)",
                color: statusFilter === fb.key ? "var(--accent)" : "var(--text-secondary)",
                cursor: "pointer", fontSize: "12px", fontWeight: 600,
                transition: "all 0.15s",
              }}
            >
              {fb.label}
            </button>
          ))}
        </div>

        {filteredTraces.length === 0 ? (
          <EmptyState
            icon="🔍"
            title={t("observability.no_traces")}
            description={t("observability.no_traces_desc")}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {filteredTraces.slice(0, 20).map(trace => (
              <TraceRow key={trace.traceId} trace={trace} t={t} locale={locale} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ═══════════════════════════════════════════════
// Trace Row (shared between Overview & Traces)
// ═══════════════════════════════════════════════

function TraceRow({ trace, t, expandable = false, locale }: { trace: Trace; t: (k: string, fb?: string) => string; expandable?: boolean; locale: string }) {
  const [expanded, setExpanded] = useState(false);
  const duration = calcDuration(trace.startTime, trace.endTime);

  return (
    <Card style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", minWidth: 0 }}>
          <span style={{ fontFamily: "monospace", fontSize: "12px", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {trace.traceId ? (trace.traceId.length > 16 ? `${trace.traceId.slice(0, 8)}…${trace.traceId.slice(-4)}` : trace.traceId) : "—"}
          </span>
          <Badge variant={statusBadgeVariant(trace.status)}>
            {t(`observability.status.${trace.status || "active"}`)}
          </Badge>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "12px", color: "var(--text-muted)", flexShrink: 0 }}>
          <span>{t("observability.span_count")}: {trace.spans?.length || 0}</span>
          <span>{formatDuration(duration, t)}</span>
          {trace.startTime && (
            <span>{new Date(trace.startTime).toLocaleTimeString(locale)}</span>
          )}
        </div>
      </div>

      <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "6px" }}>
        {t("observability.session_id")}: <span style={{ fontFamily: "monospace" }}>{trace.sessionId}</span>
      </div>

      {expandable && trace.spans?.length > 0 && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            marginTop: "8px", padding: "3px 10px", borderRadius: "4px",
            border: "1px solid var(--border)", background: "var(--bg-hover)",
            color: "var(--text-secondary)", cursor: "pointer", fontSize: "11px",
            fontWeight: 600, transition: "background 0.15s",
          }}
        >
          {expanded ? t("observability.collapse") : t("observability.expand")} ({trace.spans.length} {t("observability.spans").toLowerCase()})
        </button>
      )}

      {expanded && trace.spans?.length > 0 && (
        <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "4px" }}>
          {trace.spans.map(span => (
            <SpanRow key={span.spanId} span={span} t={t} traceStart={trace.startTime} />
          ))}
        </div>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════
// Span Row
// ═══════════════════════════════════════════════

function SpanRow({ span, t, traceStart }: { span: Span; t: (k: string, fb?: string) => string; traceStart: string }) {
  const duration = calcDuration(span.startTime, span.endTime);
  const offsetMs = new Date(span.startTime).getTime() - new Date(traceStart).getTime();
  const offsetPct = Math.max(0, Math.min(100, offsetMs / 30000 * 100)); // scale to 30s window

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "8px",
      padding: "6px 10px", borderRadius: "6px",
      background: "var(--bg-hover)", fontSize: "12px",
    }}>
      <Badge variant={kindBadgeVariant(span.kind)} style={{ fontSize: "10px", padding: "2px 7px" }}>
        {t(`observability.kind.${span.kind}`)}
      </Badge>
      <span style={{ color: "var(--text-primary)", fontWeight: 500, minWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {span.name}
      </span>
      <div style={{ flex: 1, height: "6px", background: "var(--border-light)", borderRadius: "3px", position: "relative", minWidth: "60px" }}>
        <div style={{
          position: "absolute", left: `${offsetPct}%`, height: "100%", borderRadius: "3px",
          width: duration !== null ? `${Math.max(2, Math.min(100 - offsetPct, duration / 30000 * 100))}%` : "4px",
          background: span.kind === "tool" ? "var(--accent)" : span.kind === "llm" ? "var(--warning)" : "var(--text-muted)",
          minWidth: "4px",
        }} />
      </div>
      <span style={{ color: "var(--text-muted)", fontFamily: "monospace", fontSize: "11px", flexShrink: 0 }}>
        {formatDuration(duration, t)}
      </span>
      {span.status && span.status !== "ok" && (
        <Badge variant={statusBadgeVariant(span.status)} style={{ fontSize: "9px", padding: "1px 5px" }}>
          {t(`observability.status.${span.status}`, span.status)}
        </Badge>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// Traces Tab
// ═══════════════════════════════════════════════

function TracesTab({ traces, loading, onRefresh, t, locale }: { traces: Trace[]; loading: boolean; onRefresh: () => void; t: (k: string, fb?: string) => string; locale: string }) {
  const [searchSessionId, setSearchSessionId] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const filteredTraces = traces.filter(tr => {
    if (searchSessionId && !tr.sessionId.toLowerCase().includes(searchSessionId.toLowerCase())) return false;
    if (statusFilter === "ok") return tr.status === "ok" || tr.status === "completed" || tr.status === "success";
    if (statusFilter === "error") return tr.status === "error" || tr.status === "failed";
    if (statusFilter === "active") return tr.status === "active" || !tr.endTime;
    return true;
  });

  const filterButtons = [
    { key: "all", label: t("observability.filter.all") },
    { key: "ok", label: t("observability.filter.ok") },
    { key: "error", label: t("observability.filter.error") },
    { key: "active", label: t("observability.filter.active") },
  ];

  return (
    <div>
      <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ width: "260px" }}>
          <TextInput
            value={searchSessionId}
            onChange={setSearchSessionId}
            placeholder={t("observability.search_placeholder")}
          />
        </div>
        {filterButtons.map(fb => (
          <button
            key={fb.key}
            onClick={() => setStatusFilter(fb.key)}
            style={{
              padding: "5px 14px", borderRadius: "6px", border: "1px solid",
              borderColor: statusFilter === fb.key ? "var(--accent)" : "var(--border)",
              background: statusFilter === fb.key ? "var(--accent-bg)" : "var(--bg-hover)",
              color: statusFilter === fb.key ? "var(--accent)" : "var(--text-secondary)",
              cursor: "pointer", fontSize: "12px", fontWeight: 600,
              transition: "all 0.15s",
            }}
          >
            {fb.label}
          </button>
        ))}
        <SecondaryButton small onClick={onRefresh}>
          {t("observability.refresh")}
        </SecondaryButton>
      </div>

      {loading ? (
        <Loading text={t("observability.loading")} />
      ) : filteredTraces.length === 0 ? (
        <EmptyState
          icon="🔍"
          title={t("observability.no_traces")}
          description={t("observability.no_traces_desc")}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {filteredTraces.map(trace => (
            <TraceRow key={trace.traceId} trace={trace} t={t} expandable locale={locale} />
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// Executions Tab
// ═══════════════════════════════════════════════

function ExecutionsTab({ executions, loading, t, locale }: { executions: Execution[]; loading: boolean; t: (k: string, fb?: string) => string; locale: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const safeExecutions = executions || [];
  const selected = safeExecutions.find(e => e.id === selectedId);

  return (
    <div>
      {loading ? (
        <Loading text={t("observability.loading")} />
      ) : safeExecutions.length === 0 ? (
        <EmptyState
          icon="📋"
          title={t("observability.no_executions")}
          description={t("observability.no_executions_desc")}
        />
      ) : (
        <div style={{ display: "flex", gap: "16px" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
            {safeExecutions.map((exec, i) => (
              <Card
                key={exec.id || `exec-${i}`}
                style={{
                  padding: "12px 16px",
                  cursor: "pointer",
                  borderColor: selectedId === exec.id ? "var(--accent)" : undefined,
                  transition: "border-color 0.15s",
                }}
              >
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  onClick={() => setSelectedId(selectedId === exec.id ? null : exec.id)}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ fontFamily: "monospace", fontSize: "12px", color: "var(--text-secondary)" }}>
                      {exec.id ? (exec.id.length > 16 ? `${exec.id.slice(0, 8)}…${exec.id.slice(-4)}` : exec.id) : "—"}
                    </span>
                    <Badge variant={statusBadgeVariant(exec.status)}>
                      {t(`observability.status.${exec.status || "unknown"}`, exec.status || "—")}
                    </Badge>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "12px", color: "var(--text-muted)" }}>
                    {exec.duration != null && (
                      <span>{formatDuration(exec.duration, t)}</span>
                    )}
                    {exec.timestamp && (
                      <span>{new Date(exec.timestamp).toLocaleString(locale)}</span>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {selected && (
            <Card
              title={t("observability.details")}
              style={{ width: "320px", flexShrink: 0, alignSelf: "flex-start" }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
                <DetailRow label={t("observability.execution_id")} value={selected.id || "—"} mono />
                <DetailRow label={t("observability.status")} value={t(`observability.status.${selected.status || "unknown"}`, selected.status || "unknown")} />
                {selected.duration != null && (
                  <DetailRow label={t("observability.duration")} value={formatDuration(selected.duration, t)} />
                )}
                {selected.timestamp && (
                  <DetailRow label={t("observability.timestamp")} value={new Date(selected.timestamp).toLocaleString(locale)} />
                )}
                {Object.entries(selected).map(([key, val]) => {
                  if (["id", "status", "duration", "timestamp"].includes(key)) return null;
                  if (val == null) return null;
                  return (
                    <DetailRow
                      key={key}
                      label={key}
                      value={typeof val === "object" ? JSON.stringify(val, null, 2) : String(val)}
                      mono={typeof val !== "string"}
                    />
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: "10px", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.3px", marginBottom: "2px" }}>
        {label}
      </div>
      <div style={{
        color: "var(--text-primary)",
        fontFamily: mono ? "monospace" : "inherit",
        fontSize: "12px",
        wordBreak: "break-all",
        whiteSpace: "pre-wrap",
      }}>
        {value}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// Spans Tab (OTel Span 追踪)
// ═══════════════════════════════════════════════

function formatSpanTime(ts: number | string, locale: string): string {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(locale);
}

function SpanRowTracing({ span, t, locale }: { span: TracingSpan; t: (k: string, fb?: string) => string; locale: string }) {
  const duration = span.duration ?? (span.endTime && span.startTime
    ? (typeof span.endTime === "number" && typeof span.startTime === "number"
      ? span.endTime - span.startTime
      : new Date(span.endTime).getTime() - new Date(span.startTime).getTime())
    : null);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
      padding: "8px 12px", borderRadius: "6px",
      background: "var(--bg-hover)", fontSize: "12px",
    }}>
      <Badge variant={kindBadgeVariant(span.kind)} style={{ fontSize: "10px", padding: "2px 7px" }}>
        {t(`observability.kind.${span.kind}`, span.kind)}
      </Badge>
      <span style={{ color: "var(--text-primary)", fontWeight: 500, flex: 1, minWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {span.name}
      </span>
      {span.status && (
        <Badge variant={statusBadgeVariant(span.status)} style={{ fontSize: "10px", padding: "2px 7px" }}>
          {t(`observability.status.${span.status}`, span.status)}
        </Badge>
      )}
      <span style={{ color: "var(--text-muted)", fontFamily: "monospace", fontSize: "11px" }}>
        {formatDuration(duration, t)}
      </span>
      <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>
        {formatSpanTime(span.startTime, locale)}
      </span>
    </div>
  );
}

function SpansTab({ t, locale }: { t: (k: string, fb?: string) => string; locale: string }) {
  const [spans, setSpans] = useState<TracingSpan[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchName, setSearchName] = useState("");
  const [searchTraceId, setSearchTraceId] = useState("");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [selectedTrace, setSelectedTrace] = useState<TracingSpan[] | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [clearing, setClearing] = useState(false);

  const loadSpans = useCallback(async () => {
    setLoading(true);
    try {
      const opts: { nameContains?: string; traceId?: string; limit?: number } = {};
      if (searchName.trim()) opts.nameContains = searchName.trim();
      if (searchTraceId.trim()) opts.traceId = searchTraceId.trim();
      opts.limit = 100;
      const data = await tracingApi.spans(opts);
      setSpans(data.spans);
      setTotal(data.total);
    } catch {
      setSpans([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [searchName, searchTraceId]);

  useEffect(() => { loadSpans(); }, [loadSpans]);

  const kinds = Array.from(new Set(spans.map(s => s.kind).filter(Boolean)));
  const filteredSpans = kindFilter === "all"
    ? spans
    : spans.filter(s => s.kind === kindFilter);

  const handleViewTrace = useCallback(async (traceId: string) => {
    if (!traceId) return;
    setTraceLoading(true);
    setSelectedTrace(null);
    try {
      const data = await tracingApi.trace(traceId);
      setSelectedTrace(data.spans);
    } catch {
      setSelectedTrace([]);
    } finally {
      setTraceLoading(false);
    }
  }, []);

  const handleClear = useCallback(async () => {
    setClearing(true);
    try {
      await tracingApi.clear();
      showToast(t("observability.spans_cleared", "Span 缓冲区已清空"), "success");
      await loadSpans();
    } catch {
      showToast(t("observability.clear_fail", "清空失败"), "error");
    } finally {
      setClearing(false);
    }
  }, [loadSpans, t]);

  const uniqueTraceIds = Array.from(new Set(spans.map(s => s.traceId).filter(Boolean)));

  return (
    <div>
      <StatsGrid items={[
        { label: t("observability.total_spans", "Span 总数"), value: total, color: "var(--accent)" },
        { label: t("observability.shown_spans", "当前展示"), value: filteredSpans.length, color: "var(--success)" },
        { label: t("observability.trace_count", "Trace 数"), value: uniqueTraceIds.length, color: "var(--text-primary)" },
      ]} />

      <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ width: "200px" }}>
          <TextInput
            value={searchName}
            onChange={setSearchName}
            placeholder={t("observability.search_name_placeholder", "按 span 名称搜索...")}
          />
        </div>
        <div style={{ width: "220px" }}>
          <TextInput
            value={searchTraceId}
            onChange={(v) => { setSearchTraceId(v); setSelectedTrace(null); }}
            placeholder={t("observability.search_traceid_placeholder", "按 trace ID 搜索...")}
          />
        </div>
        {kinds.length > 0 && (
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            style={{
              padding: "6px 10px", borderRadius: "6px",
              border: "1px solid var(--border)", background: "var(--bg-hover)",
              color: "var(--text-primary)", fontSize: "12px", cursor: "pointer",
            }}
          >
            <option value="all">{t("observability.filter.all", "全部")}</option>
            {kinds.map(k => (
              <option key={k} value={k}>{t(`observability.kind.${k}`, k)}</option>
            ))}
          </select>
        )}
        <SecondaryButton small onClick={loadSpans}>{t("observability.refresh", "刷新")}</SecondaryButton>
        <PrimaryButton small danger onClick={handleClear} disabled={clearing || total === 0}>
          {clearing ? t("observability.clearing", "清空中...") : t("observability.clear_spans", "清空 Span")}
        </PrimaryButton>
      </div>

      {loading ? (
        <Loading text={t("observability.loading", "加载中...")} />
      ) : (
        <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {filteredSpans.length === 0 ? (
              <EmptyState
                icon="🔍"
                title={t("observability.no_spans", "无 Span 数据")}
                description={t("observability.no_spans_desc", "后端 Span 收集器暂无数据或未启用")}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {filteredSpans.map((span, i) => (
                  <div key={span.spanId || i} style={{ cursor: span.traceId ? "pointer" : "default" }}
                    onClick={() => span.traceId && handleViewTrace(span.traceId)}>
                    <SpanRowTracing span={span} t={t} locale={locale} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {(selectedTrace || traceLoading) && (
            <Card
              title={t("observability.trace_detail", "Trace 详情")}
              style={{ width: "340px", flexShrink: 0 }}
              actions={
                <SecondaryButton small onClick={() => setSelectedTrace(null)}>✕</SecondaryButton>
              }
            >
              {traceLoading ? (
                <Loading text={t("observability.loading", "加载中...")} />
              ) : selectedTrace && selectedTrace.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  {selectedTrace.map((span, i) => (
                    <SpanRowTracing key={span.spanId || i} span={span} t={t} locale={locale} />
                  ))}
                </div>
              ) : (
                <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "12px 0" }}>
                  {t("observability.no_trace_spans", "该 Trace 无 Span 数据")}
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// Main Page
// ═══════════════════════════════════════════════

export default function ObservabilityPage() {
  const { t, lang } = useTranslation();
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [traces, setTraces] = useState<Trace[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadTraces = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/observability/traces`);
      if (res.ok) {
        const data = await res.json();
        setTraces(Array.isArray(data) ? data : data.traces || []);
      }
    } catch {
      // silently ignore — will retry on next interval
    }
  }, []);

  const loadExecutions = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/executions`);
      if (res.ok) {
        const data = await res.json();
        setExecutions(Array.isArray(data) ? data : data.executions || []);
      }
    } catch {
      // silently ignore
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadTraces(), loadExecutions()]);
    setLoading(false);
  }, [loadTraces, loadExecutions]);

  // Initial load
  useEffect(() => { loadAll(); }, [loadAll]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        loadTraces();
        loadExecutions();
      }, 10000);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [autoRefresh, loadTraces, loadExecutions]);

  return (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <PageHeader
        title={t("observability.title")}
        subtitle={t("observability.subtitle")}
        actions={
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <SecondaryButton
              small
              onClick={() => setAutoRefresh(!autoRefresh)}
              style={{
                borderColor: autoRefresh ? "var(--success)" : "var(--border)",
                color: autoRefresh ? "var(--success)" : "var(--text-secondary)",
              }}
            >
              {autoRefresh ? t("observability.auto_refresh_on") : t("observability.auto_refresh_off")}
            </SecondaryButton>
            <PrimaryButton small onClick={loadAll}>
              {t("observability.refresh")}
            </PrimaryButton>
          </div>
        }
      />

      {/* Tab bar */}
      <div style={{
        display: "flex", gap: "4px", marginBottom: "20px",
        borderBottom: "1px solid var(--border)", paddingBottom: "0",
      }}>
        {TAB_KEYS.map(tab => {
          const isActive = activeTab === tab;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: "10px 20px", border: "none", background: "transparent",
                color: isActive ? "var(--accent)" : "var(--text-muted)",
                fontWeight: isActive ? 600 : 500, fontSize: "13px",
                cursor: "pointer", position: "relative",
                borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                marginBottom: "-1px", transition: "color 0.15s, border-color 0.15s",
              }}
            >
              {t(`observability.tab.${tab}`)}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === "spans" ? (
        <SpansTab t={t} locale={locale} />
      ) : loading ? (
        <Loading text={t("observability.loading")} />
      ) : (
        <>
          {activeTab === "overview" && <OverviewTab traces={traces} t={t} locale={locale} />}
          {activeTab === "traces" && (
            <TracesTab traces={traces} loading={false} onRefresh={loadAll} t={t} locale={locale} />
          )}
          {activeTab === "executions" && (
            <ExecutionsTab executions={executions} loading={false} t={t} locale={locale} />
          )}
        </>
      )}
    </div>
  );
}
