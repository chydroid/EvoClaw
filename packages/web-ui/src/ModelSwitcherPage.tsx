/**
 * ModelSwitcherPage — Model switching and connectivity testing.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, StatusDot, StatsGrid, showToast,
} from "./shared";
import { modelApi, type ModelInfo } from "./api-client";

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
      setError(err instanceof Error ? err.message : "Failed to load models");
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
      showToast("Model switched successfully", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to switch model", "error");
    } finally {
      setSwitchingId(null);
    }
  }, []);

  if (loading) return <Loading text="Loading models..." />;
  if (error) return <div style={s.container}><ErrorBanner message={error} onRetry={fetchData} /></div>;

  const currentModel = models.find((m) => m.id === currentModelId);
  const availableCount = models.length;
  const activeCount = models.filter((m) => m.status === "active").length;

  return (
    <div style={s.container}>
      <PageHeader
        title="Model Switcher"
        subtitle="Switch between LLM models and test connectivity"
        actions={<SecondaryButton onClick={fetchData} small>Refresh</SecondaryButton>}
      />

      <StatsGrid
        items={[
          { label: "Active Model", value: currentModel?.name ?? "None", color: "var(--accent)" },
          { label: "Available Models", value: availableCount },
          { label: "Active Models", value: activeCount, color: "var(--success)" },
          { label: "Inactive", value: availableCount - activeCount, color: "var(--text-muted)" },
        ]}
      />

      {/* Current Active Model */}
      {currentModel && (
        <Section title="Current Active Model" style={{ marginTop: "20px" }}>
          <div style={s.modelCardActive}>
            <div style={s.modelHeader}>
              <div>
                <div style={s.modelName}>
                  <StatusDot status="active" size={10} />
                  {currentModel.name}
                  <span style={s.activeLabel}>Active</span>
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
              <span style={s.detailLabel}>Max Tokens</span>
              <span style={s.detailValue}>{currentModel.maxTokens.toLocaleString()}</span>
            </div>
            <div style={s.detailRow}>
              <span style={s.detailLabel}>Cost (Input)</span>
              <span style={s.detailValue}>${currentModel.costPer1k.input}/1k tokens</span>
            </div>
            <div style={s.detailRow}>
              <span style={s.detailLabel}>Cost (Output)</span>
              <span style={s.detailValue}>${currentModel.costPer1k.output}/1k tokens</span>
            </div>
            {testResults[currentModel.id] && (
              <div style={testResults[currentModel.id].success ? s.latencyResult : s.latencyError}>
                {testResults[currentModel.id].success
                  ? `Latency: ${testResults[currentModel.id].latencyMs}ms`
                  : "Test failed"}
              </div>
            )}
            <div style={s.actions}>
              <PrimaryButton onClick={() => handleTest(currentModel.id)} disabled={testingIds.has(currentModel.id)} small>
                {testingIds.has(currentModel.id) ? "Testing..." : "Test"}
              </PrimaryButton>
            </div>
          </div>
        </Section>
      )}

      {/* All Models */}
      <Section title="Available Models" style={{ marginTop: "24px" }}>
        {models.length === 0 ? (
          <EmptyState icon="" title="No models available" description="Add models to get started" />
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
                        {isActive && <span style={s.activeLabel}>Active</span>}
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
                    <span style={s.detailLabel}>Max Tokens</span>
                    <span style={s.detailValue}>{model.maxTokens.toLocaleString()}</span>
                  </div>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>Cost (In/Out)</span>
                    <span style={s.detailValue}>${model.costPer1k.input}/${model.costPer1k.output}</span>
                  </div>
                  {testResults[model.id] && (
                    <div style={testResults[model.id].success ? s.latencyResult : s.latencyError}>
                      {testResults[model.id].success
                        ? `Latency: ${testResults[model.id].latencyMs}ms`
                        : "Test failed"}
                    </div>
                  )}
                  <div style={s.actions}>
                    <PrimaryButton onClick={() => handleTest(model.id)} disabled={testingIds.has(model.id)} small>
                      {testingIds.has(model.id) ? "Testing..." : "Test"}
                    </PrimaryButton>
                    {!isActive && (
                      <SecondaryButton
                        onClick={() => handleSwitch(model.id)}
                        disabled={switchingId === model.id}
                        small
                      >
                        {switchingId === model.id ? "Switching..." : "Switch Model"}
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