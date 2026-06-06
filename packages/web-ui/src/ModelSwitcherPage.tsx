/**
 * ModelSwitcherPage — Model switching and connectivity testing.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, StatusDot, StatsGrid, showToast,
} from "./shared";
import { modelApi, type ModelInfo } from "./api-client";
import { useTranslation } from "./i18n";

const s = {
  container: { padding: "20px", overflow: "auto", height: "100%" } as React.CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
    gap: "12px",
  } as React.CSSProperties,
  modelCard: {
    background: "var(--bg-card)",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    padding: "16px",
  } as React.CSSProperties,
  modelCardActive: {
    background: "var(--bg-card)",
    border: "2px solid var(--accent)",
    borderRadius: "10px",
    padding: "16px",
    boxShadow: "0 0 12px rgba(88,166,255,0.15)",
  } as React.CSSProperties,
  modelHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: "10px",
  } as React.CSSProperties,
  modelName: {
    fontSize: "15px",
    fontWeight: 700,
    color: "var(--text-primary)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  } as React.CSSProperties,
  modelMeta: {
    fontSize: "12px",
    color: "var(--text-muted)",
    marginTop: "2px",
  } as React.CSSProperties,
  capList: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    marginBottom: "10px",
  } as React.CSSProperties,
  detailRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "4px 0",
    fontSize: "12px",
  } as React.CSSProperties,
  detailLabel: { color: "var(--text-muted)" } as React.CSSProperties,
  detailValue: { color: "var(--text-primary)", fontWeight: 600 } as React.CSSProperties,
  activeLabel: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "10px",
    fontSize: "10px",
    fontWeight: 700,
    background: "var(--accent-bg)",
    color: "var(--accent)",
    marginLeft: "8px",
  } as React.CSSProperties,
  latencyResult: {
    marginTop: "8px",
    padding: "6px 10px",
    borderRadius: "6px",
    fontSize: "12px",
    background: "var(--bg-input)",
    color: "var(--success)",
    fontWeight: 600,
  } as React.CSSProperties,
  latencyError: {
    marginTop: "8px",
    padding: "6px 10px",
    borderRadius: "6px",
    fontSize: "12px",
    background: "var(--error-bg)",
    color: "var(--error)",
    fontWeight: 600,
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "8px",
    marginTop: "12px",
  } as React.CSSProperties,
};

export default function ModelSwitcherPage() {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; latencyMs: number }>>({});
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [modelsRes, currentRes] = await Promise.all([
        modelApi.list(),
        modelApi.current().catch(() => null),
      ]);
      setModels(modelsRes.models);
      setCurrentModelId(currentRes?.model?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("model.load_fail", "加载模型失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleTest = useCallback(async (modelId: string) => {
    setTestingIds((prev) => new Set(prev).add(modelId));
    try {
      const result = await modelApi.test(modelId);
      setTestResults((prev) => ({ ...prev, [modelId]: { success: result.success, latencyMs: result.latencyMs } }));
    } catch {
      setTestResults((prev) => ({ ...prev, [modelId]: { success: false, latencyMs: 0 } }));
    } finally {
      setTestingIds((prev) => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });
    }
  }, []);

  const handleSwitch = useCallback(async (modelId: string) => {
    setSwitchingId(modelId);
    try {
      await modelApi.switch(modelId);
      setCurrentModelId(modelId);
      showToast(t("model_switcher.switched"), "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("model_switcher.switch_fail"), "error");
    } finally {
      setSwitchingId(null);
    }
  }, [t]);

  if (loading) return <Loading text={t("app.loading")} />;
  if (error) return <div style={s.container}><ErrorBanner message={error} onRetry={fetchData} /></div>;

  const currentModel = models.find((m) => m.id === currentModelId);
  const availableCount = models.length;
  const activeCount = models.filter((m) => m.status === "active").length;

  return (
    <div style={s.container}>
      <PageHeader
        title={t("model_switcher.title")}
        subtitle={t("model_switcher.subtitle")}
        actions={<SecondaryButton onClick={fetchData} small>{t("model.refresh", "刷新")}</SecondaryButton>}
      />

      <StatsGrid
        items={[
          { label: t("model_switcher.current"), value: currentModel?.name ?? t("model.none", "无"), color: "var(--accent)" },
          { label: t("model_switcher.available"), value: availableCount },
          { label: t("model.active_models", "活跃模型"), value: activeCount, color: "var(--success)" },
          { label: t("model.inactive", "未激活"), value: availableCount - activeCount, color: "var(--text-muted)" },
        ]}
      />

      {currentModel && (
        <Section title={t("model_switcher.current")} style={{ marginTop: "20px" }}>
          <div style={s.modelCardActive}>
            <div style={s.modelHeader}>
              <div>
                <div style={s.modelName}>
                  <StatusDot status="active" size={10} />
                  {currentModel.name}
                  <span style={s.activeLabel}>{t("model.active", "活跃")}</span>
                </div>
                <div style={s.modelMeta}>
                  {currentModel.provider} / {currentModel.model}
                </div>
              </div>
            </div>
            <div style={s.capList}>
              {currentModel.capabilities.map((cap) => (
                <Badge key={cap} variant="info">{cap}</Badge>
              ))}
            </div>
            <div style={s.detailRow}>
              <span style={s.detailLabel}>{t("model_switcher.max_tokens")}</span>
              <span style={s.detailValue}>{currentModel.maxTokens.toLocaleString()}</span>
            </div>
            <div style={s.detailRow}>
              <span style={s.detailLabel}>{t("model.cost_input", "费用 (输入)")}</span>
              <span style={s.detailValue}>${currentModel.costPer1k.input}/1k tokens</span>
            </div>
            <div style={s.detailRow}>
              <span style={s.detailLabel}>{t("model.cost_output", "费用 (输出)")}</span>
              <span style={s.detailValue}>${currentModel.costPer1k.output}/1k tokens</span>
            </div>
            {testResults[currentModel.id] && (
              <div style={testResults[currentModel.id].success ? s.latencyResult : s.latencyError}>
                {testResults[currentModel.id].success
                  ? t("model.latency_ms", "延迟: {0}ms").replace("{0}", String(testResults[currentModel.id].latencyMs))
                  : t("model_switcher.test_fail")}
              </div>
            )}
            <div style={s.actions}>
              <PrimaryButton onClick={() => handleTest(currentModel.id)} disabled={testingIds.has(currentModel.id)} small>
                {testingIds.has(currentModel.id) ? t("model_switcher.testing") : t("model_switcher.test")}
              </PrimaryButton>
            </div>
          </div>
        </Section>
      )}

      <Section title={t("model_switcher.available")} style={{ marginTop: "24px" }}>
        {models.length === 0 ? (
          <EmptyState icon="" title={t("model_switcher.no_models")} description={t("model.add_to_start", "添加模型以开始使用")} />
        ) : (
          <div style={s.grid}>
            {models.map((model) => {
              const isActive = model.id === currentModelId;
              const cardStyle = isActive ? s.modelCardActive : s.modelCard;
              return (
                <div key={model.id} style={cardStyle}>
                  <div style={s.modelHeader}>
                    <div>
                      <div style={s.modelName}>
                        <StatusDot status={model.status} size={8} />
                        {model.name}
                        {isActive && <span style={s.activeLabel}>{t("model.active", "活跃")}</span>}
                      </div>
                      <div style={s.modelMeta}>
                        {model.provider} / {model.model}
                      </div>
                    </div>
                  </div>
                  <div style={s.capList}>
                    {model.capabilities.map((cap) => (
                      <Badge key={cap} variant="info">{cap}</Badge>
                    ))}
                  </div>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>{t("model_switcher.max_tokens")}</span>
                    <span style={s.detailValue}>{model.maxTokens.toLocaleString()}</span>
                  </div>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>{t("model.cost_input_output", "费用 (输入/输出)")}</span>
                    <span style={s.detailValue}>${model.costPer1k.input}/${model.costPer1k.output}</span>
                  </div>
                  {testResults[model.id] && (
                    <div style={testResults[model.id].success ? s.latencyResult : s.latencyError}>
                      {testResults[model.id].success
                        ? t("model.latency_ms", "延迟: {0}ms").replace("{0}", String(testResults[model.id].latencyMs))
                        : t("model_switcher.test_fail")}
                    </div>
                  )}
                  <div style={s.actions}>
                    <PrimaryButton onClick={() => handleTest(model.id)} disabled={testingIds.has(model.id)} small>
                      {testingIds.has(model.id) ? t("model_switcher.testing") : t("model_switcher.test")}
                    </PrimaryButton>
                    {!isActive && (
                      <SecondaryButton
                        onClick={() => handleSwitch(model.id)}
                        disabled={switchingId === model.id}
                        small
                      >
                        {switchingId === model.id ? t("model.switching", "切换中...") : t("model_switcher.switch_to")}
                      </SecondaryButton>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
