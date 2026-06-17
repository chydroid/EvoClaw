import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "./i18n";

interface LLMProvider {
  id: string;
  name: string;
  apiKey: string;
  hasApiKey?: boolean;
  baseURL: string;
  models: string[];
  selectedModel: string;
  enabled: boolean;
  order: number;
  config: {
    temperature: number;
    maxTokens: number;
    timeout: number;
    topP: number;
  };
}

const BUILT_IN_IDS = new Set(["openai", "anthropic", "deepseek", "local"]);

const DEFAULT_PROVIDERS: LLMProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    apiKey: "",
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "o3", "o4-mini"],
    selectedModel: "gpt-4.1",
    enabled: false,
    order: 1,
    config: { temperature: 0.7, maxTokens: 40960, timeout: 60000, topP: 1 },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    apiKey: "",
    baseURL: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-6-20250217", "claude-opus-4-7-20260416", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20250301"],
    selectedModel: "claude-sonnet-4-6-20250217",
    enabled: false,
    order: 2,
    config: { temperature: 0.5, maxTokens: 40960, timeout: 60000, topP: 1 },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    apiKey: "",
    baseURL: "https://api.deepseek.com",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    selectedModel: "deepseek-v4-flash",
    enabled: false,
    order: 3,
    config: { temperature: 0.3, maxTokens: 40960, timeout: 60000, topP: 1 },
  },
  {
    id: "local",
    name: "Local Model (Ollama/vLLM)",
    apiKey: "",
    baseURL: "http://localhost:11434/v1",
    models: ["llama3", "mistral", "qwen2.5", "deepseek-r1", "custom"],
    selectedModel: "llama3",
    enabled: false,
    order: 4,
    config: { temperature: 0.5, maxTokens: 40960, timeout: 120000, topP: 0.9 },
  },
  {
    id: "custom",
    name: "Custom Provider",
    apiKey: "",
    baseURL: "",
    models: [],
    selectedModel: "",
    enabled: false,
    order: 5,
    config: { temperature: 0.5, maxTokens: 40960, timeout: 60000, topP: 1 },
  },
];

function newCustomProvider(index: number): LLMProvider {
  const id = `custom-${Date.now()}-${index}`;
  return {
    id,
    name: `Custom LLM #${index}`,
    apiKey: "",
    baseURL: "",
    models: [],
    selectedModel: "",
    enabled: false,
    order: 100 + index,
    config: { temperature: 0.5, maxTokens: 40960, timeout: 60000, topP: 1 },
  };
}

