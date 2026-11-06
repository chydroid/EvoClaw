/**
 * 工作区切换（Workspace Switch）
 *
 * 用途：运行时切换 EvoClaw 的工作目录。
 * - 默认工作区 = data/workspace（适合用户交付物）。
 * - 切换到「项目根」后 Agent 才能修改自身源码（修自己的代码场景）。
 * - 切换后立即生效（无需重启）：server 端 WorkspaceManager 同步 AgentModelExecutor +
 *   BootstrapManager 并广播 WORKSPACE_SWITCHED / WORKSPACE_RESET 事件。
 *
 * 安全：API 端点本身受 cookie/JWT 鉴权保护（不在 auth-provider 公开列表中）。
 * 前端无额外权限闸门——若将来开放给非管理员，需要在 @evoclaw/security 加权限闸门。
 */
import React, { useEffect, useState, useCallback } from "react";
import { useTranslation } from "./i18n";
import { workspaceApi, errorMessage, type WorkspaceInfo, type WorkspaceSwitchResult } from "./api-client";

interface Message {
  type: "success" | "error" | "warning" | "info";
  text: string;
}

const st = {
  page: { padding: "20px", maxWidth: "960px", margin: "0 auto", color: "var(--text-primary)" } as React.CSSProperties,
  title: { fontSize: "20px", fontWeight: 600, marginBottom: "4px" } as React.CSSProperties,
  sub: { fontSize: "13px", color: "var(--text-muted)", marginBottom: "20px", lineHeight: 1.6 } as React.CSSProperties,
  msg: (t: Message["type"]) => ({
    padding: "9px 12px",
    borderRadius: 6,
    marginBottom: "12px",
    fontSize: "13px",
    background: t === "success" ? "var(--success-bg, rgba(63, 185, 80, 0.1))" :
               t === "error" ? "var(--error-bg, rgba(248, 81, 73, 0.1))" :
               t === "warning" ? "var(--warning-bg, rgba(210, 153, 34, 0.1))" : "var(--bg-tertiary, #21262d)",
    color: t === "success" ? "var(--success, #3fb950)" :
           t === "error" ? "var(--error, #f85149)" :
           t === "warning" ? "var(--warning, #d29922)" : "var(--text-secondary)",
    borderLeft: `3px solid ${t === "success" ? "var(--success, #3fb950)" :
                   t === "error" ? "var(--error, #f85149)" :
                   t === "warning" ? "var(--warning, #d29922)" : "var(--accent, #58a6ff)"}`,
  }) as React.CSSProperties,
  card: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "14px 16px",
    marginBottom: "16px",
    background: "var(--bg-primary, transparent)",
  } as React.CSSProperties,
  cardHead: { fontSize: "13px", fontWeight: 600, marginBottom: "10px", color: "var(--text-secondary)" } as React.CSSProperties,
  label: { fontSize: "12px", color: "var(--text-muted, #8b949e)", marginRight: "8px" } as React.CSSProperties,
  value: { fontSize: "13px", fontFamily: "var(--font-mono, monospace)", wordBreak: "break-all", color: "var(--text-primary)" } as React.CSSProperties,
  badge: (source: string) => {
    const color = source === "runtime" ? "var(--accent, #58a6ff)" :
                  source === "env" ? "var(--warning, #d29922)" : "var(--text-muted, #8b949e)";
    return {
      fontSize: "11px",
      padding: "1px 7px",
      borderRadius: 10,
      border: `1px solid ${color}`,
      color,
    } as React.CSSProperties;
  },
  presetRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 0",
    borderBottom: "1px solid var(--border-light, #21262d)",
  } as React.CSSProperties,
  btn: (primary: boolean, disabled: boolean) => ({
    padding: "8px 14px",
    borderRadius: 6,
    border: `1px solid ${primary ? "var(--accent, #58a6ff)" : "var(--border)"}`,
    background: primary ? "var(--accent, #58a6ff)" : "transparent",
    color: primary ? "var(--bg-primary, #fff)" : "var(--text-primary)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "13px",
    transition: "opacity .15s",
    opacity: disabled ? 0.5 : 1,
  }) as React.CSSProperties,
  input: {
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg-primary, #0d1117)",
    color: "var(--text-primary)",
    fontSize: "13px",
    fontFamily: "var(--font-mono, monospace)",
    width: "100%",
    maxWidth: "480px",
  } as React.CSSProperties,
  inline: { display: "flex", gap: "8px", alignItems: "center", marginTop: "8px" } as React.CSSProperties,
};

