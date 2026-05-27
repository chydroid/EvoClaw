/**
 * PluginsPage — Plugin management interface.
 *
 * Shows registered plugins, their hooks, status, and allows
 * install / uninstall / enable / disable operations.
 */

import React, { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "./i18n";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  status: "active" | "disabled" | "error";
  error?: string;
  hookCount: number;
  hooks: Array<{ type: string; priority: string }>;
  installedAt: string;
}

interface AvailablePlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  downloads: number;
  rating: number;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  padding: "20px",
  color: "var(--text-primary, #c9d1d9)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "20px",
};

const titleStyle: CSSProperties = {
  fontSize: "20px",
  fontWeight: 700,
  color: "var(--text-primary, #c9d1d9)",
};

const searchInputStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: "6px",
  border: "1px solid var(--border, #30363d)",
  background: "var(--bg-secondary, #161b22)",
  color: "var(--text-primary, #c9d1d9)",
  fontSize: "13px",
  width: "240px",
  outline: "none",
};

const tabBarStyle: CSSProperties = {
  display: "flex",
  gap: "2px",
  marginBottom: "20px",
  borderBottom: "1px solid var(--border, #30363d)",
};

const tabStyle = (active: boolean): CSSProperties => ({
  padding: "8px 16px",
  border: "none",
  borderBottom: active ? "2px solid var(--accent, #58a6ff)" : "2px solid transparent",
  background: "none",
  color: active ? "var(--accent, #58a6ff)" : "var(--text-secondary, #8b949e)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: active ? 600 : 400,
});

const cardGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
  gap: "12px",
};

const pluginCardStyle: CSSProperties = {
  padding: "16px",
  borderRadius: "8px",
  border: "1px solid var(--border, #30363d)",
  background: "var(--bg-secondary, #161b22)",
};

const pluginHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
};

const statusBadgeStyle = (status: string): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  padding: "2px 8px",
  borderRadius: "10px",
  fontSize: "11px",
  fontWeight: 600,
  background: status === "active" ? "rgba(46,160,67,0.15)" : status === "error" ? "rgba(248,81,73,0.15)" : "rgba(139,148,158,0.15)",
  color: status === "active" ? "#3fb950" : status === "error" ? "#f85149" : "#8b949e",
});

const hookChipStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "4px",
  fontSize: "11px",
  background: "rgba(88,166,255,0.1)",
  color: "var(--accent, #58a6ff)",
  marginRight: "4px",
  marginBottom: "4px",
  fontFamily: "monospace",
};

const actionBtnStyle = (variant: "primary" | "danger" | "default"): CSSProperties => ({
  padding: "4px 12px",
  borderRadius: "4px",
  border: "1px solid",
  borderColor: variant === "danger" ? "#f85149" : variant === "primary" ? "var(--accent, #58a6ff)" : "var(--border, #30363d)",
  background: variant === "danger" ? "rgba(248,81,73,0.1)" : variant === "primary" ? "var(--accent, #58a6ff)" : "transparent",
  color: variant === "primary" ? "#fff" : "var(--text-primary, #c9d1d9)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 500,
});

const installFormStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  marginBottom: "16px",
  alignItems: "center",
};

const installInputStyle: CSSProperties = {
  flex: 1,
  padding: "8px 14px",
  borderRadius: "6px",
  border: "1px solid var(--border, #30363d)",
  background: "var(--bg-secondary, #161b22)",
  color: "var(--text-primary, #c9d1d9)",
  fontSize: "13px",
  outline: "none",
};

const statsRowStyle: CSSProperties = {
  display: "flex",
  gap: "16px",
  marginBottom: "20px",
};

const statCardStyle: CSSProperties = {
  flex: 1,
  padding: "16px",
  borderRadius: "8px",
  border: "1px solid var(--border, #30363d)",
  background: "var(--bg-secondary, #161b22)",
  textAlign: "center",
};

// ─── Available Plugins (community registry) ─────────────────────────────────

const MOCK_AVAILABLE: AvailablePlugin[] = [
  { id: "discord-connector", name: "Discord Connector", version: "0.8.0", description: "Discord channel integration with slash commands", author: "community", downloads: 1230, rating: 4.5 },
  { id: "slack-connector", name: "Slack Connector", version: "0.7.0", description: "Slack workspace integration with threaded replies", author: "community", downloads: 980, rating: 4.2 },
  { id: "voice-synthesis", name: "Voice Synthesis", version: "1.0.0", description: "Text-to-speech with ElevenLabs and system TTS fallback", author: "evoclaw", downloads: 2500, rating: 4.8 },
  { id: "canvas-renderer", name: "Canvas Renderer", version: "0.6.0", description: "Live canvas with A2UI support for visual output", author: "evoclaw", downloads: 870, rating: 4.0 },
  { id: "cron-enhancer", name: "Cron Enhancer", version: "0.5.0", description: "Enhanced cron scheduling with natural language time expressions", author: "community", downloads: 540, rating: 4.3 },
  { id: "sentiment-analyzer", name: "Sentiment Analyzer", version: "0.3.0", description: "Analyze user sentiment and adjust tone accordingly", author: "community", downloads: 320, rating: 3.8 },
];