export default function LLMConfig() {
  const [providers, setProviders] = useState<LLMProvider[]>(DEFAULT_PROVIDERS);
  const [activeProvider, setActiveProvider] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusIsSuccess, setStatusIsSuccess] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [customCount, setCustomCount] = useState(0);
  const [localModelStatus, setLocalModelStatus] = useState<{ available: boolean; modelName: string | null; error: string | null } | null>(null);
  const dragging = useRef(false);
  const { t } = useTranslation();

  useEffect(() => {
    loadConfig();
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX;
      const newW = Math.max(180, Math.min(500, startW + delta));
      setSidebarWidth(newW);
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);

  async function loadConfig() {
    try {
      const res = await fetch("/api/config/llm");
      if (res.ok) {
        const data = await res.json();
        if (data.providers && Array.isArray(data.providers) && data.providers.length > 0) {
          const loaded = data.providers as LLMProvider[];
          setProviders(loaded);
          // Highlight the first (highest priority) provider from server data
          const sorted = [...loaded].sort((a, b) => a.order - b.order);
          setActiveProvider(sorted[0].id);
        }
        // Load local model status
        if (data.localModel) {
          setLocalModelStatus(data.localModel);
        }
      }
    } catch {
      console.debug("[LLMConfig] Server not reachable, using defaults");
      // Fallback: highlight first default provider
      const sorted = [...DEFAULT_PROVIDERS].sort((a, b) => a.order - b.order);
      setActiveProvider(sorted[0].id);
    }
  }

  async function saveConfig() {
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch("/api/config/llm", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers }),
      });
      if (res.ok) {
        setStatusMsg(t("llm.saved_ok"));
        setStatusIsSuccess(true);
      } else {
        setStatusMsg(t("llm.saved_fail"));
        setStatusIsSuccess(false);
      }
    } catch {
      setStatusMsg(t("llm.saved_local"));
      setStatusIsSuccess(false);
    }
    setSaving(false);
    setTimeout(() => setStatusMsg(null), 3000);
  }

  function updateProvider(id: string, updates: Partial<LLMProvider>) {
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates } : p))
    );
  }

  function updateConfig(id: string, updates: Partial<LLMProvider["config"]>) {
    setProviders((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, config: { ...p.config, ...updates } } : p
      )
    );
  }

  function addCustomModel(providerId: string) {
    const modelName = prompt(t("llm.enter_model_name"));
    if (modelName) {
      setProviders((prev) =>
        prev.map((p) =>
          p.id === providerId ? { ...p, models: [...p.models, modelName], selectedModel: p.selectedModel || modelName } : p
        )
      );
    }
  }

  function removeModel(providerId: string, modelName: string) {
    setProviders((prev) =>
      prev.map((p) => {
        if (p.id !== providerId) return p;
        const newModels = p.models.filter((m) => m !== modelName);
        return {
          ...p,
          models: newModels,
          selectedModel: p.selectedModel === modelName ? (newModels[0] || "") : p.selectedModel,
        };
      })
    );
  }

  function moveModel(providerId: string, modelName: string, direction: "up" | "down") {
    setProviders((prev) =>
      prev.map((p) => {
        if (p.id !== providerId) return p;
        const idx = p.models.indexOf(modelName);
        if (idx < 0) return p;
        if (direction === "up" && idx === 0) return p;
        if (direction === "down" && idx === p.models.length - 1) return p;
        const newModels = [...p.models];
        const swapIdx = direction === "up" ? idx - 1 : idx + 1;
        [newModels[idx], newModels[swapIdx]] = [newModels[swapIdx], newModels[idx]];
        // Keep the first model as selectedModel
        return { ...p, models: newModels, selectedModel: newModels[0] };
      })
    );
  }

  function setModelPriority(providerId: string, modelName: string, newIndex: number) {
    setProviders((prev) =>
      prev.map((p) => {
        if (p.id !== providerId) return p;
        const models = [...p.models];
        const oldIdx = models.indexOf(modelName);
        if (oldIdx < 0) return p;
        models.splice(oldIdx, 1);
        models.splice(newIndex, 0, modelName);
        return { ...p, models, selectedModel: models[0] };
      })
    );
  }

  function addProvider() {
    const next = customCount + 1;
    setCustomCount(next);
    const newP = newCustomProvider(next);
    const newOrder = providers.length + 1;
    newP.order = newOrder;
    setProviders((prev) => [...prev, newP]);
    setActiveProvider(newP.id);
  }

  function deleteProvider(id: string) {
    if (BUILT_IN_IDS.has(id)) return;
    setProviders((prev) => {
      const remaining = prev.filter((p) => p.id !== id);
      const reordered = remaining.map((p, i) => ({ ...p, order: i + 1 }));
      return reordered;
    });
    // Switch to the first provider after deletion
    setActiveProvider("");
  }

  function moveProvider(id: string, direction: "up" | "down") {
    setProviders((prev) => {
      const sorted = [...prev].sort((a, b) => a.order - b.order);
      const idx = sorted.findIndex((p) => p.id === id);
      if (idx < 0) return prev;
      if (direction === "up" && idx === 0) return prev;
      if (direction === "down" && idx === sorted.length - 1) return prev;

      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      const tmp = sorted[idx].order;
      sorted[idx].order = sorted[swapIdx].order;
      sorted[swapIdx].order = tmp;

      return [...sorted];
    });
  }

  const currentProvider = providers.find((p) => p.id === activeProvider);
  const sortedProviders = [...providers].sort((a, b) => a.order - b.order);

  return (
    <div style={s.container}>
      <div style={s.header}>
        <h2 style={s.title}>{t("llm.title")}</h2>
        {statusMsg && (
          <div style={{
            ...s.statusBanner,
            background: statusIsSuccess ? "var(--success-bg)" : "var(--error-bg)",
            color: statusIsSuccess ? "var(--success)" : "var(--error)",
          }}>
            {statusMsg}
          </div>
        )}
        <button style={s.saveBtn} onClick={saveConfig} disabled={saving}>
          {saving ? t("llm.saving") : t("llm.save_all")}
        </button>
      </div>

      {/* ── Local Model Status Banner ── */}
      {localModelStatus && localModelStatus.available ? (
        <div style={{
          margin: "0 20px 8px", padding: "8px 14px", borderRadius: "8px",
          background: "rgba(76,175,80,0.1)", border: "1px solid rgba(76,175,80,0.3)",
          fontSize: "12px", color: "var(--success)", display: "flex", alignItems: "center", gap: "8px",
        }}>
          <span style={{ fontSize: "16px" }}>&#9889;</span>
          <span>{t("llm.local_model_active", "本地模型已激活")}: {localModelStatus.modelName} — {t("llm.local_model_saving", "简单任务将使用本地模型，大幅节省Token")}</span>
        </div>
      ) : (
        <div style={{
          margin: "0 20px 8px", padding: "8px 14px", borderRadius: "8px",
          background: "rgba(255,152,0,0.08)", border: "1px solid rgba(255,152,0,0.25)",
          fontSize: "12px", color: "var(--text-muted)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
            <span style={{ fontSize: "14px" }}>&#128161;</span>
            <strong style={{ color: "var(--text-primary)" }}>{t("llm.local_model_tip_title", "省Token小贴士：下载本地轻量模型")}</strong>
          </div>
          <div style={{ lineHeight: "1.6" }}>
            {t("llm.local_model_tip_desc", "下载 Qwen3-0.6B (~1.2GB) 到本地后，简单对话、翻译、格式化等任务将自动使用本地模型，无需调用远程API，大幅节省Token费用。")}
          </div>
          <div style={{ marginTop: "6px", padding: "6px 10px", background: "var(--bg-primary)", borderRadius: "4px", fontSize: "11px", fontFamily: "monospace", whiteSpace: "pre-wrap", color: "var(--text-muted)" }}>
{`推荐模型：Qwen3-0.6B（标准架构，兼容性好）
  Qwen3-0.6B (~1.2GB) — 标准Attention，完全兼容
  Qwen3.5-0.8B (~700MB) — 混合架构，需onnxruntime-node

下载命令（在EvoClaw项目目录执行）：
  git lfs install

  # 推荐：Qwen3-0.6B
  git clone https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX local-model

国内镜像（huggingface.co无法访问时）：
  git clone https://hf-mirror.com/onnx-community/Qwen3-0.6B-ONNX local-model

下载完成后重启EvoClaw服务`}
          </div>
        </div>
      )}

      <div style={s.body}>
        <div style={{ ...s.sidebar, width: sidebarWidth }}>
          {sortedProviders.map((p) => (
            <div
              key={p.id}
              style={{
                ...s.sidebarItem,
                background: activeProvider === p.id ? "var(--accent-bg)" : "transparent",
                borderColor: activeProvider === p.id ? "var(--accent)" : "transparent",
              }}
              onClick={() => setActiveProvider(p.id)}
            >
              <div style={s.providerRow}>
                <span style={s.orderBadge}>{p.order}</span>
                <div style={{ flex: 1 as const }}>
                  <div style={s.providerName}>
                    <span style={{
                      ...s.enabledDot,
                      background: p.enabled ? "var(--success)" : "var(--text-muted)",
                    }} />
                    {p.name}
                  </div>
                  <div style={s.modelPreview}>{p.selectedModel || t("llm.no_model")}</div>
                </div>
                {sortedProviders.length > 1 && (
                  <div style={s.orderBtns} onClick={(e) => e.stopPropagation()}>
                    <button
                      style={{ ...s.orderBtn, opacity: sortedProviders[0]?.id === p.id ? 0.3 : 1 }}
                      disabled={sortedProviders[0]?.id === p.id}
                      onClick={() => moveProvider(p.id, "up")}
                      title={t("llm.move_up")}
                    >▲</button>
                    <button
                      style={{ ...s.orderBtn, opacity: sortedProviders[sortedProviders.length - 1]?.id === p.id ? 0.3 : 1 }}
                      disabled={sortedProviders[sortedProviders.length - 1]?.id === p.id}
                      onClick={() => moveProvider(p.id, "down")}
                      title={t("llm.move_down")}
                    >▼</button>
                    {!BUILT_IN_IDS.has(p.id) && (
                      <button
                        style={s.deleteBtn}
                        onClick={() => deleteProvider(p.id)}
                        title={t("llm.delete_provider")}
                      >✕</button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div style={s.addBtnWrap}>
            <button style={s.addProviderBtn} onClick={addProvider}>
              {t("llm.add_provider")}
            </button>
          </div>
        </div>

        <div style={s.resizeHandle} onMouseDown={onMouseDown} />

        <div style={s.content}>
          {currentProvider && (
            <div style={s.form}>
              <div style={s.formGroup}>
                <label style={s.label}>{t("llm.provider_name")}</label>
                <input
                  style={s.input}
                  value={currentProvider.name}
                  onChange={(e) => updateProvider(activeProvider, { name: e.target.value })}
                />
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>{t("llm.priority_order")}</label>
                <div style={s.orderDisplay}>
                  <span style={s.orderNum}>#{currentProvider.order}</span>
                  <span style={s.orderHint}>
                    {currentProvider.order === 1 ? t("llm.first_priority") :
                     t("llm.fallback_priority", `Fallback #${currentProvider.order}`).replace("{0}", String(currentProvider.order)).replace("{1}", String(currentProvider.order - 1))}
                  </span>
                </div>
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>{t("llm.enable_provider")}</label>
                <label style={s.toggle}>
                  <input
                    type="checkbox"
                    checked={currentProvider.enabled}
                    onChange={(e) => updateProvider(activeProvider, { enabled: e.target.checked })}
                    style={s.checkbox}
                  />
                  <span style={{
                    ...s.toggleTrack,
                    background: currentProvider.enabled ? "var(--accent)" : "#444",
                  }}>
                    <span style={{
                      ...s.toggleThumb,
                      marginLeft: currentProvider.enabled ? "20px" : "2px",
                    }} />
                  </span>
                </label>
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>{t("llm.api_key")}</label>
                <input
                  style={s.input}
                  type="password"
                  value={currentProvider.hasApiKey && currentProvider.apiKey.startsWith("${") ? "••••••••••" : currentProvider.apiKey}
                  placeholder="sk-..."
                  onChange={(e) => updateProvider(activeProvider, { apiKey: e.target.value, hasApiKey: !!e.target.value })}
                  onFocus={() => {
                    // Clear placeholder on focus so user can type a new key
                    if (currentProvider.hasApiKey && currentProvider.apiKey.startsWith("${")) {
                      updateProvider(activeProvider, { apiKey: "****" });
                    }
                  }}
                />
                {currentProvider.hasApiKey && (
                  <span style={{ fontSize: 11, color: "#4caf50", marginLeft: 4 }}>{t("llm.configured")}</span>
                )}
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>{t("llm.base_url")}</label>
                <input
                  style={s.input}
                  value={currentProvider.baseURL}
                  onChange={(e) => updateProvider(activeProvider, { baseURL: e.target.value })}
                />
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>
                  {t("llm.models_priority")}
                  <button style={s.addModelBtn} onClick={() => addCustomModel(activeProvider)}>
                    {t("llm.add_model")}
                  </button>
                </label>
                <div style={s.modelListContainer}>
                  {currentProvider.models.length === 0 && (
                    <div style={s.modelRow}>
                      <span style={s.modelPriorityBadge}>#1</span>
                      <input
                        style={{ ...s.input, flex: 1 as const, width: "auto" }}
                        value=""
                        placeholder={t("llm.model_name_placeholder")}
                        onChange={(e) => {
                          if (e.target.value.trim()) {
                            updateProvider(activeProvider, {
                              models: [e.target.value],
                              selectedModel: e.target.value,
                            });
                          }
                        }}
                      />
                    </div>
                  )}
                  {currentProvider.models.map((model, idx) => (
                    <div key={`${model}-${idx}`} style={s.modelRow}>
                      <span style={s.modelPriorityBadge}>#{idx + 1}</span>
                      <input
                        style={{ ...s.input, flex: 1 as const, width: "auto" }}
                        value={model}
                        onChange={(e) => {
                          const newModels = [...currentProvider.models];
                          newModels[idx] = e.target.value;
                          updateProvider(activeProvider, {
                            models: newModels,
                            selectedModel: idx === 0 ? e.target.value : currentProvider.selectedModel,
                          });
                        }}
                      />
                      <div style={s.modelActionBtns}>
                        <button
                          style={{ ...s.modelActionBtn, opacity: idx === 0 ? 0.3 : 1 }}
                          disabled={idx === 0}
                          onClick={() => moveModel(activeProvider, model, "up")}
                          title={t("llm.move_up")}
                        >▲</button>
                        <button
                          style={{ ...s.modelActionBtn, opacity: idx === currentProvider.models.length - 1 ? 0.3 : 1 }}
                          disabled={idx === currentProvider.models.length - 1}
                          onClick={() => moveModel(activeProvider, model, "down")}
                          title={t("llm.move_down")}
                        >▼</button>
                        <button
                          style={s.modelDeleteBtn}
                          onClick={() => removeModel(activeProvider, model)}
                          title={t("llm.remove_model")}
                        >✕</button>
                      </div>
                    </div>
                  ))}
                </div>
                {currentProvider.models.length > 1 && (
                  <div style={s.modelPriorityHint}>
                    {t("llm.model_priority_hint")}
                  </div>
                )}
              </div>

              <div style={s.divider} />

              <div style={s.formGroup}>
                <label style={s.label}>
                  {t("llm.temperature")}: {currentProvider.config.temperature.toFixed(1)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  style={s.slider}
                  value={currentProvider.config.temperature}
                  onChange={(e) => updateConfig(activeProvider, { temperature: parseFloat(e.target.value) })}
                />
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>
                  {t("llm.top_p")}: {currentProvider.config.topP.toFixed(1)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  style={s.slider}
                  value={currentProvider.config.topP}
                  onChange={(e) => updateConfig(activeProvider, { topP: parseFloat(e.target.value) })}
                />
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>{t("llm.max_tokens")}</label>
                <input
                  style={s.input}
                  type="number"
                  min={8192}
                  max={512000}
                  step={256}
                  value={currentProvider.config.maxTokens}
                  onChange={(e) => updateConfig(activeProvider, { maxTokens: parseInt(e.target.value) || 40960 })}
                />
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>{t("llm.timeout_ms")}</label>
                <input
                  style={s.input}
                  type="number"
                  min={5000}
                  max={300000}
                  step={1000}
                  value={currentProvider.config.timeout}
                  onChange={(e) => updateConfig(activeProvider, { timeout: parseInt(e.target.value) || 60000 })}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header: {
    display: "flex", alignItems: "center", gap: "12px",
    padding: "16px 20px 12px", borderBottom: "1px solid var(--border)",
  },
  title: { margin: 0, fontSize: "18px", color: "var(--section-title-color)", fontWeight: 600, flex: 1 as const },
  saveBtn: {
    padding: "8px 18px", borderRadius: "8px", border: "none",
    background: "var(--accent)", color: "#fff", cursor: "pointer", fontWeight: "bold", fontSize: "13px",
  },
  statusBanner: {
    padding: "6px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 500,
  },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  sidebar: {
    width: "260px", borderRight: "1px solid var(--border)",
    overflow: "auto", padding: "8px", flexShrink: 0,
    display: "flex", flexDirection: "column",
  },
  resizeHandle: {
    width: "4px", cursor: "col-resize", background: "transparent",
    flexShrink: 0, transition: "background 0.2s",
    userSelect: "none" as const,
    borderLeft: "1px solid var(--border)",
  },
  sidebarItem: {
    padding: "10px 12px", borderRadius: "8px", cursor: "pointer",
    border: "1px solid transparent", marginBottom: "4px",
    transition: "all 0.2s",
  },
  providerRow: {
    display: "flex", alignItems: "center", gap: "8px",
  },
  orderBadge: {
    width: "22px", height: "22px", borderRadius: "50%",
    background: "var(--accent-bg)", color: "var(--section-title-color)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "10px", fontWeight: "bold", flexShrink: 0,
    border: "1px solid var(--accent)",
  },
  providerName: {
    fontSize: "14px", fontWeight: "bold", color: "var(--text-primary)",
    display: "flex", alignItems: "center", gap: "8px",
  },
  enabledDot: {
    width: "8px", height: "8px", borderRadius: "50%", display: "inline-block",
  },
  modelPreview: { fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" },
  orderBtns: {
    display: "flex", flexDirection: "column", gap: "2px",
  },
  orderBtn: {
    padding: "0px 4px", fontSize: "8px", cursor: "pointer",
    background: "transparent", border: "1px solid var(--input-border)",
    borderRadius: "3px", color: "var(--text-secondary)", lineHeight: "14px",
  },
  deleteBtn: {
    padding: "0px 4px", fontSize: "8px", cursor: "pointer",
    background: "transparent", border: "1px solid #5a1a1a",
    borderRadius: "3px", color: "var(--error)", lineHeight: "14px",
    marginTop: "2px",
  },
  addBtnWrap: {
    marginTop: "auto", paddingTop: "8px",
    borderTop: "1px solid var(--border)",
  },
  addProviderBtn: {
    width: "100%", padding: "8px", borderRadius: "6px",
    background: "transparent", border: "1px dashed var(--accent)",
    color: "var(--accent)", cursor: "pointer", fontSize: "13px", fontWeight: "bold",
  },
  content: { flex: 1, minWidth: 0, overflow: "auto", padding: "20px" },
  form: { width: "100%", minWidth: 0 },
  formGroup: { marginBottom: "18px" },
  label: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    fontSize: "13px", fontWeight: "bold", color: "var(--text-primary)", marginBottom: "6px",
  },
  input: {
    width: "400px", padding: "8px 12px", borderRadius: "6px",
    border: "1px solid var(--input-border)", background: "var(--bg-sidebar)",
    color: "var(--text-primary)", fontSize: "14px",
    boxSizing: "border-box" as const,
  },
  orderDisplay: {
    display: "flex", alignItems: "center", gap: "10px",
  },
  orderNum: {
    fontSize: "20px", fontWeight: "bold", color: "var(--accent)",
    background: "var(--accent-bg)", padding: "4px 12px", borderRadius: "6px",
    border: "1px solid var(--accent)",
  },
  orderHint: {
    fontSize: "12px", color: "var(--text-secondary)",
  },
  slider: { width: "100%", accentColor: "var(--accent)" },
  divider: { height: "1px", background: "var(--border)", margin: "20px 0" },
  toggle: { display: "inline-flex", cursor: "pointer" },
  checkbox: { display: "none" },
  toggleTrack: {
    width: "40px", height: "20px", borderRadius: "10px",
    display: "inline-flex", alignItems: "center", transition: "background 0.2s",
  },
  toggleThumb: {
    width: "16px", height: "16px", borderRadius: "50%", background: "#fff",
    transition: "margin-left 0.2s",
  },
  addModelBtn: {
    padding: "2px 8px", borderRadius: "4px", border: "1px solid var(--accent)",
    background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: "11px",
  },
  modelListContainer: {
    display: "flex", flexDirection: "column", gap: "6px",
    marginTop: "4px",
  },
  modelRow: {
    display: "flex", alignItems: "center", gap: "6px",
  },
  modelPriorityBadge: {
    width: "28px", height: "28px", borderRadius: "6px",
    background: "var(--accent-bg)", color: "var(--accent)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "11px", fontWeight: "bold", flexShrink: 0,
    border: "1px solid var(--accent)",
  },
  modelActionBtns: {
    display: "flex", flexDirection: "column", gap: "2px",
  },
  modelActionBtn: {
    padding: "0px 6px", fontSize: "10px", cursor: "pointer",
    background: "transparent", border: "1px solid var(--input-border)",
    borderRadius: "3px", color: "var(--text-secondary)", lineHeight: "16px",
  },
  modelDeleteBtn: {
    padding: "0px 6px", fontSize: "10px", cursor: "pointer",
    background: "transparent", border: "1px solid #5a1a1a",
    borderRadius: "3px", color: "var(--error)", lineHeight: "16px",
  },
  modelEmptyHint: {
    padding: "10px 12px", color: "var(--text-muted)", fontSize: "12px",
    fontStyle: "italic", textAlign: "center" as const,
    border: "1px dashed var(--border)", borderRadius: "6px",
  },
  modelPriorityHint: {
    marginTop: "8px", padding: "8px 12px",
    background: "var(--accent-bg)", borderRadius: "6px",
    fontSize: "11px", color: "var(--text-secondary)",
    border: "1px solid var(--accent)",
    lineHeight: "1.5",
  },
};