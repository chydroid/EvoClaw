import React, { useState, useEffect, useRef, useCallback } from "react";

interface LLMProvider {
  id: string;
  name: string;
  apiKey: string;
  baseURL: string;
  models: string[];
  selectedModel: string;
  enabled: boolean;
  config: {
    temperature: number;
    maxTokens: number;
    timeout: number;
    topP: number;
  };
}

const DEFAULT_PROVIDERS: LLMProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    apiKey: "",
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
    selectedModel: "gpt-4o",
    enabled: false,
    config: { temperature: 0.7, maxTokens: 4096, timeout: 60000, topP: 1 },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    apiKey: "",
    baseURL: "https://api.anthropic.com/v1",
    models: ["claude-3-opus", "claude-3-sonnet", "claude-3-haiku"],
    selectedModel: "claude-3-sonnet",
    enabled: false,
    config: { temperature: 0.5, maxTokens: 4096, timeout: 60000, topP: 1 },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    apiKey: "",
    baseURL: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-coder"],
    selectedModel: "deepseek-chat",
    enabled: false,
    config: { temperature: 0.3, maxTokens: 4096, timeout: 60000, topP: 1 },
  },
  {
    id: "local",
    name: "Local Model (Ollama/vLLM)",
    apiKey: "",
    baseURL: "http://localhost:11434/v1",
    models: ["llama3", "mistral", "qwen2", "custom"],
    selectedModel: "llama3",
    enabled: false,
    config: { temperature: 0.5, maxTokens: 2048, timeout: 120000, topP: 0.9 },
  },
  {
    id: "custom",
    name: "Custom Provider",
    apiKey: "",
    baseURL: "",
    models: [],
    selectedModel: "",
    enabled: false,
    config: { temperature: 0.5, maxTokens: 4096, timeout: 60000, topP: 1 },
  },
];

