/**
 * FeatureFlagsPage — Toggle and manage application features.
 *
 * Card-based layout with search, toggle switches, evaluation testing,
 * and statistics summary.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Card, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, GhostButton, Toggle, TextInput, Modal, showToast,
} from "./shared";
import { featureFlagsApi } from "./api-client";
import type { FeatureFlag } from "./api-client";
import { useTranslation } from "./i18n";

const OWNER_COLORS: Record<string, string> = {
  core: "#6366f1",
  security: "#ef4444",
  integration: "#f59e0b",
  canvas: "#8b5cf6",
  skills: "#10b981",
  optimization: "#3b82f6",
  devops: "#06b6d4",
  memory: "#ec4899",
  browser: "#f97316",
  scheduler: "#14b8a6",
};

export default function FeatureFlagsPage() {
  const { t } = useTranslation();
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filterOwner, setFilterOwner] = useState<string>("all");

  const [evalFlag, setEvalFlag] = useState<FeatureFlag | null>(null);
  const [evalResult, setEvalResult] = useState<{ enabled: boolean; reason: string } | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await featureFlagsApi.list();
      setFlags(res.flags);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "加载功能开关失败");
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
      showToast(`开关 "${key}" ${enabled ? "已启用" : "已禁用"}`, "success");
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "切换失败", "error");
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
      showToast(err instanceof Error ? err.message : "评估失败", "error");
    } finally {
      setEvalLoading(false);
    }
  };

  // Collect unique owners for filter
  const owners = Array.from(new Set(flags.map(f => f.owner).filter(Boolean) as string[])).sort();

  const filteredFlags = flags.filter(
    (f) => {
      const matchesSearch =
        f.key.toLowerCase().includes(search.toLowerCase()) ||
        f.name.toLowerCase().includes(search.toLowerCase()) ||
        (f.description || "").toLowerCase().includes(search.toLowerCase());
      const matchesOwner = filterOwner === "all" || f.owner === filterOwner;
      return matchesSearch && matchesOwner;
    },
  );

  const enabledCount = flags.filter(f => f.enabled).length;
  const disabledCount = flags.length - enabledCount;

  return (
    <div style={{ padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-primary)", boxSizing: "border-box" }}>
      <PageHeader
        title={t("feature_flags.title")}
        subtitle={t("feature_flags.subtitle")}
      />

      {error && <ErrorBanner message={error} onRetry={load} />}

      {/* Stats summary */}
      {!loading && flags.length > 0 && (
        <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
          <div style={{ padding: "10px 16px", borderRadius: "8px", background: "var(--bg-secondary)", border: "1px solid var(--border)", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-primary)" }}>{flags.length}</span>
            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>总开关</span>
          </div>
          <div style={{ padding: "10px 16px", borderRadius: "8px", background: "var(--success-bg)", border: "1px solid var(--success)40", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "20px", fontWeight: 700, color: "var(--success)" }}>{enabledCount}</span>
            <span style={{ fontSize: "12px", color: "var(--success)" }}>已启用</span>
          </div>
          <div style={{ padding: "10px 16px", borderRadius: "8px", background: "var(--error-bg)", border: "1px solid var(--error)40", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "20px", fontWeight: 700, color: "var(--error)" }}>{disabledCount}</span>
            <span style={{ fontSize: "12px", color: "var(--error)" }}>已禁用</span>
          </div>
        </div>
      )}

      {/* Search + Owner filter */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ maxWidth: "400px", flex: "1 1 200px" }}>
          <TextInput
            value={search}
            onChange={setSearch}
            placeholder="搜索功能开关..."
          />
        </div>
        {owners.length > 1 && (
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <button
              onClick={() => setFilterOwner("all")}
              style={{
                padding: "4px 10px", borderRadius: "12px", border: "1px solid var(--border)",
                background: filterOwner === "all" ? "var(--accent)" : "var(--bg-secondary)",
                color: filterOwner === "all" ? "#fff" : "var(--text-secondary)",
                fontSize: "11px", cursor: "pointer", fontWeight: 600,
              }}
            >全部</button>
            {owners.map(owner => (
              <button
                key={owner}
                onClick={() => setFilterOwner(owner)}
                style={{
                  padding: "4px 10px", borderRadius: "12px", border: `1px solid ${OWNER_COLORS[owner] || "var(--border)"}40`,
                  background: filterOwner === owner ? (OWNER_COLORS[owner] || "var(--accent)") : "var(--bg-secondary)",
                  color: filterOwner === owner ? "#fff" : "var(--text-secondary)",
                  fontSize: "11px", cursor: "pointer", fontWeight: 600,
                }}
              >{owner}</button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <Loading text={t("app.loading")} />
      ) : filteredFlags.length === 0 ? (
        <EmptyState
          title={search ? "无匹配的开关" : t("feature_flags.no_flags")}
          description={search ? "尝试不同的搜索词" : "配置功能开关后将在此显示"}
        />
      ) : (
        <Section title={`功能开关 (${filteredFlags.length})`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: "12px" }}>
            {filteredFlags.map((flag) => (
              <Card key={flag.key}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                      <code style={{ fontSize: "13px", fontWeight: 700, color: "var(--accent)", fontFamily: "Consolas, Monaco, monospace" }}>
                        {flag.key}
                      </code>
                      {flag.owner && (
                        <span style={{
                          fontSize: "10px", fontWeight: 600, padding: "1px 6px", borderRadius: "8px",
                          background: `${OWNER_COLORS[flag.owner] || "var(--text-muted)"}20`,
                          color: OWNER_COLORS[flag.owner] || "var(--text-muted)",
                          border: `1px solid ${OWNER_COLORS[flag.owner] || "var(--text-muted)"}40`,
                        }}>{flag.owner}</span>
                      )}
                      {flag.rolloutPercent !== undefined && flag.rolloutPercent !== null && (
                        <span style={{
                          fontSize: "10px", fontWeight: 600, padding: "1px 6px", borderRadius: "8px",
                          background: "rgba(245,158,11,0.15)", color: "#f59e0b",
                          border: "1px solid rgba(245,158,11,0.3)",
                        }}>{flag.rolloutPercent}%</span>
                      )}
                    </div>
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
                {flag.environments && flag.environments.length > 0 && (
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "8px" }}>
                    环境: {flag.environments.join(", ")}
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    更新: {new Date(flag.updatedAt).toLocaleDateString()}
                  </span>
                  <GhostButton small onClick={() => handleEvaluate(flag)}>{t("feature_flags.evaluate")}</GhostButton>
                </div>
              </Card>
            ))}
          </div>
        </Section>
      )}

      {evalFlag && (
        <Modal
          title={`评估: ${evalFlag.key}`}
          onClose={() => { setEvalFlag(null); setEvalResult(null); }}
          footer={<GhostButton onClick={() => { setEvalFlag(null); setEvalResult(null); }}>关闭</GhostButton>}
          width={440}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "4px" }}>开关</div>
              <div style={{ fontSize: "14px", color: "var(--text-primary)", fontWeight: 600 }}>{evalFlag.name}</div>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>{evalFlag.description}</div>
            </div>
            {evalLoading ? (
              <Loading text="评估中..." />
            ) : evalResult ? (
              <div style={{
                padding: "14px", borderRadius: "8px",
                background: evalResult.enabled ? "var(--success-bg)" : "var(--error-bg)",
                border: `1px solid ${evalResult.enabled ? "var(--success)" : "var(--error)"}40`,
              }}>
                <div style={{ fontSize: "16px", fontWeight: 700, color: evalResult.enabled ? "var(--success)" : "var(--error)", marginBottom: "6px" }}>
                  {evalResult.enabled ? "✓ 已启用" : "✗ 已禁用"}
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