// ─── Component ────────────────────────────────────────────────────────────────

export function PluginsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<"installed" | "available">("installed");
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [search, setSearch] = useState("");
  const [installId, setInstallId] = useState("");
  const [showInstall, setShowInstall] = useState(false);
  const [message, setMessage] = useState("");

  const loadPlugins = useCallback(async () => {
    try {
      const res = await fetch("/api/plugins");
      if (res.ok) {
        const data = await res.json();
        const apiPlugins = (data.plugins || []).map((p: any) => ({
          id: p.manifest?.name?.toLowerCase().replace(/\s+/g, "-") || "unknown",
          name: p.manifest?.name || "Unknown",
          version: p.manifest?.version || "0.0.0",
          description: p.manifest?.description || "",
          author: p.manifest?.author,
          status: p.status || "active",
          error: p.error,
          hookCount: 0,
          hooks: [],
          installedAt: new Date().toISOString().split("T")[0],
        }));
        setPlugins(apiPlugins);
      }
    } catch {
      // API not available
    }
  }, []);

  useEffect(() => {
    loadPlugins();
    const interval = setInterval(loadPlugins, 15000);
    return () => clearInterval(interval);
  }, [loadPlugins]);

  const togglePlugin = async (id: string) => {
    const plugin = plugins.find((p) => p.id === id);
    if (!plugin) return;
    const newStatus = plugin.status === "active" ? "disabled" : "active";
    try {
      await fetch(`/api/plugins/${encodeURIComponent(plugin.name)}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      loadPlugins();
    } catch {
      setMessage(t("plugins.toggle_fail"));
      setTimeout(() => setMessage(""), 3000);
    }
  };

  const uninstallPlugin = async (id: string) => {
    const plugin = plugins.find((p) => p.id === id);
    if (!plugin) return;
    try {
      await fetch(`/api/plugins/${encodeURIComponent(plugin.name)}`, { method: "DELETE" });
      loadPlugins();
    } catch {
      setMessage(t("plugins.remove_fail"));
      setTimeout(() => setMessage(""), 3000);
    }
  };

  const handleInstall = async () => {
    if (!installId.trim()) return;
    try {
      const res = await fetch("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: installId }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage(data.message || t("plugins.install_ok"));
      } else {
        setMessage(data.error || t("plugins.install_fail"));
      }
    } catch {
      setMessage(t("plugins.install_fail"));
    }
    setInstallId("");
    setShowInstall(false);
    loadPlugins();
    setTimeout(() => setMessage(""), 3000);
  };

  const installAvailablePlugin = async (id: string) => {
    const plugin = MOCK_AVAILABLE.find((p) => p.id === id);
    if (!plugin) return;
    try {
      const res = await fetch("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: plugin.name }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage(data.message || t("plugins.install_ok"));
      } else {
        setMessage(data.error || t("plugins.install_fail"));
      }
    } catch {
      setMessage(t("plugins.install_fail"));
    }
    loadPlugins();
    setTimeout(() => setMessage(""), 3000);
  };

  const filteredPlugins = plugins.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.description.toLowerCase().includes(search.toLowerCase()),
  );

  const filteredAvailable = MOCK_AVAILABLE.filter(
    (p) =>
      !plugins.some((inst) => inst.name.toLowerCase() === p.name.toLowerCase() || inst.id === p.id) &&
      (p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.description.toLowerCase().includes(search.toLowerCase())),
  );

  const activeCount = plugins.filter((p) => p.status === "active").length;
  const errorCount = plugins.filter((p) => p.status === "error").length;

  return (
    <div style={containerStyle}>
      {/* Message banner */}
      {message && (
        <div style={{
          padding: "8px 14px", borderRadius: "6px", marginBottom: "12px",
          background: "var(--success-bg)", color: "var(--success)", fontSize: "12px",
        }}>
          {message}
        </div>
      )}

      {/* Stats Row */}
      <div style={statsRowStyle}>
        <div style={statCardStyle}>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--accent, #58a6ff)" }}>{plugins.length}</div>
          <div style={{ fontSize: "12px", color: "var(--text-secondary, #8b949e)", marginTop: "4px" }}>已安装</div>
        </div>
        <div style={statCardStyle}>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "#3fb950" }}>{activeCount}</div>
          <div style={{ fontSize: "12px", color: "var(--text-secondary, #8b949e)", marginTop: "4px" }}>已激活</div>
        </div>
        <div style={statCardStyle}>
          <div style={{ fontSize: "24px", fontWeight: 700, color: errorCount > 0 ? "#f85149" : "var(--text-secondary)" }}>{errorCount}</div>
          <div style={{ fontSize: "12px", color: "var(--text-secondary, #8b949e)", marginTop: "4px" }}>错误</div>
        </div>
        <div style={statCardStyle}>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--text-secondary)" }}>
            {filteredAvailable.length}
          </div>
          <div style={{ fontSize: "12px", color: "var(--text-secondary, #8b949e)", marginTop: "4px" }}>可用</div>
        </div>
      </div>

      {/* Header */}
      <div style={headerStyle}>
        <div style={titleStyle}>Plugin Manager</div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <input
            style={searchInputStyle}
            placeholder="搜索插件..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {activeTab === "installed" && (
            <button style={actionBtnStyle("primary")} onClick={() => setShowInstall(!showInstall)}>
              + Install
            </button>
          )}
        </div>
      </div>

      {/* Install Form */}
      {showInstall && (
        <div style={installFormStyle}>
          <input
            style={installInputStyle}
            placeholder="输入插件 ID 或名称..."
            value={installId}
            onChange={(e) => setInstallId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleInstall()}
          />
          <button style={actionBtnStyle("primary")} onClick={handleInstall}>Install</button>
          <button style={actionBtnStyle("default")} onClick={() => setShowInstall(false)}>Cancel</button>
        </div>
      )}

      {/* Tabs */}
      <div style={tabBarStyle}>
        <button style={tabStyle(activeTab === "installed")} onClick={() => setActiveTab("installed")}>
          Installed ({plugins.length})
        </button>
        <button style={tabStyle(activeTab === "available")} onClick={() => setActiveTab("available")}>
          Available ({filteredAvailable.length})
        </button>
      </div>

      {/* Plugin Cards */}
      {activeTab === "installed" && (
        <div style={cardGridStyle}>
          {filteredPlugins.map((plugin) => (
            <div key={plugin.id} style={pluginCardStyle}>
              <div style={pluginHeaderStyle}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "15px", marginBottom: "2px" }}>{plugin.name}</div>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary, #8b949e)" }}>
                    v{plugin.version} by {plugin.author}
                  </div>
                </div>
                <div style={statusBadgeStyle(plugin.status)}>
                  <span style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background: plugin.status === "active" ? "#3fb950" : plugin.status === "error" ? "#f85149" : "#8b949e",
                    display: "inline-block",
                  }} />
                  {plugin.status}
                </div>
              </div>

              <div style={{ fontSize: "13px", color: "var(--text-secondary, #8b949e)", margin: "10px 0" }}>
                {plugin.description}
              </div>

              {plugin.error && (
                <div style={{
                  padding: "6px 10px",
                  borderRadius: "4px",
                  background: "rgba(248,81,73,0.1)",
                  border: "1px solid rgba(248,81,73,0.2)",
                  color: "#f85149",
                  fontSize: "12px",
                  marginBottom: "8px",
                }}>
                  {plugin.error}
                </div>
              )}

              {/* Hooks */}
              <div style={{ marginBottom: "10px" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary, #8b949e)", marginBottom: "4px" }}>
                  Hooks ({plugin.hookCount})
                </div>
                {plugin.hooks.map((h, i) => (
                  <span key={i} style={hookChipStyle}>
                    {h.type}
                    <span style={{ opacity: 0.6, marginLeft: "4px" }}>{h.priority}</span>
                  </span>
                ))}
              </div>

              <div style={{ display: "flex", gap: "8px", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "11px", color: "var(--text-secondary, #8b949e)" }}>
                  Installed: {plugin.installedAt}
                </span>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    style={actionBtnStyle(plugin.status === "active" ? "default" : "primary")}
                    onClick={() => togglePlugin(plugin.id)}
                  >
                    {plugin.status === "active" ? "Disable" : "Enable"}
                  </button>
                  <button
                    style={actionBtnStyle("danger")}
                    onClick={() => uninstallPlugin(plugin.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
          {filteredPlugins.length === 0 && (
            <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: "40px", color: "var(--text-secondary, #8b949e)" }}>
              No plugins found matching "{search}"
            </div>
          )}
        </div>
      )}

      {/* Available Plugins */}
      {activeTab === "available" && (
        <div style={cardGridStyle}>
          {filteredAvailable.map((plugin) => {
            const isInstalled = plugins.some((p) => p.id === plugin.id);
            return (
            <div key={plugin.id} style={pluginCardStyle}>
              <div style={pluginHeaderStyle}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "15px", marginBottom: "2px" }}>{plugin.name}</div>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary, #8b949e)" }}>
                    v{plugin.version} by {plugin.author}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "4px", color: "#d29922", fontSize: "12px" }}>
                  ★ {plugin.rating}
                </div>
              </div>
              <div style={{ fontSize: "13px", color: "var(--text-secondary, #8b949e)", margin: "10px 0" }}>
                {plugin.description}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "11px", color: "var(--text-secondary, #8b949e)" }}>
                  {plugin.downloads.toLocaleString()} downloads
                </span>
                <button
                  style={{
                    ...actionBtnStyle("primary"),
                    ...(isInstalled ? { opacity: 0.5, cursor: "not-allowed" } : {}),
                  }}
                  onClick={() => installAvailablePlugin(plugin.id)}
                  disabled={isInstalled}
                >
                  {isInstalled ? "Installed" : "Install"}
                </button>
              </div>
            </div>
          );
          })}
          {filteredAvailable.length === 0 && (
            <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: "40px", color: "var(--text-secondary, #8b949e)" }}>
              No available plugins found matching "{search}"
            </div>
          )}
        </div>
      )}
    </div>
  );
}