export default function LLMConfig() {
  const [providers, setProviders] = useState<LLMProvider[]>(DEFAULT_PROVIDERS);
  const [activeProvider, setActiveProvider] = useState<string>("openai");
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const dragging = useRef(false);

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
        if (data.providers) {
          setProviders((data.providers as LLMProvider[]));
        }
      }
    } catch {
      console.debug("[LLMConfig] Server not reachable, using defaults");
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
        setStatusMsg("Settings saved successfully");
      } else {
        setStatusMsg("Failed to save settings");
      }
    } catch {
      setStatusMsg("Server not reachable - config saved locally only");
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
    const modelName = prompt("Enter model name:");
    if (modelName) {
      setProviders((prev) =>
        prev.map((p) =>
          p.id === providerId ? { ...p, models: [...p.models, modelName] } : p
        )
      );
    }
  }

  const currentProvider = providers.find((p) => p.id === activeProvider);

  return (
    <div style={s.container}>
      <div style={s.header}>
        <h2 style={s.title}>LLM Configuration</h2>
        <button style={s.saveBtn} onClick={saveConfig} disabled={saving}>
          {saving ? "Saving..." : "Save All"}
        </button>
        {statusMsg && (
          <div style={{
            ...s.statusBanner,
            background: statusMsg.includes("success") ? "#064e3b" : "#4a1515",
            color: statusMsg.includes("success") ? "#34d399" : "#f87171",
          }}>
            {statusMsg}
          </div>
        )}
      </div>

      <div style={s.body}>
        <div style={{ ...s.sidebar, width: sidebarWidth }}>
          {providers.map((p) => (
            <div
              key={p.id}
              style={{
                ...s.sidebarItem,
                background: activeProvider === p.id ? "#2d1b4e" : "transparent",
                borderColor: activeProvider === p.id ? "#7c3aed" : "transparent",
              }}
              onClick={() => setActiveProvider(p.id)}
            >
              <div style={s.providerName}>
                <span style={{
                  ...s.enabledDot,
                  background: p.enabled ? "#22c55e" : "#555",
                }} />
                {p.name}
              </div>
              <div style={s.modelPreview}>{p.selectedModel || "No model"}</div>
            </div>
          ))}
        </div>

        <div style={s.resizeHandle} onMouseDown={onMouseDown} />

        <div style={s.content}>
          {currentProvider && (
            <div style={s.form}>
              <div style={s.formGroup}>
                <label style={s.label}>Provider Name</label>
                <input
                  style={s.input}
                  value={currentProvider.name}
                  onChange={(e) => updateProvider(activeProvider, { name: e.target.value })}
                />
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>Enable Provider</label>
                <label style={s.toggle}>
                  <input
                    type="checkbox"
                    checked={currentProvider.enabled}
                    onChange={(e) => updateProvider(activeProvider, { enabled: e.target.checked })}
                    style={s.checkbox}
                  />
                  <span style={{
                    ...s.toggleTrack,
                    background: currentProvider.enabled ? "#7c3aed" : "#444",
                  }}>
                    <span style={{
                      ...s.toggleThumb,
                      marginLeft: currentProvider.enabled ? "20px" : "2px",
                    }} />
                  </span>
                </label>
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>API Key</label>
                <input
                  style={s.input}
                  type="password"
                  value={currentProvider.apiKey}
                  placeholder="sk-..."
                  onChange={(e) => updateProvider(activeProvider, { apiKey: e.target.value })}
                />
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>Base URL</label>
                <input
                  style={s.input}
                  value={currentProvider.baseURL}
                  onChange={(e) => updateProvider(activeProvider, { baseURL: e.target.value })}
                />
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>
                  Model
                  {currentProvider.id === "custom" && (
                    <button style={s.addModelBtn} onClick={() => addCustomModel(activeProvider)}>
                      + Add
                    </button>
                  )}
                </label>
                <select
                  style={s.select}
                  value={currentProvider.selectedModel}
                  onChange={(e) => updateProvider(activeProvider, { selectedModel: e.target.value })}
                >
                  <option value="">Select model...</option>
                  {currentProvider.models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                {currentProvider.id === "custom" && currentProvider.selectedModel && (
                  <div style={s.hint}>Or type a custom model name below:</div>
                )}
                {currentProvider.id === "custom" && (
                  <input
                    style={s.input}
                    value={currentProvider.selectedModel}
                    placeholder="Enter custom model name"
                    onChange={(e) => updateProvider(activeProvider, { selectedModel: e.target.value })}
                  />
                )}
              </div>

              <div style={s.divider} />

              <div style={s.formGroup}>
                <label style={s.label}>
                  Temperature: {currentProvider.config.temperature.toFixed(1)}
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
                  Top P: {currentProvider.config.topP.toFixed(1)}
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
                <label style={s.label}>Max Tokens</label>
                <input
                  style={s.input}
                  type="number"
                  min={256}
                  max={128000}
                  step={256}
                  value={currentProvider.config.maxTokens}
                  onChange={(e) => updateConfig(activeProvider, { maxTokens: parseInt(e.target.value) || 4096 })}
                />
              </div>

              <div style={s.formGroup}>
                <label style={s.label}>Timeout (ms)</label>
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
    padding: "16px 20px 12px", borderBottom: "1px solid #2a2a3a",
  },
  title: { margin: 0, fontSize: "18px", color: "#a78bfa", fontWeight: 600, flex: 1 as const },
  saveBtn: {
    padding: "8px 18px", borderRadius: "8px", border: "none",
    background: "#7c3aed", color: "#fff", cursor: "pointer", fontWeight: "bold", fontSize: "13px",
  },
  statusBanner: {
    padding: "6px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 500,
  },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  sidebar: {
    width: "260px", borderRight: "1px solid #2a2a3a",
    overflow: "auto", padding: "8px", flexShrink: 0,
  },
  resizeHandle: {
    width: "4px", cursor: "col-resize", background: "transparent",
    flexShrink: 0, transition: "background 0.2s",
    userSelect: "none" as const,
    borderLeft: "1px solid #2a2a3a",
  },
  sidebarItem: {
    padding: "12px", borderRadius: "8px", cursor: "pointer",
    border: "1px solid transparent", marginBottom: "4px",
    transition: "all 0.2s",
  },
  providerName: {
    fontSize: "14px", fontWeight: "bold", color: "#e0e0e0",
    display: "flex", alignItems: "center", gap: "8px",
  },
  enabledDot: {
    width: "8px", height: "8px", borderRadius: "50%", display: "inline-block",
  },
  modelPreview: { fontSize: "11px", color: "#888", marginTop: "4px" },
  content: { flex: 1, overflow: "auto", padding: "20px" },
  form: { maxWidth: "560px" },
  formGroup: { marginBottom: "18px" },
  label: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    fontSize: "13px", fontWeight: "bold", color: "#ccc", marginBottom: "6px",
  },
  input: {
    width: "100%", padding: "8px 12px", borderRadius: "6px",
    border: "1px solid #3a3a4a", background: "#1a1a2e",
    color: "#e0e0e0", fontSize: "14px",
    boxSizing: "border-box" as const,
  },
  select: {
    width: "100%", padding: "8px 12px", borderRadius: "6px",
    border: "1px solid #3a3a4a", background: "#1a1a2e",
    color: "#e0e0e0", fontSize: "14px",
  },
  slider: { width: "100%", accentColor: "#7c3aed" },
  divider: { height: "1px", background: "#2a2a3a", margin: "20px 0" },
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
  hint: { fontSize: "11px", color: "#666", marginTop: "4px", marginBottom: "6px" },
  addModelBtn: {
    padding: "2px 8px", borderRadius: "4px", border: "1px solid #7c3aed",
    background: "transparent", color: "#7c3aed", cursor: "pointer", fontSize: "11px",
  },
};