export default function WorkspacePage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [customPath, setCustomPath] = useState("");

  const load = useCallback(async () => {
    try {
      const data: WorkspaceInfo = await workspaceApi.getInfo();
      setInfo(data);
    } catch (err) {
      setInfo(null);
      setMessage({ type: "error", text: `${t("workspace.switch_failed")}${errorMessage(err)}` });
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const switchTo = async (dir: string, label: string) => {
    const prev = info;
    setBusy(true);
    setMessage(null);
    try {
      const res: WorkspaceSwitchResult = await workspaceApi.switchTo(dir);
      if (!res.success) throw new Error(res.error || "Unknown error");
      setInfo((prev2) => ({ ...prev2, dir: res.dir, source: res.source, overridden: res.overridden, presets: res.presets }));
      setMessage({ type: "success", text: `${t("workspace.switch_success")}${res.dir}（${label}）` });
    } catch (err) {
      setInfo(prev); // 回滚
      setMessage({ type: "error", text: `${t("workspace.switch_failed")}${errorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const prev = info;
    setBusy(true);
    setMessage(null);
    try {
      const res: WorkspaceSwitchResult = await workspaceApi.reset();
      setInfo((prev2) => ({ ...prev2, dir: res.dir, source: res.source, overridden: res.overridden, presets: res.presets }));
      setMessage({ type: "success", text: `${t("workspace.reset_success")}${res.dir}` });
    } catch (err) {
      setInfo(prev);
      setMessage({ type: "error", text: `${t("workspace.reset_failed")}${errorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const onCustomSwitch = () => {
    if (!customPath.trim()) {
      setMessage({ type: "warning", text: t("workspace.missing_dir_arg") });
      return;
    }
    void switchTo(customPath.trim(), "");
  };

  return (
    <div style={st.page}>
      <div style={st.title}>{t("workspace.title")}</div>
      <div style={st.sub}>{t("workspace.subtitle")}</div>

      {message && <div style={st.msg(message.type)}>{message.text}</div>}

      {!info && <div style={st.sub}>{t("workspace.loading")}</div>}

      {info && (
        <>
          {/* 当前工作区信息 */}
          <div style={st.card}>
            <div style={st.cardHead}>{t("workspace.current")}</div>
            <div style={{ marginBottom: "8px" }}>
              <span style={st.label}>{t("workspace.dir")}:</span>
              <span style={st.value}>{info.dir}</span>
            </div>
            <div style={{ marginBottom: "8px" }}>
              <span style={st.label}>{t("workspace.overridden")}:</span>
              <span style={st.badge(info.source)}>{
                info.source === "runtime" ? t("workspace.source_runtime") :
                info.source === "env" ? t("workspace.source_env") : t("workspace.source_default")
              }</span>
            </div>
          </div>

          {/* 快速切换 */}
          <div style={st.card}>
            <div style={st.cardHead}>{t("workspace.quick_switch")}</div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                style={st.btn(true, busy)}
                disabled={busy || info.dir === info.presets.repoRoot}
                onClick={() => void switchTo(info.presets.repoRoot, t("workspace.prepo_root"))}
              >
                {t("workspace.switch_to_repo_root")}
              </button>
              <button
                style={st.btn(false, busy)}
                disabled={busy || info.dir === info.presets.dataWorkspace}
                onClick={() => void switchTo(info.presets.dataWorkspace, t("workspace.pdata_workspace"))}
              >
                {t("workspace.switch_to_data_workspace")}
              </button>
              <button
                style={st.btn(false, busy)}
                disabled={busy || !info.overridden}
                onClick={() => void reset()}
              >
                {t("workspace.reset")}
              </button>
            </div>
          </div>

          {/* 自定义路径 */}
          <div style={st.card}>
            <div style={st.cardHead}>{t("workspace.custom_switch")}</div>
            <div style={st.inline}>
              <input
                style={st.input}
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder={t("workspace.custom_path_placeholder")}
                onKeyDown={(e) => { if (e.key === "Enter") onCustomSwitch(); }}
              />
              <button style={st.btn(true, busy)} disabled={busy} onClick={onCustomSwitch}>
                {t("workspace.switch")}
              </button>
            </div>
          </div>

          {/* 预设路径参考（不做题，仅展示） */}
          <div style={st.card}>
            <div style={st.cardHead}>{t("workspace.presets")}</div>
            <div style={st.presetRow}>
              <span style={st.label}>{t("workspace.prepo_root")}:</span>
              <span style={st.value}>{info.presets.repoRoot}</span>
            </div>
            <div style={st.presetRow}>
              <span style={st.label}>{t("workspace.pdata_workspace")}:</span>
              <span style={st.value}>{info.presets.dataWorkspace}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
