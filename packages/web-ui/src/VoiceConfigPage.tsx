/**
 * VoiceConfigPage — 语音输入设置页面
 *
 * 功能：
 * - 显示/修改语音识别配置
 * - 验证本地引擎
 * - 启用/禁用语音输入
 * - 状态反馈与错误展示
 */
import React, { useState, useEffect } from "react";
import { useTranslation } from "./i18n";
import { voiceApi, type VoiceConfigData, type VoiceStatusData } from "./api-client";
import { isSpeechRecognitionSupported } from "./useVoice";

const styles: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  header: { marginBottom: "16px" },
  title: { color: "var(--section-title-color)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  card: {
    background: "var(--bg-sidebar)", border: "1px solid var(--border-light)",
    borderRadius: "8px", padding: "16px", marginBottom: "16px", maxWidth: "720px",
  },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px", gap: "16px" },
  rowVertical: { display: "flex", flexDirection: "column" as const, gap: "8px", marginBottom: "14px" },
  label: { color: "var(--text-primary)", fontSize: "13px", fontWeight: 600 },
  hint: { color: "var(--text-muted)", fontSize: "11px" },
  select: {
    padding: "8px 12px", borderRadius: "4px", border: "1px solid var(--border-light)",
    background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: "13px", minWidth: "240px",
  },
  input: {
    padding: "8px 12px", borderRadius: "4px", border: "1px solid var(--border-light)",
    background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: "13px",
  },
  checkboxRow: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" },
  checkbox: { width: "16px", height: "16px", cursor: "pointer" },
  button: {
    padding: "8px 16px", borderRadius: "4px", border: "none", cursor: "pointer",
    fontSize: "13px", fontWeight: "bold",
  },
  primaryBtn: { background: "var(--accent)", color: "#fff" },
  secondaryBtn: { background: "var(--bg-hover)", color: "var(--text-secondary)", border: "1px solid var(--border-light)" },
  dangerBtn: { background: "var(--error)", color: "#fff" },
  success: { color: "var(--success)", fontSize: "13px", marginTop: "8px" },
  error: { color: "var(--error)", fontSize: "13px", marginTop: "8px" },
  muted: { color: "var(--text-muted)", fontSize: "12px", marginTop: "8px" },
  badge: { display: "inline-block", padding: "2px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: "bold" },
  statusLine: { display: "flex", alignItems: "center", gap: "10px", marginTop: "8px", flexWrap: "wrap" as const },
};

const badgeStyle = (ok: boolean): React.CSSProperties => ({
  ...styles.badge,
  background: ok ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
  color: ok ? "#22c55e" : "#ef4444",
});

