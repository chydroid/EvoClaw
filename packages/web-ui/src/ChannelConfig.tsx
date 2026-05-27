import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "./i18n";
import QRCode from "qrcode";

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
    botName: "EvoClaw Bot",
    welcomeMessage: "Hello! I'm EvoClaw, your AI assistant.",
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
    botName: "EvoClaw Bot",
    welcomeMessage: "Hello! I'm EvoClaw, your AI assistant.",
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
    botName: "EvoClaw",
    welcomeMessage: "Hi, EvoClaw is online!",
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

// ─── QR Helpers ──────────────────────────────────────────────

function generateQrToken(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 10);
  return `${ts}${rand}`;
}

// ─── Component ───────────────────────────────────────────────

export default function ChannelConfigPage() {
  const { t } = useTranslation();

  const templates: ChannelTemplate[] = useMemo(() => [
    {
      id: "feishu",
      name: "Feishu",
      type: "feishu",
      icon: "🐦",
      description: t("channels.feishu_desc"),
      setupGuide: [
        t("channels.feishu_guide_1"),
        t("channels.feishu_guide_2"),
        t("channels.feishu_guide_3"),
        t("channels.feishu_guide_4"),
        t("channels.feishu_guide_5"),
        t("channels.feishu_guide_6"),
      ],
    },
    {
      id: "wecom",
      name: "Enterprise WeChat",
      type: "wecom",
      icon: "💼",
      description: t("channels.wecom_desc"),
      setupGuide: [
        t("channels.wecom_guide_1"),
        t("channels.wecom_guide_2"),
        t("channels.wecom_guide_3"),
        t("channels.wecom_guide_4"),
        t("channels.wecom_guide_5"),
        t("channels.wecom_guide_6"),
      ],
    },
    {
      id: "personal_wechat",
      name: "Personal WeChat",
      type: "personal_wechat",
      icon: "💬",
      description: t("channels.wechat_desc"),
      setupGuide: [
        t("channels.wechat_guide_1"),
        t("channels.wechat_guide_2"),
        t("channels.wechat_guide_3"),
        t("channels.wechat_guide_4"),
        t("channels.wechat_guide_5"),
        t("channels.wechat_note"),
      ],
    },
  ], [t]);

  const [channels, setChannels] = useState<ChannelConfig[]>(DEFAULT_CHANNEL_CONFIGS);
  const [activeChannel, setActiveChannel] = useState<string>("feishu");
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<"success" | "error" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const dragging = useRef(false);

  // ─── WeChat QR state ──────────────────────────────────
  const [qrStatus, setQrStatus] = useState<"idle" | "loading" | "waiting" | "connected" | "expired">("idle");
  const [qrToken, setQrToken] = useState<string>("");
  const [qrDataUri, setQrDataUri] = useState<string>("");
  const [showWechatForm, setShowWechatForm] = useState(false);
  const qrTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrTokenRef = useRef<string>("");

  const stopQrPolling = useCallback(() => {
    if (qrPollRef.current) { clearInterval(qrPollRef.current); qrPollRef.current = null; }
    if (qrTimerRef.current) { clearTimeout(qrTimerRef.current); qrTimerRef.current = null; }
  }, []);

  const refreshQR = useCallback(() => {
    stopQrPolling();
    setQrStatus("loading");
    setQrDataUri("");
    qrTokenRef.current = "";

    fetch("/api/channels/wechat/pair-request", { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        if (!data.success || !data.pairUrl) {
          setQrStatus("expired");
          return;
        }
        const key = data.qrcodeKey || "";
        setQrToken(key);
        qrTokenRef.current = key; // 保存到 ref，避免闭包问题
        setQrStatus("waiting");

        // Generate QR from the WeChat iLink URL
        return QRCode.toDataURL(data.pairUrl, {
          width: 240, margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
          errorCorrectionLevel: "M",
        });
      })
      .then((url: string | undefined) => {
        if (url) setQrDataUri(url);
      })
      .catch(() => {
        setQrStatus("expired");
      });

    // Auto-expire after 5 minutes
    qrTimerRef.current = setTimeout(() => {
      setQrStatus("expired");
      stopQrPolling();
    }, 5 * 60 * 1000);

    // Poll pairing status every 2 seconds — 使用 qrTokenRef 避免 React 闭包陷阱
    qrPollRef.current = setInterval(() => {
      const currentToken = qrTokenRef.current;
      if (!currentToken) return;
      fetch(`/api/channels/wechat/pair-status?qrcode=${encodeURIComponent(currentToken)}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.status === "confirmed") {
            setQrStatus("connected");
            stopQrPolling();
            // 自动启用个人微信通道
            setChannels((prev) =>
              prev.map((c) =>
                c.id === "personal_wechat" ? { ...c, enabled: true } : c
              )
            );
            // 保存启用状态到服务端
            fetch("/api/config/channels", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                channels: channels.map((c) =>
                  c.id === "personal_wechat" ? { ...c, enabled: true } : c
                ),
              }),
            }).catch(() => { /* ignore */ });
          } else if (data.status === "expired") {
            setQrStatus("expired");
            stopQrPolling();
          } else if (data.status === "scaned") {
            // Scanned but not confirmed yet — keep waiting
          } else if (data.status === "binded_redirect") {
            setQrStatus("connected");
            stopQrPolling();
            // 自动启用个人微信通道
            setChannels((prev) =>
              prev.map((c) =>
                c.id === "personal_wechat" ? { ...c, enabled: true } : c
              )
            );
          }
        })
        .catch(() => { /* ignore poll errors */ });
    }, 2000);
  }, [stopQrPolling]);

  useEffect(() => {
    return () => { stopQrPolling(); };
  }, [stopQrPolling]);

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
        if (data.channels && Array.isArray(data.channels) && data.channels.length > 0) {
          // Merge server data with defaults — keep all default channels, overlay server values
          const validated = DEFAULT_CHANNEL_CONFIGS.map((def) => {
            const ch = (data.channels as any[]).find((c: any) => c.id === def.id);
            if (!ch) return def;
            return {
              ...def,
              ...ch,
              features: { ...def.features, ...(ch.features || {}) },
              allowedUsers: Array.isArray(ch.allowedUsers) ? ch.allowedUsers : def.allowedUsers,
              allowedGroups: Array.isArray(ch.allowedGroups) ? ch.allowedGroups : def.allowedGroups,
            };
          });
          setChannels(validated as ChannelConfig[]);
        }
      }
    } catch {
      console.debug("[ChannelConfig] Server not reachable, using defaults");
    }

    // 检查微信连接状态，如果已连接则自动启用
    try {
      const statusRes = await fetch("/api/channels/weixin/status");
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        if (statusData.connected) {
          setChannels((prev) =>
            prev.map((c) =>
              c.id === "personal_wechat" ? { ...c, enabled: true } : c
            )
          );
        }
      }
    } catch { /* ignore */ }
  }

  async function saveConfig() {
    setSaving(true);
    setStatusMsg(null);
    setStatusType(null);
    try {
      const res = await fetch("/api/config/channels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels }),
      });
      if (res.ok) {
        setStatusMsg(t("channels.saved_ok"));
        setStatusType("success");
      } else {
        setStatusMsg(t("channels.saved_fail"));
        setStatusType("error");
      }
    } catch {
      setStatusMsg(t("channels.saved_local"));
      setStatusType("error");
    }
    setSaving(false);
    setTimeout(() => { setStatusMsg(null); setStatusType(null); }, 3000);
  }

  async function testConnection(channelId: string) {
    setTesting(channelId);
    try {
      const res = await fetch(`/api/channels/${channelId}/test`, { method: "POST" });
      if (res.ok) {
        setStatusMsg(t("channels.test_ok"));
        setStatusType("success");
      } else {
        setStatusMsg(t("channels.test_fail"));
        setStatusType("error");
      }
    } catch {
      setStatusMsg(t("channels.saved_local"));
      setStatusType("error");
    }
    setTesting(null);
    setTimeout(() => { setStatusMsg(null); setStatusType(null); }, 3000);
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
    const user = prompt(t("channels.enter_user_id"));
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
  const currentTemplate = templates.find((tm) => tm.id === activeChannel);
  const isWechat = currentChannel?.type === "personal_wechat";

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>{t("channels.title")}</h2>
        <div style={styles.headerActions}>
          <button
            style={styles.saveBtn}
            onClick={saveConfig}
            disabled={saving}
          >
            {saving ? t("channels.saving") : t("channels.save_all")}
          </button>
          {statusMsg && (
            <div style={{
              ...styles.statusBanner,
              background: statusType === "success" ? "var(--success-bg)" : "var(--error-bg)",
              color: statusType === "success" ? "var(--success)" : "var(--error)",
            }}>
              {statusMsg}
            </div>
          )}
        </div>
      </div>

      <div style={styles.body}>
        <div style={{ ...styles.sidebar, width: sidebarWidth }}>
          {templates.map((tm) => {
            const ch = channels.find((c) => c.id === tm.id);
            return (
              <div
                key={tm.id}
                style={{
                  ...styles.sidebarItem,
                  background: activeChannel === tm.id ? "var(--accent-bg)" : "transparent",
                  borderColor: activeChannel === tm.id ? "var(--accent)" : "transparent",
                }}
                onClick={() => setActiveChannel(tm.id)}
              >
                <div style={styles.channelName}>
                  <span style={{
                    ...styles.enabledDot,
                    background: ch?.enabled ? "var(--success)" : "var(--text-muted)",
                  }} />
                  <span style={styles.channelIcon}>{tm.icon}</span>
                  {tm.name}
                </div>
                <div style={styles.channelDesc}>{tm.description}</div>
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
                  {currentTemplate.icon} {currentTemplate.name} {t("channels.setup_guide")}
                </h3>
                <ol style={styles.guideSteps}>
                  {currentTemplate.setupGuide.map((step, i) => (
                    <li key={i} style={styles.guideStep}>{step}</li>
                  ))}
                </ol>
              </div>

              {/* ─── Personal WeChat QR Section ─── */}
              {isWechat && (
                <div style={styles.qrSection}>
                  <h3 style={styles.qrTitle}>{t("channels.qr_title")}</h3>
                  <p style={styles.qrDesc}>{t("channels.qr_desc")}</p>

                  <div style={styles.qrCodeBox}>
                    {qrStatus === "loading" && (
                      <div style={styles.qrPlaceholder}>
                        <span style={styles.spinner} />
                      </div>
                    )}
                    {qrStatus === "idle" && (
                      <div style={styles.qrPlaceholder}>
                        <button style={styles.qrStartBtn} onClick={refreshQR}>
                          {t("channels.qr_refresh")}
                        </button>
                      </div>
                    )}
                    {(qrStatus === "waiting" || qrStatus === "connected" || qrStatus === "expired") && qrDataUri && (
                      <img src={qrDataUri} alt="QR Code" style={styles.qrImage} />
                    )}
                    {(qrStatus === "waiting" || qrStatus === "connected" || qrStatus === "expired") && !qrDataUri && (
                      <div style={styles.qrPlaceholder}>
                        <span style={styles.spinner} />
                      </div>
                    )}
                  </div>

                  <div style={styles.qrStatusRow}>
                    {qrStatus === "waiting" && (
                      <>
                        <span style={styles.spinner} />
                        <span style={{ ...styles.qrStatusText, color: "var(--text-secondary)" }}>
                          {t("channels.qr_waiting")}
                        </span>
                      </>
                    )}
                    {qrStatus === "connected" && (
                      <>
                        <span style={styles.greenCheck}>✓</span>
                        <span style={{ ...styles.qrStatusText, color: "var(--success)" }}>
                          {t("channels.qr_connected")}
                        </span>
                      </>
                    )}
                    {qrStatus === "expired" && (
                      <>
                        <span style={styles.redX}>✗</span>
                        <span style={{ ...styles.qrStatusText, color: "var(--error)" }}>
                          {t("channels.qr_expired")}
                        </span>
                      </>
                    )}
                  </div>

                  {(qrStatus !== "idle" && qrStatus !== "loading") && (
                    <button style={styles.qrRefreshBtn} onClick={refreshQR}>
                      {t("channels.qr_refresh")}
                    </button>
                  )}

                  <div style={styles.qrFallbackRow}>
                    <button
                      style={styles.qrFallbackBtn}
                      onClick={() => setShowWechatForm((v) => !v)}
                    >
                      {showWechatForm ? t("channels.qr_switch_qr") : t("channels.qr_fallback")}
                    </button>
                  </div>
                </div>
              )}

              {/* ─── Form (hidden for personal_wechat unless toggled) ─── */}
              {(!isWechat || showWechatForm) && (
                <div style={styles.form}>
                  {isWechat && (
                    <div style={styles.fieldHintBox}>
                      <div style={styles.fieldHintTitle}>{t("channels.wechat_manual_hint_title")}</div>
                      <div style={styles.fieldHintText}>{t("channels.wechat_manual_hint_desc")}</div>
                    </div>
                  )}
                  <div style={styles.formRow}>
                    <div style={styles.formGroup}>
                      <label style={styles.label}>{t("channels.enable_channel")}</label>
                      <input
                        type="checkbox"
                        checked={currentChannel.enabled}
                        onChange={(e) => updateChannel(activeChannel, { enabled: e.target.checked })}
                        style={styles.checkbox}
                      />
                    </div>
                    <div style={styles.formGroup}>
                      <label style={styles.label}>{t("channels.bot_name")}</label>
                      <input
                        style={styles.input}
                        value={currentChannel.botName}
                        onChange={(e) => updateChannel(activeChannel, { botName: e.target.value })}
                      />
                      {isWechat && <div style={styles.fieldHint}>{t("channels.wechat_botname_hint")}</div>}
                    </div>
                  </div>

                  <div style={styles.formRow}>
                    <div style={styles.formGroup}>
                      <label style={styles.label}>
                        {isWechat ? t("channels.wechat_nickname") : t("channels.app_id")}
                      </label>
                      <input
                        style={styles.input}
                        value={currentChannel.appId}
                        onChange={(e) => updateChannel(activeChannel, { appId: e.target.value })}
                        placeholder={
                          currentChannel.type === "feishu" ? "cli_xxxxxxxxxxxx"
                            : currentChannel.type === "wecom" ? "ww1234567890abcdef"
                            : t("channels.wechat_nickname_placeholder")
                        }
                      />
                      {isWechat && <div style={styles.fieldHint}>{t("channels.wechat_nickname_hint")}</div>}
                    </div>
                    <div style={styles.formGroup}>
                      <label style={styles.label}>
                        {isWechat ? t("channels.wechat_token") : t("channels.app_secret")}
                      </label>
                      <input
                        style={styles.input}
                        type={isWechat ? "text" : "password"}
                        value={currentChannel.appSecret}
                        onChange={(e) => updateChannel(activeChannel, { appSecret: e.target.value })}
                        placeholder={isWechat ? t("channels.wechat_token_placeholder") : ""}
                      />
                      {isWechat && <div style={styles.fieldHint}>{t("channels.wechat_token_hint")}</div>}
                    </div>
                  </div>

                  <div style={styles.formRow}>
                    <div style={styles.formGroup}>
                      <label style={styles.label}>
                        {currentChannel.type === "feishu"
                          ? t("channels.verification_token")
                          : t("channels.token")}
                      </label>
                      <input
                        style={styles.input}
                        value={currentChannel.verificationToken}
                        onChange={(e) => updateChannel(activeChannel, { verificationToken: e.target.value })}
                        placeholder={isWechat ? t("channels.wechat_verify_hint") : ""}
                      />
                      {isWechat && <div style={styles.fieldHint}>{t("channels.wechat_verify_desc")}</div>}
                    </div>
                    <div style={styles.formGroup}>
                      <label style={styles.label}>
                        {isWechat ? t("channels.ws_url") : t("channels.webhook_url")}
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
                      {isWechat && <div style={styles.fieldHint}>{t("channels.wechat_ws_hint")}</div>}
                    </div>
                  </div>

                  {(currentChannel.type === "feishu" || currentChannel.type === "wecom") && (
                    <div style={styles.formRow}>
                      <div style={styles.formGroup}>
                        <label style={styles.label}>{t("channels.encrypt_key")}</label>
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
                    <label style={styles.label}>{t("channels.welcome_msg")}</label>
                    <textarea
                      style={{ ...styles.input, minHeight: "60px", resize: "vertical" }}
                      value={currentChannel.welcomeMessage}
                      onChange={(e) => updateChannel(activeChannel, { welcomeMessage: e.target.value })}
                      rows={2}
                    />
                  </div>

                  <div style={styles.divider} />

                  <h3 style={styles.sectionTitle}>{t("channels.features")}</h3>
                  <div style={styles.featuresGrid}>
                    {Object.entries(currentChannel?.features || {}).map(([key, value]) => (
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
                      {t("channels.allowed_users")}
                      <button style={styles.addBtn} onClick={() => addAllowedUser(activeChannel)}>{t("channels.add_user")}</button>
                    </label>
                    <div style={styles.tagList}>
                      {(currentChannel?.allowedUsers?.length ?? 0) === 0 ? (
                        <span style={styles.emptyHint}>{t("channels.no_restriction")}</span>
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
                      {testing === activeChannel ? t("channels.testing") : t("channels.test_connection")}
                    </button>
                  </div>
                </div>
              )}
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
    padding: "16px 20px 12px", borderBottom: "1px solid var(--border)",
  },
  title: { margin: 0, fontSize: "18px", color: "var(--section-title-color)", fontWeight: 600 },
  headerActions: { display: "flex", alignItems: "center", gap: "12px" },
  saveBtn: {
    padding: "8px 18px", borderRadius: "8px", border: "none",
    background: "var(--accent)", color: "#fff", cursor: "pointer", fontWeight: "bold", fontSize: "13px",
  },
  statusBanner: {
    padding: "6px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 500,
  },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  sidebar: {
    width: "280px", borderRight: "1px solid var(--border)",
    overflow: "auto", padding: "8px", flexShrink: 0,
  },
  resizeHandle: {
    width: "4px", cursor: "col-resize", background: "transparent",
    flexShrink: 0, transition: "background 0.2s",
    userSelect: "none" as const,
    borderLeft: "1px solid var(--border)",
  },
  sidebarItem: {
    padding: "12px", borderRadius: "8px", cursor: "pointer",
    border: "1px solid transparent", marginBottom: "4px", transition: "all 0.2s",
  },
  channelName: {
    fontSize: "14px", fontWeight: "bold", color: "var(--text-primary)",
    display: "flex", alignItems: "center", gap: "8px",
  },
  channelIcon: { fontSize: "16px" },
  channelDesc: { fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px", lineHeight: 1.4 },
  enabledDot: {
    width: "8px", height: "8px", borderRadius: "50%", display: "inline-block", flexShrink: 0,
  },
  content: { flex: 1, overflow: "auto", padding: "16px 20px" },
  setupGuide: {
    padding: "16px", borderRadius: "10px", background: "var(--bg-sidebar)",
    border: "1px solid var(--border)", marginBottom: "20px",
  },
  guideTitle: { margin: "0 0 12px 0", fontSize: "15px", color: "var(--section-title-color)" },
  guideSteps: { paddingLeft: "20px", margin: 0 },
  guideStep: { fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.8 },

  // ─── QR Code Section ──────────────────────────────────
  qrSection: {
    padding: "20px", borderRadius: "10px",
    background: "var(--bg-sidebar)", border: "1px solid var(--border)",
    marginBottom: "20px", display: "flex", flexDirection: "column", alignItems: "center",
  },
  qrTitle: { margin: "0 0 4px 0", fontSize: "15px", color: "var(--section-title-color)", fontWeight: 600 },
  qrDesc: { margin: "0 0 16px 0", fontSize: "12px", color: "var(--text-secondary)" },
  qrCodeBox: {
    width: "240px", height: "240px", borderRadius: "8px",
    border: "2px solid var(--border)", background: "#fff",
    display: "flex", alignItems: "center", justifyContent: "center",
    overflow: "hidden",
  },
  qrImage: { width: "240px", height: "240px" },
  qrPlaceholder: { width: "240px", height: "240px", background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "8px" },
  qrStartBtn: {
    padding: "10px 24px", borderRadius: "8px", border: "1px solid var(--accent)",
    background: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: "14px", fontWeight: "bold",
  },
  qrStatusRow: {
    display: "flex", alignItems: "center", gap: "8px", marginTop: "12px",
  },
  qrStatusText: { fontSize: "13px", fontWeight: 500 },
  spinner: {
    width: "14px", height: "14px", borderRadius: "50%",
    border: "2px solid var(--border)", borderTopColor: "var(--accent)",
    animation: "spin 0.8s linear infinite",
  },
  greenCheck: { fontSize: "16px", color: "var(--success)", fontWeight: "bold" },
  redX: { fontSize: "16px", color: "var(--error)", fontWeight: "bold" },
  qrRefreshBtn: {
    marginTop: "12px", padding: "8px 18px", borderRadius: "8px",
    border: "1px solid var(--accent)", background: "transparent",
    color: "var(--accent)", cursor: "pointer", fontSize: "13px", fontWeight: "bold",
  },
  qrFallbackRow: { marginTop: "16px" },
  qrFallbackBtn: {
    padding: "6px 14px", borderRadius: "6px", border: "none",
    background: "transparent", color: "var(--text-muted)",
    cursor: "pointer", fontSize: "12px", textDecoration: "underline",
  },

  // ─── Form ─────────────────────────────────────────────
  form: { width: "100%" },
  formRow: { display: "flex", gap: "16px" },
  formGroup: { flex: 1, marginBottom: "16px", minWidth: 0 },
  label: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    fontSize: "13px", fontWeight: "bold", color: "var(--text-primary)", marginBottom: "6px",
  },
  input: {
    width: "400px", padding: "8px 12px", borderRadius: "6px",
    border: "1px solid var(--input-border)", background: "var(--bg-sidebar)",
    color: "var(--text-primary)", fontSize: "14px", boxSizing: "border-box" as const,
  },
  checkbox: { accentColor: "var(--accent)", width: "16px", height: "16px" },
  divider: { height: "1px", background: "var(--border)", margin: "20px 0" },
  sectionTitle: { margin: "0 0 12px 0", fontSize: "14px", color: "var(--section-title-color)", fontWeight: 600 },
  featuresGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "8px" },
  featureItem: { display: "flex", alignItems: "center", gap: "8px" },
  featureLabel: { fontSize: "13px", color: "var(--text-primary)" },
  tagList: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" },
  tag: {
    display: "inline-flex", alignItems: "center", gap: "4px",
    padding: "4px 10px", borderRadius: "12px",
    background: "var(--accent-bg)", color: "var(--section-title-color)", fontSize: "12px",
  },
  tagRemove: { cursor: "pointer", fontWeight: "bold", fontSize: "14px", color: "var(--error)" },
  addBtn: {
    padding: "2px 8px", borderRadius: "4px", border: "1px solid var(--accent)",
    background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: "11px",
  },
  emptyHint: { fontSize: "12px", color: "var(--text-muted)" },
  fieldHint: { fontSize: "11px", color: "var(--text-muted)", marginTop: "3px", lineHeight: 1.4 },
  fieldHintBox: {
    padding: "12px 16px", borderRadius: "8px", marginBottom: "16px",
    background: "var(--accent-bg)", border: "1px solid var(--border)",
  },
  fieldHintTitle: { fontSize: "13px", fontWeight: "bold", color: "var(--accent)", marginBottom: "4px" },
  fieldHintText: { fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.6 },
  formActions: { marginTop: "20px", display: "flex", gap: "12px" },
  testBtn: {
    padding: "10px 20px", borderRadius: "8px", border: "1px solid var(--success)",
    background: "transparent", color: "var(--success)", cursor: "pointer",
    fontWeight: "bold", fontSize: "13px",
  },
};