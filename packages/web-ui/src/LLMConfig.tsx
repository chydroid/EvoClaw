import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "./i18n";
import {
  CHAT_PROVIDER_CATALOG,
  buildDefaultProviders,
  formatPrice,
  type ProviderCatalog,
  type ModelInfo,
} from "./model-catalog";

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
  catalog?: ProviderCatalog;
}

const BUILT_IN_IDS = new Set(CHAT_PROVIDER_CATALOG.map((p) => p.id));

const DEFAULT_PROVIDERS: LLMProvider[] = buildDefaultProviders();

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

interface ImageGenProvider {
  id: string;
  name: string;
  apiKey: string;
  hasApiKey?: boolean;
  baseURL: string;
  model: string;
  enabled: boolean;
  order: number;
}

interface VideoGenProvider {
  id: string;
  name: string;
  apiKey: string;
  hasApiKey?: boolean;
  baseURL: string;
  model: string;
  enabled: boolean;
  order: number;
}

const IMAGE_GEN_BUILT_IN_IDS = new Set([
  "pollinations",
  "fal",
  "openai",
  "stability",
  "local",
  "qwen-wanx",
  "zhipu-cogview",
  "baidu-ernie",
  "minimax-image",
  "doubao-image",
  "jimeng",
  "kling-image",
  "google",
  "ideogram",
  "recraft",
]);

const DEFAULT_IMAGE_GEN_PROVIDERS: ImageGenProvider[] = [
  {
    id: "pollinations",
    name: "Pollinations.ai (Free)",
    apiKey: "",
    baseURL: "https://image.pollinations.ai/prompt",
    model: "flux",
    enabled: true,
    order: 1,
  },
  {
    id: "fal",
    name: "Fal.ai",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/flux-2/klein/9b",
    enabled: false,
    order: 2,
  },
  {
    id: "openai",
    name: "OpenAI (DALL-E / GPT Image)",
    apiKey: "",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-image-2",
    enabled: false,
    order: 3,
  },
  {
    id: "google",
    name: "Google (Nano Banana / Imagen)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/nano-banana-2",
    enabled: false,
    order: 4,
  },
  {
    id: "jimeng",
    name: "即梦 (Jimeng / 字节)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/jimeng",
    enabled: false,
    order: 5,
  },
  {
    id: "doubao-image",
    name: "豆包图像 (Doubao / Seedream)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/seedream-5",
    enabled: false,
    order: 6,
  },
  {
    id: "qwen-wanx",
    name: "通义万相 (Wanx)",
    apiKey: "",
    baseURL: "https://dashscope.aliyuncs.com/api/v1",
    model: "wanx-v1",
    enabled: false,
    order: 7,
  },
  {
    id: "kling-image",
    name: "可灵图像 (Kling Image)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/kling/image-to-image",
    enabled: false,
    order: 8,
  },
  {
    id: "zhipu-cogview",
    name: "智谱CogView",
    apiKey: "",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "cogview-4",
    enabled: false,
    order: 9,
  },
  {
    id: "baidu-ernie",
    name: "百度文心一格",
    apiKey: "",
    baseURL: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1",
    model: "ernie-vilg-v2",
    enabled: false,
    order: 10,
  },
  {
    id: "minimax-image",
    name: "MiniMax 图片生成",
    apiKey: "",
    baseURL: "https://api.minimax.chat/v1",
    model: "image-01",
    enabled: false,
    order: 11,
  },
  {
    id: "ideogram",
    name: "Ideogram",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/ideogram/v3",
    enabled: false,
    order: 12,
  },
  {
    id: "recraft",
    name: "Recraft",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/recraft/v4/pro/text-to-image",
    enabled: false,
    order: 13,
  },
  {
    id: "custom",
    name: "Custom Provider",
    apiKey: "",
    baseURL: "",
    model: "",
    enabled: false,
    order: 14,
  },
];

const VIDEO_GEN_BUILT_IN_IDS = new Set([
  "fal",
  "replicate",
  "openai",
  "local",
  "kling",
  "qwen-wan-video",
  "minimax-video",
  "doubao-video",
  "luma",
  "vidu",
  "hailuo",
  "seedance",
  "google-veo",
]);