export function VoiceConfigPage() {
  const { t, lang } = useTranslation();
  const [config, setConfig] = useState<VoiceConfigData | null>(null);
  const [status, setStatus] = useState<VoiceStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const browserSupported = isSpeechRecognitionSupported();

  const fetchState = async () => {
    try {
      const data = await voiceApi.get();
      setConfig(data.config);
      setStatus(data.status);
    } catch (err) {
      setMessage({ type: "error", text: String(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchState();
  }, []);

  const showMessage = (type: "success" | "error", text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  };

  const handleChange = (patch: Partial<VoiceConfigData>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const handleVerify = async () => {
    if (!config) return;
    setVerifying(true);
    setMessage(null);
    try {
      const result = await voiceApi.verify();
      await fetchState();
      if (result.success) {
        showMessage("success", t("voice.verify_success"));
      } else {
        showMessage("error", t("voice.verify_fail").replace("{0}", result.message));
      }
    } catch (err) {
      showMessage("error", t("voice.verify_fail").replace("{0}", String(err)));
    } finally {
      setVerifying(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setMessage(null);
    try {
      const update: Partial<VoiceConfigData> = {
        engine: config.engine,
        language: config.language,
        continuous: config.continuous,
        interimResults: config.interimResults,
        autoSubmit: config.autoSubmit,
        timeoutMs: config.timeoutMs,
      };
      if (config.engine === "vosk") {
        update.voskModelPath = config.voskModelPath;
      }
      await voiceApi.update(update);
      await fetchState();
      showMessage("success", t("voice.saved"));
    } catch (err) {
      showMessage("error", t("voice.save_fail").replace("{0}", String(err)));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    if (!config || !status) return;
    const next = !config.enabled;
    if (next && !status.available) {
      showMessage("error", t("voice.not_verified"));
      return;
    }
    setSaving(true);
    try {
      await voiceApi.toggle(next);
      await fetchState();
      showMessage("success", next ? t("voice.toggle_on") : t("voice.toggle_off"));
    } catch (err) {
      showMessage("error", String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await voiceApi.reset();
      await fetchState();
      showMessage("success", t("voice.saved"));
    } catch (err) {
      showMessage("error", String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading || !config || !status) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <div style={styles.title}>{t("voice.title")}</div>
          <div style={styles.subtitle}>{t("voice.subtitle")}</div>
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>{t("app.loading")}</div>
      </div>
    );
  }

  const verified = status.available;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.title}>{t("voice.title")}</div>
        <div style={styles.subtitle}>{t("voice.subtitle")}</div>
      </div>

      <div style={styles.card}>
        <div style={styles.row}>
          <div>
            <div style={styles.label}>{t("voice.status")}</div>
            <div style={{ ...styles.hint, fontSize: "14px", fontWeight: 600, color: config.enabled ? "var(--success, #22c55e)" : "var(--text-muted)" }}>
              {config.enabled ? t("voice.status_enabled") : t("voice.status_disabled")}
            </div>
          </div>
          <div style={styles.statusLine}>
            <span style={badgeStyle(verified)}>{verified ? t("voice.available") : t("voice.unavailable")}</span>
          </div>
        </div>

        <div style={styles.row}>
          <button
            style={{ ...styles.button, ...(config.enabled ? styles.dangerBtn : styles.primaryBtn) }}
            onClick={handleToggle}
            disabled={saving || (!config.enabled && !verified)}
          >
            {config.enabled ? t("voice.turn_off") : t("voice.turn_on")}
          </button>
          <button style={{ ...styles.button, ...styles.secondaryBtn }} onClick={handleReset} disabled={saving}>
            {t("voice.reset")}
          </button>
        </div>

        {!verified && (
          <div style={styles.error}>{t("voice.not_verified")}</div>
        )}
        {status.lastError && (
          <div style={styles.error}>{t("voice.last_error")}: {status.lastError}</div>
        )}
        {status.lastVerifiedAt && (
          <div style={styles.muted}>{t("voice.last_verified")}: {new Date(status.lastVerifiedAt).toLocaleString(lang)}</div>
        )}
      </div>

      <div style={styles.card}>
        <div style={styles.row}>
          <label style={styles.label}>{t("voice.engine")}</label>
          <select
            style={styles.select}
            value={config.engine}
            onChange={(e) => handleChange({ engine: e.target.value as VoiceConfigData["engine"] })}
          >
            <option value="browser">{t("voice.engine_browser")}</option>
            <option value="vosk">{t("voice.engine_vosk")}</option>
          </select>
        </div>

        {config.engine === "browser" && !browserSupported && (
          <div style={styles.error}>{t("voice.browser_unsupported")}</div>
        )}

        <div style={styles.row}>
          <label style={styles.label}>{t("voice.language")}</label>
          <select
            style={styles.select}
            value={config.language}
            onChange={(e) => handleChange({ language: e.target.value })}
          >
            <option value="zh-CN">{t("voice.language_zh")}</option>
            <option value="en-US">{t("voice.language_en")}</option>
          </select>
        </div>

        {config.engine === "vosk" && (
          <div style={styles.rowVertical}>
            <label style={styles.label}>{t("voice.vosk_model_path")}</label>
            <input
              style={styles.input}
              value={config.voskModelPath || ""}
              onChange={(e) => handleChange({ voskModelPath: e.target.value })}
              placeholder="/path/to/vosk-model"
            />
          </div>
        )}

        <label style={{ ...styles.checkboxRow, marginBottom: "10px" }}>
          <input
            type="checkbox"
            style={styles.checkbox}
            checked={config.continuous}
            onChange={(e) => handleChange({ continuous: e.target.checked })}
          />
          <span style={styles.label}>{t("voice.continuous")}</span>
        </label>

        <label style={{ ...styles.checkboxRow, marginBottom: "10px" }}>
          <input
            type="checkbox"
            style={styles.checkbox}
            checked={config.interimResults}
            onChange={(e) => handleChange({ interimResults: e.target.checked })}
          />
          <span style={styles.label}>{t("voice.interim_results")}</span>
        </label>

        <label style={{ ...styles.checkboxRow, marginBottom: "10px" }}>
          <input
            type="checkbox"
            style={styles.checkbox}
            checked={config.autoSubmit}
            onChange={(e) => handleChange({ autoSubmit: e.target.checked })}
          />
          <span style={styles.label}>{t("voice.auto_submit")}</span>
        </label>

        <div style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
          <button
            style={{ ...styles.button, ...styles.secondaryBtn }}
            onClick={handleVerify}
            disabled={verifying}
          >
            {verifying ? t("voice.verifying") : t("voice.verify")}
          </button>
          <button
            style={{ ...styles.button, ...styles.primaryBtn }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? t("app.loading") : t("voice.save")}
          </button>
        </div>

        {message && (
          <div style={message.type === "success" ? styles.success : styles.error}>{message.text}</div>
        )}
      </div>
    </div>
  );
}
