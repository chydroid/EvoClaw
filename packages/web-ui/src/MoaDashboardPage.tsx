/**
 * MoaDashboardPage — MoA (Mixture-of-Agents) 多模型推理仪表盘
 *
 * 展示 MoA 配置（proposers/aggregator/verifier/synthesizer），
 * 最近执行结果（proposals/aggregation/verification/finalAnswer），
 * 以及统计信息（totalLatency/totalTokens/totalCost）。
 */

import { useState, useEffect, useCallback } from "react";
import {
  PageHeader, Card, Badge, Loading, EmptyState,
  PrimaryButton, SecondaryButton, Section, StatsGrid,
  StatusDot, showToast,
} from "./shared";
import { useApiCall } from "./useApiCall";
import { useTranslation } from "./i18n";
import { moaApi, type MoaStatusResponse, type MoaRunResult, type MoaHistoryResponse } from "./api-client";

export default function MoaDashboardPage() {
  const { t } = useTranslation();
  const { call, loading } = useApiCall();
  const [status, setStatus] = useState<MoaStatusResponse | null>(null);
  const [history, setHistory] = useState<MoaHistoryResponse>({ history: [], total: 0 });
  const [loadingState, setLoadingState] = useState(true);
  const [lastResult, setLastResult] = useState<MoaRunResult | null>(null);

  // Run form state
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async () => {
    setLoadingState(true);
    const [s, h] = await Promise.all([
      moaApi.status(),
      moaApi.history(),
    ]);
    setStatus(s);
    setHistory(h);
    setLoadingState(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleRun() {
    if (!prompt.trim()) return;
    setRunning(true);
    const result = await call(
      () => moaApi.run(prompt.trim()),
      { errorMessage: t("moa.run_failed", "MoA 执行失败") },
    );
    if (result) {
      setLastResult(result);
      showToast(t("moa.run_success", "MoA 执行完成"), "success");
      refresh();
    }
    setRunning(false);
  }

  function fmtMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function fmtCost(cost: number): string {
    if (cost === 0) return "$0";
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
  }

  if (loadingState) {
    return <Loading text={t("moa.loading", "加载 MoA 状态...")} />;
  }

  const config = status?.config;
  const stats = status?.stats;

  return (
    <div style={{ padding: 24 }}>
      <PageHeader
        title={t("moa.title", "MoA 多模型推理")}
        subtitle={t("moa.subtitle", "Mixture-of-Agents：多阶段流水线 Proposal → Aggregation → Verification → Synthesis")}
        actions={
          <SecondaryButton onClick={refresh} disabled={loading}>
            {t("moa.refresh", "刷新")}
          </SecondaryButton>
        }
      />

      {!status?.available && (
        <Card style={{ marginBottom: 16, borderColor: "var(--warning)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StatusDot status="warning" />
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {t("moa.unavailable", "MoA 引擎未启用。请联系管理员注册 moaEngine 服务。")}
            </span>
          </div>
        </Card>
      )}

      {/* Stats */}
      {stats && (
        <Section title={t("moa.stats_title", "运行统计")}>
          <StatsGrid items={[
            { label: t("moa.total_runs", "总执行"), value: stats.totalRuns, color: "var(--text-primary)" },
            { label: t("moa.success_runs", "成功"), value: stats.successfulRuns, color: "var(--success)" },
            { label: t("moa.failed_runs", "失败"), value: stats.failedRuns, color: "var(--error)" },
            { label: t("moa.total_latency", "总延迟"), value: fmtMs(stats.totalLatencyMs), color: "var(--accent)" },
            { label: t("moa.total_tokens", "总 Tokens"), value: stats.totalTokens, color: "var(--accent)" },
            { label: t("moa.total_cost", "总成本"), value: fmtCost(stats.totalCost), color: "var(--warning)" },
            { label: t("moa.avg_latency", "平均延迟"), value: fmtMs(stats.averageLatencyMs), color: "var(--text-primary)" },
          ]} />
        </Section>
      )}

      {/* Config */}
      <Section title={t("moa.config_title", "MoA 配置")}>
        {config ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            <ModelRoleCard
              title={t("moa.proposers", "Proposers（提案模型）")}
              models={config.proposers}
              variant="info"
            />
            <ModelRoleCard
              title={t("moa.aggregator", "Aggregator（聚合模型）")}
              models={config.aggregator ? [config.aggregator] : []}
              variant="default"
              emptyText={t("moa.no_aggregator", "未配置（使用 concat 策略）")}
            />
            <ModelRoleCard
              title={t("moa.verifier", "Verifier（验证模型）")}
              models={config.verifier ? [config.verifier] : []}
              variant="warning"
              emptyText={t("moa.no_verifier", "未启用验证")}
            />
            <ModelRoleCard
              title={t("moa.synthesizer", "Synthesizer（综合模型）")}
              models={config.synthesizer ? [config.synthesizer] : []}
              variant="success"
            />
          </div>
        ) : (
          <EmptyState title={t("moa.no_config", "未配置 MoA")} description={t("moa.no_config_desc", "尚未注册 MoA 引擎或配置")} />
        )}
        {config && (
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Badge variant="info">
              {t("moa.strategy", "策略")}: {config.aggregationStrategy || "concat"}
            </Badge>
            <Badge variant={config.verificationEnabled ? "success" : "default"}>
              {t("moa.verification", "验证")}: {config.verificationEnabled ? t("moa.enabled", "启用") : t("moa.disabled", "禁用")}
            </Badge>
          </div>
        )}
      </Section>

      {/* Run */}
      <Section title={t("moa.run_title", "执行 MoA 推理")}>
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {t("moa.prompt", "提示词")}
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("moa.prompt_placeholder", "输入要询问的问题...")}
                rows={3}
                style={{
                  width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 8,
                  border: "1px solid var(--input-border)", background: "var(--bg-input)",
                  color: "var(--text-primary)", fontSize: 13, resize: "vertical", outline: "none",
                  fontFamily: "inherit",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <PrimaryButton onClick={handleRun} disabled={!prompt.trim() || running || !status?.available}>
                {running ? t("moa.running", "执行中...") : t("moa.run", "执行")}
              </PrimaryButton>
            </div>
          </div>
        </Card>
      </Section>

      {/* Last Result */}
      {lastResult && (
        <Section title={t("moa.last_result", "最近执行结果")}>
          <MoaResultView result={lastResult} t={t} fmtMs={fmtMs} />
        </Section>
      )}

      {/* History */}
      <Section title={t("moa.history_title", "历史执行")}>
        {history.history.length === 0 ? (
          <EmptyState title={t("moa.no_history", "暂无历史记录")} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {history.history.slice(0, 10).map((h, i) => (
              <Card key={i} style={{ padding: "12px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>
                    #{i + 1}
                  </span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Badge variant="info">{fmtMs(h.stats.totalLatencyMs)}</Badge>
                    <Badge variant="default">{h.stats.totalTokens} tok</Badge>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
                  <strong>{t("moa.prompt", "提示词")}:</strong> {h.prompt.slice(0, 80)}{h.prompt.length > 80 ? "..." : ""}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-primary)", background: "var(--bg-hover)", padding: 8, borderRadius: 6 }}>
                  {h.finalAnswer.slice(0, 200)}{h.finalAnswer.length > 200 ? "..." : ""}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────

function ModelRoleCard({ title, models, variant, emptyText }: {
  title: string;
  models: Array<{ provider: string; model: string; weight?: number }>;
  variant: "info" | "default" | "warning" | "success";
  emptyText?: string;
}) {
  return (
    <Card style={{ padding: "12px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <Badge variant={variant}>{title}</Badge>
      </div>
      {models.length === 0 ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
          {emptyText || "—"}
        </span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {models.map((m, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--text-primary)" }}>
              <span style={{ color: "var(--accent)", fontWeight: 600 }}>{m.provider}</span>
              <span style={{ color: "var(--text-muted)" }}> / </span>
              <span>{m.model}</span>
              {m.weight !== undefined && (
                <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
                  (w={m.weight})
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function MoaResultView({ result, t, fmtMs }: {
  result: MoaRunResult;
  t: (key: string, fallback?: string) => string;
  fmtMs: (ms: number) => string;
}) {
  return (
    <Card>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        <Badge variant="info">{result.proposals.length} {t("moa.proposals", "提案")}</Badge>
        <Badge variant="default">{t("moa.strategy", "策略")}: {result.aggregation.strategy}</Badge>
        <Badge variant={result.verification?.passed ? "success" : "warning"}>
          {t("moa.verification", "验证")}: {result.verification ? (result.verification.passed ? "✓" : "✗") : "N/A"}
        </Badge>
        <Badge variant="info">{fmtMs(result.stats.totalLatencyMs)}</Badge>
        <Badge variant="default">{result.stats.totalTokens} tok</Badge>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 6 }}>
          {t("moa.final_answer", "最终答案")}
        </div>
        <div style={{
          fontSize: 13, color: "var(--text-primary)", lineHeight: 1.6,
          background: "var(--bg-hover)", padding: 12, borderRadius: 8,
          whiteSpace: "pre-wrap",
        }}>
          {result.finalAnswer}
        </div>
      </div>

      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--accent)", fontWeight: 600 }}>
          {t("moa.proposal_details", "查看各提案详情")}
        </summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {result.proposals.map((p, i) => (
            <div key={i} style={{
              padding: 8, borderRadius: 6, background: "var(--bg-card)",
              border: "1px solid var(--border)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                  {p.model}
                </span>
                <div style={{ display: "flex", gap: 4 }}>
                  <Badge variant={p.success ? "success" : "error"}>
                    {p.success ? "✓" : "✗"}
                  </Badge>
                  <Badge variant="default">{p.tokens} tok</Badge>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>
                {p.error ? <span style={{ color: "var(--error)" }}>{p.error}</span> : p.content.slice(0, 300)}
              </div>
            </div>
          ))}
        </div>
      </details>
    </Card>
  );
}