const DEFAULT_VIDEO_GEN_PROVIDERS: VideoGenProvider[] = [
  {
    id: "fal",
    name: "Fal.ai (Wan 2.2 Fast)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/wan/v2.2-5b/text-to-video/fast-wan",
    enabled: false,
    order: 1,
  },
  {
    id: "kling",
    name: "可灵视频 (Kling 3.0)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/kling-video/v3/standard/text-to-video",
    enabled: false,
    order: 2,
  },
  {
    id: "doubao-video",
    name: "豆包视频 (Seedance 2.0 / 字节)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "bytedance/seedance-2.0/text-to-video",
    enabled: false,
    order: 3,
  },
  {
    id: "qwen-wan-video",
    name: "通义万相视频 (Wan Video A14B)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/wan/v2.2-a14b/text-to-video",
    enabled: false,
    order: 4,
  },
  {
    id: "luma",
    name: "Luma Dream Machine",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/luma-dream-machine",
    enabled: false,
    order: 5,
  },
  {
    id: "vidu",
    name: "Vidu Q3",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/vidu/q3/text-to-video",
    enabled: false,
    order: 6,
  },
  {
    id: "hailuo",
    name: "海螺视频 (Hailuo 2.3)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/hailuo-video-2.3/text-to-video",
    enabled: false,
    order: 7,
  },
  {
    id: "seedance",
    name: "Seedance 1.5 Pro",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/seedance-1.5-pro/text-to-video",
    enabled: false,
    order: 8,
  },
  {
    id: "google-veo",
    name: "Google Veo 3.1",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/google/veo-3.1/fast/text-to-video",
    enabled: false,
    order: 9,
  },
  {
    id: "minimax-video",
    name: "MiniMax 视频生成",
    apiKey: "",
    baseURL: "https://api.minimax.chat/v1",
    model: "video-01",
    enabled: false,
    order: 10,
  },
  {
    id: "replicate",
    name: "Replicate",
    apiKey: "",
    baseURL: "https://api.replicate.com/v1",
    model: "lightricks/ltx-video",
    enabled: false,
    order: 11,
  },
  {
    id: "local",
    name: "Local FFmpeg",
    apiKey: "",
    baseURL: "",
    model: "ffmpeg-slideshow",
    enabled: true,
    order: 12,
  },
  {
    id: "custom",
    name: "Custom Provider",
    apiKey: "",
    baseURL: "",
    model: "",
    enabled: false,
    order: 13,
  },
];

function newCustomImageGenProvider(index: number): ImageGenProvider {
  const id = `custom-${Date.now()}-${index}`;
  return {
    id,
    name: `Custom Image Gen #${index}`,
    apiKey: "",
    baseURL: "",
    model: "",
    enabled: false,
    order: 100 + index,
  };
}

function newCustomVideoGenProvider(index: number): VideoGenProvider {
  const id = `custom-${Date.now()}-${index}`;
  return {
    id,
    name: `Custom Video Gen #${index}`,
    apiKey: "",
    baseURL: "",
    model: "",
    enabled: false,
    order: 100 + index,
  };
}

function LLMConfigPanel() {
  const [providers, setProviders] = useState<LLMProvider[]>(DEFAULT_PROVIDERS);
  const [activeProvider, setActiveProvider] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusIsSuccess, setStatusIsSuccess] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [customCount, setCustomCount] = useState(0);
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
          const loaded = (data.providers as LLMProvider[]).map((p) => {
            const catalog = CHAT_PROVIDER_CATALOG.find((c) => c.id === p.id);
            return catalog ? { ...p, catalog } : p;
          });
          setProviders(loaded);
          // Highlight the first (highest priority) provider from server data
          const sorted = [...loaded].sort((a, b) => a.order - b.order);
          setActiveProvider(sorted[0].id);
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
      const payload = providers.map(p =>
        p.apiKey === "****" ? { ...p, apiKey: undefined } : p
      );
      const res = await fetch("/api/config/llm", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: payload }),
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
                      {currentProvider.catalog && (
                        <span style={s.modelMeta}>
                          {(() => {
                            const m = currentProvider.catalog.models.find((x) => x.id === model);
                            if (!m) return null;
                            return (
                              <>
                                {formatPrice(m)}
                                {m.contextTokens ? ` · ${(m.contextTokens / 1000).toFixed(0)}K ctx` : ""}
                              </>
                            );
                          })()}
                        </span>
                      )}
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

interface MediaGenConfigProps {
  kind: "image" | "video";
}

