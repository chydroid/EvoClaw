/**
 * FeatureFlagsPage — Toggle and manage application features.
 *
 * Card-based layout with search, toggle switches, and evaluation testing.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, GhostButton, Toggle, TextInput, Modal, showToast,
} from "./shared";
import { featureFlagsApi } from "./api-client";
import type { FeatureFlag } from "./api-client";

export default function FeatureFlagsPage() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  // Evaluation popover
  const [evalFlag, setEvalFlag] = useState<FeatureFlag | null>(null);
  const [evalResult, setEvalResult] = useState<{ enabled: boolean; reason: string } | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await featureFlagsApi.list();
      setFlags(res.flags);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load feature flags");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (key: string, enabled: boolean) => {
    try {
      await featureFlagsApi.set(key, enabled);
      setFlags((prev) =>
        prev.map((f) => (f.key === key ? { ...f, enabled } : f)),
      );
      showToast(`Flag "${key}" ${enabled ? "enabled" : "disabled"}`, "success");
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Toggle failed", "error");
      load();
    }
  };

  const handleEvaluate = async (flag: FeatureFlag) => {
    setEvalFlag(flag);
    setEvalResult(null);
    setEvalLoading(true);
    try {
      const res = await featureFlagsApi.evaluate(flag.key);
      setEvalResult(res);
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Evaluation failed", "error");
    } finally {
      setEvalLoading(false);
    }
  };

  const filteredFlags = flags.filter(
    (f) =>
      f.key.toLowerCase().includes(search.toLowerCase()) ||
      f.name.toLowerCase().includes(search.toLowerCase()) ||
      (f.description || "").toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div style={{ padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-primary)", boxSizing: "border-box" }}>
      <PageHeader
        title="Feature Flags"
        subtitle="Toggle and manage application features"
      />

      {error && <ErrorBanner message={error} onRetry={load} />}

      <div style={{ marginBottom: "16px", maxWidth: "400px" }}>
        <TextInput
          value={search}
          onChange={setSearch}
          placeholder="Search feature flags..."
        />
      </div>

      {loading ? (
        <Loading text="Loading feature flags..." />
      ) : filteredFlags.length === 0 ? (
        <EmptyState
          title={search ? "No matching flags" : "No feature flags found"}
          description={search ? "Try a different search term." : "Feature flags will appear here when configured."}
        />
      ) : (
        <Section title={`Flags (${filteredFlags.length})`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: "12px" }}>
            {filteredFlags.map((flag) => (
              <Card key={flag.key}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                  <div>
                    <code style={{ fontSize: "13px", fontWeight: 700, color: "var(--accent)", fontFamily: "Consolas, Monaco, monospace" }}>
                      {flag.key}
                    </code>
                    <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginTop: "4px" }}>
                      {flag.name}
                    </div>
                  </div>
                  <Toggle
                    checked={flag.enabled}
                    onChange={(v) => handleToggle(flag.key, v)}
                  />
                </div>
                {flag.description && (
                  <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "12px", lineHeight: "1.5" }}>
                    {flag.description}
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    Updated: {new Date(flag.updatedAt).toLocaleDateString()}
                  </span>
                  <GhostButton small onClick={() => handleEvaluate(flag)}>Evaluate</GhostButton>
                </div>
              </Card>
            ))}
          </div>
        </Section>
      )}

      {/* Evaluation Modal */}
      {evalFlag && (
        <Modal
          title={`Evaluate: ${evalFlag.key}`}
          onClose={() => { setEvalFlag(null); setEvalResult(null); }}
          footer={<GhostButton onClick={() => { setEvalFlag(null); setEvalResult(null); }}>Close</GhostButton>}
          width={440}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "4px" }}>Flag</div>
              <div style={{ fontSize: "14px", color: "var(--text-primary)", fontWeight: 600 }}>{evalFlag.name}</div>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>{evalFlag.description}</div>
            </div>
            {evalLoading ? (
              <Loading text="Evaluating..." />
            ) : evalResult ? (
              <div style={{
                padding: "14px", borderRadius: "8px",
                background: evalResult.enabled ? "var(--success-bg)" : "var(--error-bg)",
                border: `1px solid ${evalResult.enabled ? "var(--success)" : "var(--error)"}40`,
              }}>
                <div style={{ fontSize: "16px", fontWeight: 700, color: evalResult.enabled ? "var(--success)" : "var(--error)", marginBottom: "6px" }}>
                  {evalResult.enabled ? "✓ Enabled" : "✗ Disabled"}
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  {evalResult.reason}
                </div>
              </div>
            ) : null}
          </div>
        </Modal>
      )}
    </div>
  );
}