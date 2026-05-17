import React, { useState, useEffect, useRef, useCallback } from "react";

interface ChannelConfig {
  id: string;
  name: string;
  enabled: boolean;
  type: "feishu" | "wecom" | "personal_wechat";
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  webhookUrl: string;
  botName: string;
  welcomeMessage: string;
  allowedUsers: string[];
  allowedGroups: string[];
  features: {
    messageReceive: boolean;
    messageReply: boolean;
    groupChat: boolean;
    fileReceive: boolean;
    imageProcess: boolean;
    voiceProcess: boolean;
    commandTrigger: boolean;
  };
}

interface ChannelTemplate {
  id: string;
  name: string;
  type: "feishu" | "wecom" | "personal_wechat";
  icon: string;
  description: string;
  setupGuide: string[];
}

const CHANNEL_TEMPLATES: ChannelTemplate[] = [
  {
    id: "feishu",
    name: "Feishu",
    type: "feishu",
    icon: "🐦",
    description: "Feishu (Lark) integration for enterprise collaboration",
    setupGuide: [
      "1. Open Feishu Admin Console → Apps → Create Custom App",
      "2. Add bot capability to your custom app",
      "3. Configure event subscription with your server's callback URL",
      "4. Copy App ID and App Secret to the fields below",
      "5. Set required permissions: im:message, im:message.group",
      "6. Publish the app and install to your workspace",
    ],
  },
  {
    id: "wecom",
    name: "Enterprise WeChat",
    type: "wecom",
    icon: "💼",
    description: "WeCom (Enterprise WeChat) for corporate messaging",
    setupGuide: [
      "1. Login to WeCom Admin Console → Apps → Self-built Apps",
      "2. Create a new app and get CorpId, AgentId and Secret",
      "3. Configure the Webhook URL for message receiving",
      "4. Set Token and EncodingAESKey for message encryption",
      "5. Whitelist your server IP in WeCom admin",
      "6. Set callback URL and verify",
    ],
  },
  {
    id: "personal_wechat",
    name: "Personal WeChat",
    type: "personal_wechat",
    icon: "💬",
    description: "Personal WeChat integration via Bridge",
    setupGuide: [
      "1. Install the EcoClaw WeChat Bridge on a dedicated device",
      "2. Scan QR code to login to your WeChat account",
      "3. Configure the bridge WebSocket connection URL",
      "4. Set message handling rules and auto-reply templates",
      "5. Test connection with a private message",
      "Note: Personal WeChat automation may violate ToS. Use responsibly.",
    ],
  },
];

const DEFAULT_CHANNEL_CONFIGS: ChannelConfig[] = [
  {
    id: "feishu",
    name: "Feishu",
    enabled: false,
    type: "feishu",
    appId: "",
    appSecret: "",
    verificationToken: "",
    encryptKey: "",
    webhookUrl: "",
    botName: "EcoClaw Bot",
    welcomeMessage: "Hello! I'm EcoClaw, your AI assistant.",
    allowedUsers: [],
    allowedGroups: [],
    features: {
      messageReceive: true,
      messageReply: true,
      groupChat: true,
      fileReceive: true,
      imageProcess: false,
      voiceProcess: false,
      commandTrigger: true,
    },
  },
  {
    id: "wecom",
    name: "Enterprise WeChat",
    enabled: false,
    type: "wecom",
    appId: "",
    appSecret: "",
    verificationToken: "",
    encryptKey: "",
    webhookUrl: "",
    botName: "EcoClaw Bot",
    welcomeMessage: "Hello! I'm EcoClaw, your AI assistant.",
    allowedUsers: [],
    allowedGroups: [],
    features: {
      messageReceive: true,
      messageReply: true,
      groupChat: true,
      fileReceive: true,
      imageProcess: false,
      voiceProcess: false,
      commandTrigger: true,
    },
  },
  {
    id: "personal_wechat",
    name: "Personal WeChat",
    enabled: false,
    type: "personal_wechat",
    appId: "",
    appSecret: "",
    verificationToken: "",
    encryptKey: "",
    webhookUrl: "ws://localhost:8765",
    botName: "EcoClaw",
    welcomeMessage: "Hi, EcoClaw is online!",
    allowedUsers: [],
    allowedGroups: [],
    features: {
      messageReceive: true,
      messageReply: true,
      groupChat: false,
      fileReceive: true,
      imageProcess: false,
      voiceProcess: false,
      commandTrigger: true,
    },
  },
];

