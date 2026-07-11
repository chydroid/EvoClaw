/**
 * EvalRunnerPage — 评测运行器
 *
 * 展示评测用例列表、运行评测、查看运行历史与运行详情。
 */
import React, { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, DataTable,
  Modal, showToast,
} from "./shared";
import { useTranslation } from "./i18n";

// ── API 响应类型 ──────────────────────────────────────────────

interface EvalCase {
  id: string;
  name: string;
  category?: string;
  description?: string;
}

interface EvalRun {
  id: string;
  caseId?: string;
  caseName?: string;
  model?: string;
  status: string;
  score?: number;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
}

interface RunDetail extends EvalRun {
  input?: string;
  expected?: string;
  actual?: string;
  output?: string;
  error?: string;
  tokensUsed?: number;
  metrics?: Record<string, unknown>;
}

// ── 样式 ──────────────────────────────────────────────────────

const s: Record<string, CSSProperties> = {
  container: { padding: "20px", overflow: "auto", height: "100%" },
  formRow: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" as const },
  select: {
    padding: "8px 12px", borderRadius: "8px",
    border: "1px solid var(--input-border)", background: "var(--bg-input)",
    color: "var(--text-primary)", fontSize: "13px", outline: "none",
    minWidth: "200px",
  },
  input: {
    padding: "8px 12px", borderRadius: "8px",
    border: "1px solid var(--input-border)", background: "var(--bg-input)",
    color: "var(--text-primary)", fontSize: "13px", outline: "none",
    width: "200px", boxSizing: "border-box" as const,
  },
  monoText: { fontFamily: "monospace", fontSize: "12px", color: "var(--text-primary)" },
  detailBlock: {
    background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "8px",
    padding: "12px", marginTop: "10px",
    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
    fontSize: "12px", color: "var(--text-primary)",
    whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const,
    maxHeight: "260px", overflow: "auto",
  },
  detailRow: { display: "flex", gap: "12px", fontSize: "12px", marginTop: "8px", flexWrap: "wrap" as const },
  detailLabel: { color: "var(--text-muted)", minWidth: "90px" },
  detailValue: { color: "var(--text-primary)", fontWeight: 600 },
  sectionTitle: { fontSize: "12px", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.5px", marginTop: "14px", marginBottom: "6px" },
};

function statusVariant(status: string): "success" | "error" | "warning" | "info" | "default" {
  switch (status) {
    case "completed":
    case "passed":
    case "success": return "success";
    case "failed":
    case "error": return "error";
    case "running":
    case "pending": return "warning";
    default: return "default";
  }
}

function scoreColor(score: number | undefined): string {
  if (score == null) return "var(--text-muted)";
  if (score >= 0.8) return "var(--success)";
  if (score >= 0.5) return "var(--warning)";
  return "var(--error)";
}

function formatScore(score: number | undefined): string {
  if (score == null) return "-";
  return `${(score * 100).toFixed(1)}%`;
}

function formatTime(iso: string | undefined, locale: string): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString(locale);
}