function MediaGenConfig({ kind }: MediaGenConfigProps) {
  const isImage = kind === "image";
  const defaults = isImage ? DEFAULT_IMAGE_GEN_PROVIDERS : DEFAULT_VIDEO_GEN_PROVIDERS;
  const builtInIds = isImage ? IMAGE_GEN_BUILT_IN_IDS : VIDEO_GEN_BUILT_IN_IDS;
  const apiPath = isImage ? "/api/config/image-gen" : "/api/config/video-gen";
  const titleKey = isImage ? "llm.image_title" : "llm.video_title";
  const placeholderKey = isImage ? "llm.image_model_placeholder" : "llm.video_model_placeholder";
  const newCustomProviderFn = isImage ? newCustomImageGenProvider : newCustomVideoGenProvider;

  const [providers, setProviders] = useState<(ImageGenProvider | VideoGenProvider)[]>(defaults);
  const [activeProvider, setActiveProvider] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusIsSuccess, setStatusIsSuccess] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [customCount, setCustomCount] = useState(0);
  const dragging = useRef(false);
  const { t } = useTranslation();

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const res = await fetch(apiPath);
      if (res.ok) {
        const data = await res.json();
        if (data.providers && Array.isArray(data.providers) && data.providers.length > 0) {
          const loaded = data.providers as (ImageGenProvider | VideoGenProvider)[];
          setProviders(loaded);
          const sorted = [...loaded].sort((a, b) => a.order - b.order);
          setActiveProvider(sorted[0].id);
        }
      }
    } catch {
      console.debug(`[MediaGenConfig:${kind}] Server not reachable, using defaults`);
      const sorted = [...defaults].sort((a, b) => a.order - b.order);
      setActiveProvider(sorted[0].id);
    }
  }

  async function saveConfig() {
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch(apiPath, {
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

  function updateProvider(id: string, updates: Partial<ImageGenProvider | VideoGenProvider>) {
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates } : p))
    );
  }

  function addProvider() {
    const next = customCount + 1;
    setCustomCount(next);
    const newP = newCustomProviderFn(next);
    const newOrder = providers.length + 1;
    newP.order = newOrder;
    setProviders((prev) => [...prev, newP]);
    setActiveProvider(newP.id);
  }

  function deleteProvider(id: string) {
    if (builtInIds.has(id)) return;
    setProviders((prev) => {
      const remaining = prev.filter((p) => p.id !== id);
      const reordered = remaining.map((p, i) => ({ ...p, order: i + 1 }));
      return reordered;
    });
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
        <h2 style={s.title}>{t(titleKey)}</h2>
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
                  <div style={s.modelPreview}>{p.model || t("llm.no_model")}</div>
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
                    {!builtInIds.has(p.id) && (
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
                <label style={s.label}>{t("llm.model_field")}</label>
                <input
                  style={s.input}
                  value={currentProvider.model}
                  placeholder={t(placeholderKey)}
                  onChange={(e) => updateProvider(activeProvider, { model: e.target.value })}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ImageGenConfig() {
  return <MediaGenConfig kind="image" />;
}

function VideoGenConfig() {
  return <MediaGenConfig kind="video" />;
}

export default function LLMConfig() {
  const [activeTab, setActiveTab] = useState<"llm" | "image" | "video">("llm");
  const { t } = useTranslation();

  const tabs: Array<{ id: "llm" | "image" | "video"; label: string }> = [
    { id: "llm", label: t("llm.tab_llm") },
    { id: "image", label: t("llm.tab_image") },
    { id: "video", label: t("llm.tab_video") },
  ];

  return (
    <div style={s.tabContainer}>
      <div style={s.tabBar}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              ...s.tabBtn,
              background: activeTab === tab.id ? "var(--accent)" : "transparent",
              color: activeTab === tab.id ? "#fff" : "var(--text-secondary)",
              borderBottom: activeTab === tab.id ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={s.tabContent}>
        {activeTab === "llm" && <LLMConfigPanel />}
        {activeTab === "image" && <ImageGenConfig />}
        {activeTab === "video" && <VideoGenConfig />}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  tabContainer: {
    display: "flex", flexDirection: "column", height: "100%", overflow: "hidden",
  },
  tabBar: {
    display: "flex", gap: "0",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-sidebar)",
    flexShrink: 0,
  },
  tabBtn: {
    padding: "10px 20px",
    border: "none",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 500,
    transition: "all 0.2s",
  },
  tabContent: {
    flex: 1, overflow: "hidden", display: "flex", flexDirection: "column",
  },
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
  modelMeta: {
    fontSize: "10px",
    color: "var(--text-muted)",
    whiteSpace: "nowrap" as const,
    maxWidth: "140px",
    overflow: "hidden",
    textOverflow: "ellipsis",
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