export default function ChannelConfigPage() {
  const [channels, setChannels] = useState<ChannelConfig[]>(DEFAULT_CHANNEL_CONFIGS);
  const [activeChannel, setActiveChannel] = useState<string>("feishu");
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(280);
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
      const res = await fetch("/api/config/channels");
      if (res.ok) {
        const data = await res.json();
        if (data.channels) {
          setChannels(data.channels as ChannelConfig[]);
        }
      }
    } catch {
      console.debug("[ChannelConfig] Server not reachable, using defaults");
    }
  }

  async function saveConfig() {
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch("/api/config/channels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels }),
      });
      if (res.ok) {
        setStatusMsg("Channel settings saved successfully");
      } else {
        setStatusMsg("Failed to save settings");
      }
    } catch {
      setStatusMsg("Server not reachable - config saved locally only");
    }
    setSaving(false);
    setTimeout(() => setStatusMsg(null), 3000);
  }

  async function testConnection(channelId: string) {
    setTesting(channelId);
    try {
      const res = await fetch(`/api/channels/${channelId}/test`, { method: "POST" });
      if (res.ok) {
        setStatusMsg("Connection test successful!");
      } else {
        setStatusMsg("Connection test failed");
      }
    } catch {
      setStatusMsg("Server not reachable");
    }
    setTesting(null);
    setTimeout(() => setStatusMsg(null), 3000);
  }

  function updateChannel(id: string, updates: Partial<ChannelConfig>) {
    setChannels((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...updates } : c))
    );
  }

  function updateFeatures(id: string, feature: keyof ChannelConfig["features"], value: boolean) {
    setChannels((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, features: { ...c.features, [feature]: value } }
          : c
      )
    );
  }

  function addAllowedUser(channelId: string) {
    const user = prompt("Enter user ID:");
    if (user) {
      setChannels((prev) =>
        prev.map((c) =>
          c.id === channelId && !c.allowedUsers.includes(user)
            ? { ...c, allowedUsers: [...c.allowedUsers, user] }
            : c
        )
      );
    }
  }

  function removeAllowedUser(channelId: string, user: string) {
    setChannels((prev) =>
      prev.map((c) =>
        c.id === channelId
          ? { ...c, allowedUsers: c.allowedUsers.filter((u) => u !== user) }
          : c
      )
    );
  }

  const currentChannel = channels.find((c) => c.id === activeChannel);
  const currentTemplate = CHANNEL_TEMPLATES.find((t) => t.id === activeChannel);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Channel Configuration</h2>
        <div style={styles.headerActions}>
          <button
            style={styles.saveBtn}
            onClick={saveConfig}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save All"}
          </button>
          {statusMsg && (
            <div style={{
              ...styles.statusBanner,
              background: statusMsg.includes("success") || statusMsg.includes("Connection test") ? "#064e3b" : "#4a1515",
              color: statusMsg.includes("success") || statusMsg.includes("Connection test") ? "#34d399" : "#f87171",
            }}>
              {statusMsg}
            </div>
          )}
        </div>
      </div>

      <div style={styles.body}>
        <div style={{ ...styles.sidebar, width: sidebarWidth }}>
          {CHANNEL_TEMPLATES.map((t) => {
            const ch = channels.find((c) => c.id === t.id);
            return (
              <div
                key={t.id}
                style={{
                  ...styles.sidebarItem,
                  background: activeChannel === t.id ? "#2d1b4e" : "transparent",
                  borderColor: activeChannel === t.id ? "#7c3aed" : "transparent",
                }}
                onClick={() => setActiveChannel(t.id)}
              >
                <div style={styles.channelName}>
                  <span style={{
                    ...styles.enabledDot,
                    background: ch?.enabled ? "#22c55e" : "#555",
                  }} />
                  <span style={styles.channelIcon}>{t.icon}</span>
                  {t.name}
                </div>
                <div style={styles.channelDesc}>{t.description}</div>
              </div>
            );
          })}
        </div>

        <div style={styles.resizeHandle} onMouseDown={onMouseDown} />

        <div style={styles.content}>
          {currentChannel && currentTemplate && (
            <>
              <div style={styles.setupGuide}>
                <h3 style={styles.guideTitle}>
                  {currentTemplate.icon} {currentTemplate.name} Setup Guide
                </h3>
                <ol style={styles.guideSteps}>
                  {currentTemplate.setupGuide.map((step, i) => (
                    <li key={i} style={styles.guideStep}>{step}</li>
                  ))}
                </ol>
              </div>

              <div style={styles.form}>
                <div style={styles.formRow}>
                  <div style={styles.formGroup}>
                    <label style={styles.label}>Enable Channel</label>
                    <input
                      type="checkbox"
                      checked={currentChannel.enabled}
                      onChange={(e) => updateChannel(activeChannel, { enabled: e.target.checked })}
                      style={styles.checkbox}
                    />
                  </div>
                  <div style={styles.formGroup}>
                    <label style={styles.label}>Bot Name</label>
                    <input
                      style={styles.input}
                      value={currentChannel.botName}
                      onChange={(e) => updateChannel(activeChannel, { botName: e.target.value })}
                    />
                  </div>
                </div>

                <div style={styles.formRow}>
                  <div style={styles.formGroup}>
                    <label style={styles.label}>App ID / Corp ID</label>
                    <input
                      style={styles.input}
                      value={currentChannel.appId}
                      onChange={(e) => updateChannel(activeChannel, { appId: e.target.value })}
                      placeholder={
                        currentChannel.type === "feishu" ? "cli_xxxxxxxxxxxx"
                          : currentChannel.type === "wecom" ? "ww1234567890abcdef"
                          : "App ID"
                      }
                    />
                  </div>
                  <div style={styles.formGroup}>
                    <label style={styles.label}>App Secret</label>
                    <input
                      style={styles.input}
                      type="password"
                      value={currentChannel.appSecret}
                      onChange={(e) => updateChannel(activeChannel, { appSecret: e.target.value })}
                    />
                  </div>
                </div>

                <div style={styles.formRow}>
                  <div style={styles.formGroup}>
                    <label style={styles.label}>
                      {currentChannel.type === "feishu" ? "Verification Token" : "Token"}
                    </label>
                    <input
                      style={styles.input}
                      value={currentChannel.verificationToken}
                      onChange={(e) => updateChannel(activeChannel, { verificationToken: e.target.value })}
                    />
                  </div>
                  <div style={styles.formGroup}>
                    <label style={styles.label}>
                      {currentChannel.type === "personal_wechat" ? "WebSocket URL" : "Webhook URL"}
                    </label>
                    <input
                      style={styles.input}
                      value={currentChannel.webhookUrl}
                      onChange={(e) => updateChannel(activeChannel, { webhookUrl: e.target.value })}
                      placeholder={
                        currentChannel.type === "feishu" ? "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
                          : currentChannel.type === "wecom" ? "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
                          : "ws://localhost:8765"
                      }
                    />
                  </div>
                </div>

                {(currentChannel.type === "feishu" || currentChannel.type === "wecom") && (
                  <div style={styles.formRow}>
                    <div style={styles.formGroup}>
                      <label style={styles.label}>Encrypt Key (EncodingAESKey)</label>
                      <input
                        style={styles.input}
                        type="password"
                        value={currentChannel.encryptKey}
                        onChange={(e) => updateChannel(activeChannel, { encryptKey: e.target.value })}
                      />
                    </div>
                    <div style={styles.formGroup} />
                  </div>
                )}

                <div style={styles.formGroup}>
                  <label style={styles.label}>Welcome Message</label>
                  <textarea
                    style={{ ...styles.input, minHeight: "60px", resize: "vertical" }}
                    value={currentChannel.welcomeMessage}
                    onChange={(e) => updateChannel(activeChannel, { welcomeMessage: e.target.value })}
                    rows={2}
                  />
                </div>

                <div style={styles.divider} />

                <h3 style={styles.sectionTitle}>Features</h3>
                <div style={styles.featuresGrid}>
                  {Object.entries(currentChannel.features).map(([key, value]) => (
                    <div key={key} style={styles.featureItem}>
                      <input
                        type="checkbox"
                        checked={value}
                        onChange={(e) =>
                          updateFeatures(activeChannel, key as keyof ChannelConfig["features"], e.target.checked)
                        }
                        style={styles.checkbox}
                      />
                      <span style={styles.featureLabel}>
                        {key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
                      </span>
                    </div>
                  ))}
                </div>

                <div style={styles.divider} />

                <div style={styles.formGroup}>
                  <label style={styles.label}>
                    Allowed Users
                    <button style={styles.addBtn} onClick={() => addAllowedUser(activeChannel)}>+ Add</button>
                  </label>
                  <div style={styles.tagList}>
                    {currentChannel.allowedUsers.length === 0 ? (
                      <span style={styles.emptyHint}>No restrictions (all users allowed)</span>
                    ) : (
                      currentChannel.allowedUsers.map((user) => (
                        <span key={user} style={styles.tag}>
                          {user}
                          <span
                            style={styles.tagRemove}
                            onClick={() => removeAllowedUser(activeChannel, user)}
                          >
                            ×
                          </span>
                        </span>
                      ))
                    )}
                  </div>
                </div>

                <div style={styles.formActions}>
                  <button
                    style={styles.testBtn}
                    onClick={() => testConnection(activeChannel)}
                    disabled={testing === activeChannel}
                  >
                    {testing === activeChannel ? "Testing..." : "Test Connection"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "16px 20px 12px", borderBottom: "1px solid #2a2a3a",
  },
  title: { margin: 0, fontSize: "18px", color: "#a78bfa", fontWeight: 600 },
  headerActions: { display: "flex", alignItems: "center", gap: "12px" },
  saveBtn: {
    padding: "8px 18px", borderRadius: "8px", border: "none",
    background: "#7c3aed", color: "#fff", cursor: "pointer", fontWeight: "bold", fontSize: "13px",
  },
  statusBanner: {
    padding: "6px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 500,
  },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  sidebar: {
    width: "280px", borderRight: "1px solid #2a2a3a",
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
    border: "1px solid transparent", marginBottom: "4px", transition: "all 0.2s",
  },
  channelName: {
    fontSize: "14px", fontWeight: "bold", color: "#e0e0e0",
    display: "flex", alignItems: "center", gap: "8px",
  },
  channelIcon: { fontSize: "16px" },
  channelDesc: { fontSize: "11px", color: "#888", marginTop: "4px", lineHeight: 1.4 },
  enabledDot: {
    width: "8px", height: "8px", borderRadius: "50%", display: "inline-block", flexShrink: 0,
  },
  content: { flex: 1, overflow: "auto", padding: "16px 20px" },
  setupGuide: {
    padding: "16px", borderRadius: "10px", background: "#1a1a2e",
    border: "1px solid #2a2a3a", marginBottom: "20px",
  },
  guideTitle: { margin: "0 0 12px 0", fontSize: "15px", color: "#a78bfa" },
  guideSteps: { paddingLeft: "20px", margin: 0 },
  guideStep: { fontSize: "12px", color: "#aaa", lineHeight: 1.8 },
  form: { maxWidth: "720px" },
  formRow: { display: "flex", gap: "16px" },
  formGroup: { flex: 1, marginBottom: "16px", minWidth: 0 },
  label: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    fontSize: "13px", fontWeight: "bold", color: "#ccc", marginBottom: "6px",
  },
  input: {
    width: "100%", padding: "8px 12px", borderRadius: "6px",
    border: "1px solid #3a3a4a", background: "#1a1a2e",
    color: "#e0e0e0", fontSize: "14px", boxSizing: "border-box" as const,
  },
  checkbox: { accentColor: "#7c3aed", width: "16px", height: "16px" },
  divider: { height: "1px", background: "#2a2a3a", margin: "20px 0" },
  sectionTitle: { margin: "0 0 12px 0", fontSize: "14px", color: "#a78bfa", fontWeight: 600 },
  featuresGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "8px" },
  featureItem: { display: "flex", alignItems: "center", gap: "8px" },
  featureLabel: { fontSize: "13px", color: "#ccc" },
  tagList: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" },
  tag: {
    display: "inline-flex", alignItems: "center", gap: "4px",
    padding: "4px 10px", borderRadius: "12px",
    background: "#2d1b4e", color: "#a78bfa", fontSize: "12px",
  },
  tagRemove: { cursor: "pointer", fontWeight: "bold", fontSize: "14px", color: "#f87171" },
  addBtn: {
    padding: "2px 8px", borderRadius: "4px", border: "1px solid #7c3aed",
    background: "transparent", color: "#7c3aed", cursor: "pointer", fontSize: "11px",
  },
  emptyHint: { fontSize: "12px", color: "#666" },
  formActions: { marginTop: "20px", display: "flex", gap: "12px" },
  testBtn: {
    padding: "10px 20px", borderRadius: "8px", border: "1px solid #22c55e",
    background: "transparent", color: "#22c55e", cursor: "pointer",
    fontWeight: "bold", fontSize: "13px",
  },
};