function formatMs(ms: number | undefined): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export default function EvalRunnerPage() {
  const { t, lang } = useTranslation();
  const locale = lang === "zh" ? "zh-CN" : "en-US";

  const [cases, setCases] = useState<EvalCase[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Run eval form
  const [runCaseId, setRunCaseId] = useState("");
  const [runModel, setRunModel] = useState("");
  const [running, setRunning] = useState(false);

  // Run detail modal
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [casesRes, runsRes] = await Promise.all([
        fetch("/api/evals/cases"),
        fetch("/api/evals/runs"),
      ]);
      if (!casesRes.ok) throw new Error(`Failed to load eval cases: ${casesRes.status}`);
      if (!runsRes.ok) throw new Error(`Failed to load eval runs: ${runsRes.status}`);
      const casesData = await casesRes.json();
      const runsData = await runsRes.json();
      const casesList: EvalCase[] = casesData.cases || casesData || [];
      const runsList: EvalRun[] = runsData.runs || runsData || [];
      setCases(casesList);
      setRuns(runsList);
      if (casesList.length > 0) {
        setRunCaseId(prev => prev || casesList[0].id);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("eval.load_failed", "加载失败"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 20000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRun = useCallback(async () => {
    setRunning(true);
    try {
      const body: Record<string, unknown> = {};
      if (runCaseId) body.caseId = runCaseId;
      if (runModel.trim()) body.model = runModel.trim();
      const res = await fetch("/api/evals/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || t("eval.run_failed", "运行评测失败"));
      }
      showToast(t("eval.run_started", "评测已启动"), "success");
      await fetchData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("eval.run_failed", "运行评测失败"), "error");
    } finally {
      setRunning(false);
    }
  }, [runCaseId, runModel, fetchData, t]);

  const handleViewDetail = useCallback(async (runId: string) => {
    setDetailRunId(runId);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/evals/runs/${encodeURIComponent(runId)}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || t("eval.load_failed", "加载失败"));
      }
      setDetail(data.run || data);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("eval.load_failed", "加载失败"), "error");
      setDetailRunId(null);
    } finally {
      setDetailLoading(false);
    }
  }, [t]);

  const caseMap = new Map(cases.map((c) => [c.id, c]));

  if (loading) return <Loading text={t("app.loading", "正在加载...")} />;

  return (
    <div style={s.container}>
      <PageHeader
        title={t("eval.title", "评测运行器")}
        subtitle={t("eval.subtitle", "运行评测用例并查看历史结果")}
        actions={<SecondaryButton onClick={fetchData} small>{t("eval.refresh", "刷新")}</SecondaryButton>}
      />

      {error && <ErrorBanner message={error} onRetry={fetchData} />}

      <Section title={t("eval.run_eval", "运行评测")} style={{ marginTop: "20px" }}>
        <Card>
          <div style={s.formRow}>
            <label style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t("eval.select_case", "选择用例")}</label>
            <select style={s.select} value={runCaseId} onChange={(e) => setRunCaseId(e.target.value)}>
              <option value="">{t("eval.all_cases", "全部用例")}</option>
              {cases.map((c) => (
                <option key={c.id} value={c.id}>{c.name || c.id}</option>
              ))}
            </select>
            <label style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t("eval.model", "模型")}</label>
            <input style={s.input} value={runModel} onChange={(e) => setRunModel(e.target.value)} placeholder={t("eval.model_placeholder", "可选，留空使用默认模型")} />
            <PrimaryButton onClick={handleRun} disabled={running}>
              {running ? t("eval.running", "运行中...") : t("eval.run", "运行")}
            </PrimaryButton>
          </div>
        </Card>
      </Section>

      <Section title={t("eval.cases_title", "评测用例")} style={{ marginTop: "20px" }}>
        <Card>
          {cases.length === 0 ? (
            <EmptyState icon="" title={t("eval.no_cases", "暂无评测用例")} />
          ) : (
            <DataTable
              columns={[
                { key: "id", label: t("eval.case_id", "用例 ID"), width: "20%", render: (c: EvalCase) => <span style={s.monoText}>{c.id}</span> },
                { key: "name", label: t("eval.case_name", "名称"), width: "20%", render: (c: EvalCase) => <strong style={{ color: "var(--text-primary)" }}>{c.name}</strong> },
                { key: "category", label: t("eval.case_category", "类别"), width: "15%", render: (c: EvalCase) => c.category ? <Badge variant="info">{c.category}</Badge> : "-" },
                { key: "description", label: t("eval.case_description", "描述"), width: "45%", render: (c: EvalCase) => <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>{c.description || "-"}</span> },
              ]}
              data={cases}
              keyFn={(c) => c.id}
            />
          )}
        </Card>
      </Section>

      <Section title={t("eval.runs_title", "运行历史")} style={{ marginTop: "20px" }}>
        <Card>
          {runs.length === 0 ? (
            <EmptyState icon="" title={t("eval.no_runs", "暂无运行记录")} />
          ) : (
            <DataTable
              columns={[
                { key: "id", label: t("eval.run_id", "运行 ID"), width: "15%", render: (r: EvalRun) => <span style={s.monoText}>{r.id.slice(0, 12)}...</span> },
                {
                  key: "caseName", label: t("eval.case", "用例"), width: "20%",
                  render: (r: EvalRun) => r.caseName || (r.caseId ? (caseMap.get(r.caseId)?.name || r.caseId) : "-"),
                },
                { key: "model", label: t("eval.model_col", "模型"), width: "15%", render: (r: EvalRun) => <span style={s.monoText}>{r.model || "-"}</span> },
                {
                  key: "status", label: t("eval.status", "状态"), width: "12%",
                  render: (r: EvalRun) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge>,
                },
                {
                  key: "score", label: t("eval.score", "得分"), width: "12%",
                  render: (r: EvalRun) => <strong style={{ color: scoreColor(r.score) }}>{formatScore(r.score)}</strong>,
                },
                { key: "createdAt", label: t("eval.created_at", "时间"), width: "16%", render: (r: EvalRun) => formatTime(r.createdAt, locale) },
                {
                  key: "actions", label: "", width: "10%",
                  render: (r: EvalRun) => (
                    <PrimaryButton small onClick={() => handleViewDetail(r.id)}>
                      {t("eval.view_details", "详情")}
                    </PrimaryButton>
                  ),
                },
              ]}
              data={runs}
              keyFn={(r) => r.id}
            />
          )}
        </Card>
      </Section>

      {detailRunId && (
        <Modal
          title={t("eval.run_details", "运行详情")}
          onClose={() => { setDetailRunId(null); setDetail(null); }}
          width={640}
          footer={<SecondaryButton onClick={() => { setDetailRunId(null); setDetail(null); }}>{t("eval.close", "关闭")}</SecondaryButton>}
        >
          {detailLoading ? (
            <div style={{ textAlign: "center", padding: "30px", color: "var(--text-muted)", fontSize: "13px" }}>{t("app.loading", "正在加载...")}</div>
          ) : detail ? (
            <div>
              <div style={s.detailRow}>
                <div><span style={s.detailLabel}>{t("eval.run_id", "运行 ID")}:</span> <span style={s.detailValue}>{detail.id.slice(0, 16)}...</span></div>
                <div><span style={s.detailLabel}>{t("eval.status", "状态")}:</span> <Badge variant={statusVariant(detail.status)}>{detail.status}</Badge></div>
              </div>
              <div style={s.detailRow}>
                <div><span style={s.detailLabel}>{t("eval.case", "用例")}:</span> <span style={s.detailValue}>{detail.caseName || detail.caseId || "-"}</span></div>
                <div><span style={s.detailLabel}>{t("eval.model_col", "模型")}:</span> <span style={s.detailValue}>{detail.model || "-"}</span></div>
              </div>
              <div style={s.detailRow}>
                <div><span style={s.detailLabel}>{t("eval.score", "得分")}:</span> <strong style={{ color: scoreColor(detail.score) }}>{formatScore(detail.score)}</strong></div>
                <div><span style={s.detailLabel}>{t("eval.created_at", "创建")}:</span> <span style={s.detailValue}>{formatTime(detail.createdAt, locale)}</span></div>
                <div><span style={s.detailLabel}>{t("eval.duration", "耗时")}:</span> <span style={s.detailValue}>{formatMs(detail.durationMs)}</span></div>
                {detail.tokensUsed != null && (
                  <div><span style={s.detailLabel}>{t("eval.tokens", "Tokens")}:</span> <span style={s.detailValue}>{detail.tokensUsed}</span></div>
                )}
              </div>

              {detail.error && (
                <>
                  <div style={s.sectionTitle}>{t("eval.error", "错误")}</div>
                  <div style={{ ...s.detailBlock, color: "var(--error)" }}>{detail.error}</div>
                </>
              )}

              {detail.input != null && (
                <>
                  <div style={s.sectionTitle}>{t("eval.input", "输入")}</div>
                  <div style={s.detailBlock}>{detail.input}</div>
                </>
              )}

              {detail.expected != null && (
                <>
                  <div style={s.sectionTitle}>{t("eval.expected", "期望输出")}</div>
                  <div style={s.detailBlock}>{detail.expected}</div>
                </>
              )}

              {detail.actual != null && (
                <>
                  <div style={s.sectionTitle}>{t("eval.actual", "实际输出")}</div>
                  <div style={s.detailBlock}>{detail.actual}</div>
                </>
              )}

              {detail.output != null && detail.actual == null && (
                <>
                  <div style={s.sectionTitle}>{t("eval.output", "输出")}</div>
                  <div style={s.detailBlock}>{detail.output}</div>
                </>
              )}
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "30px", color: "var(--text-muted)", fontSize: "13px" }}>{t("eval.no_details", "无详情数据")}</div>
          )}
        </Modal>
      )}
    </div>
  );
}
