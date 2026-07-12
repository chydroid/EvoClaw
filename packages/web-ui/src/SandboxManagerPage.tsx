/**
 * SandboxManagerPage — 沙箱管理
 *
 * 管理沙箱后端（Docker/SSH）、会话生命周期，以及在会话中执行代码。
 */
import React, { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import {
  Card, Badge, PageHeader, Loading, ErrorBanner, EmptyState,
  Section, PrimaryButton, SecondaryButton, DataTable,
  ConfirmModal, showToast,
} from "./shared";
import { useTranslation } from "./i18n";

// ── API 响应类型 ──────────────────────────────────────────────

interface SandboxBackend {
  type: string;
  name: string;
  available: boolean;
}

interface SandboxSession {
  id: string;
  backend: string;
  createdAt: string;
  timeoutMs?: number;
  status?: string;
}

interface ExecResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  error?: string;
}

// ── 样式 ──────────────────────────────────────────────────────

const s: Record<string, CSSProperties> = {
  container: { padding: "20px", overflow: "auto", height: "100%" },
  toolbar: { display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" as const },
  formRow: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" as const },
  select: {
    padding: "8px 12px", borderRadius: "8px",
    border: "1px solid var(--input-border)", background: "var(--bg-input)",
    color: "var(--text-primary)", fontSize: "13px", outline: "none",
    minWidth: "160px",
  },
  input: {
    padding: "8px 12px", borderRadius: "8px",
    border: "1px solid var(--input-border)", background: "var(--bg-input)",
    color: "var(--text-primary)", fontSize: "13px", outline: "none",
    width: "140px", boxSizing: "border-box" as const,
  },
  codeEditor: {
    width: "100%", minHeight: "200px", padding: "12px", borderRadius: "8px",
    border: "1px solid var(--input-border)", background: "var(--bg-input)",
    color: "var(--text-primary)", fontSize: "13px",
    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
    outline: "none", resize: "vertical" as const, boxSizing: "border-box" as const,
    lineHeight: 1.5,
  },
  outputBox: {
    background: "#0d1117", border: "1px solid var(--border)", borderRadius: "8px",
    padding: "12px", marginTop: "12px",
    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
    fontSize: "12px", color: "#c9d1d9",
    whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const,
    maxHeight: "320px", overflow: "auto",
  },
  metaRow: { display: "flex", gap: "12px", fontSize: "11px", color: "var(--text-muted)", marginTop: "8px", flexWrap: "wrap" as const },
  monoText: { fontFamily: "monospace", fontSize: "12px", color: "var(--text-primary)" },
  execSection: { display: "flex", flexDirection: "column" as const, gap: "10px" },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" },
};

function formatTime(iso: string | undefined, locale: string): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString(locale);
}

function formatMs(ms: number | undefined): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export default function SandboxManagerPage() {
  const { t, lang } = useTranslation();
  const locale = lang === "zh" ? "zh-CN" : "en-US";

  const [backends, setBackends] = useState<SandboxBackend[]>([]);
  const [sessions, setSessions] = useState<SandboxSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create session form
  const [newBackend, setNewBackend] = useState("");
  const [newTimeout, setNewTimeout] = useState("30000");
  const [creating, setCreating] = useState(false);

  // Destroy confirm
  const [destroyId, setDestroyId] = useState<string | null>(null);

  // Exec form
  const [execSessionId, setExecSessionId] = useState("");
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState("javascript");
  const [execTimeout, setExecTimeout] = useState("10000");
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<ExecResult | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [backendsRes, sessionsRes] = await Promise.all([
        fetch("/api/sandbox/backends"),
        fetch("/api/sandbox/sessions"),
      ]);
      if (!backendsRes.ok) throw new Error(`Failed to load sandbox backends: ${backendsRes.status}`);
      if (!sessionsRes.ok) throw new Error(`Failed to load sandbox sessions: ${sessionsRes.status}`);
      const backendsData = await backendsRes.json();
      const sessionsData = await sessionsRes.json();
      const backendsList: SandboxBackend[] = backendsData.backends || backendsData || [];
      const sessionsList: SandboxSession[] = sessionsData.sessions || sessionsData || [];
      setBackends(backendsList);
      setSessions(sessionsList);
      if (backendsList.length > 0) {
        setNewBackend(prev => prev || backendsList[0].type || backendsList[0].name);
      }
      if (sessionsList.length > 0) {
        setExecSessionId(prev => prev || sessionsList[0].id);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sandbox.load_failed", "加载失败"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleCreate = useCallback(async () => {
    if (!newBackend) return;
    setCreating(true);
    try {
      const res = await fetch("/api/sandbox/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: newBackend, timeoutMs: parseInt(newTimeout, 10) || 30000 }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || t("sandbox.create_failed", "创建会话失败"));
      }
      showToast(t("sandbox.created", "会话已创建"), "success");
      await fetchData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("sandbox.create_failed", "创建会话失败"), "error");
    } finally {
      setCreating(false);
    }
  }, [newBackend, newTimeout, fetchData, t]);

  const handleDestroy = useCallback(async () => {
    if (!destroyId) return;
    try {
      const res = await fetch(`/api/sandbox/sessions/${encodeURIComponent(destroyId)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || t("sandbox.destroy_failed", "销毁会话失败"));
      }
      showToast(t("sandbox.destroyed", "会话已销毁"), "success");
      if (execSessionId === destroyId) {
        setExecSessionId("");
        setExecResult(null);
      }
      await fetchData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("sandbox.destroy_failed", "销毁会话失败"), "error");
    } finally {
      setDestroyId(null);
    }
  }, [destroyId, execSessionId, fetchData, t]);

  const handleExec = useCallback(async () => {
    if (!execSessionId || !code.trim()) return;
    setExecuting(true);
    setExecResult(null);
    try {
      const res = await fetch(`/api/sandbox/sessions/${encodeURIComponent(execSessionId)}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: code,
          interpreter: language,
          timeoutMs: parseInt(execTimeout, 10) || 10000,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || t("sandbox.exec_failed", "执行失败"));
      }
      setExecResult(data.result || data);
      showToast(t("sandbox.exec_done", "执行完成"), "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("sandbox.exec_failed", "执行失败");
      setExecResult({ error: msg });
      showToast(msg, "error");
    } finally {
      setExecuting(false);
    }
  }, [execSessionId, code, language, execTimeout, t]);

  if (loading) return <Loading text={t("app.loading", "正在加载...")} />;

  return (
    <div style={s.container}>
      <PageHeader
        title={t("sandbox.title", "沙箱管理")}
        subtitle={t("sandbox.subtitle", "管理沙箱后端与会话，在隔离环境中执行代码")}
        actions={<SecondaryButton onClick={fetchData} small>{t("sandbox.refresh", "刷新")}</SecondaryButton>}
      />

      {error && <ErrorBanner message={error} onRetry={fetchData} />}

      <Section title={t("sandbox.backends_title", "沙箱后端")} style={{ marginTop: "20px" }}>
        <Card>
          {backends.length === 0 ? (
            <EmptyState icon="" title={t("sandbox.no_backends", "暂无可用沙箱后端")} />
          ) : (
            <DataTable
              columns={[
                { key: "type", label: t("sandbox.backend_type", "类型"), width: "20%", render: (b: SandboxBackend) => <Badge variant="info">{b.type}</Badge> },
                { key: "name", label: t("sandbox.backend_name", "名称"), width: "40%", render: (b: SandboxBackend) => <span style={s.monoText}>{b.name}</span> },
                {
                  key: "available", label: t("sandbox.backend_status", "状态"), width: "20%",
                  render: (b: SandboxBackend) => (
                    <Badge variant={b.available ? "success" : "error"}>
                      {b.available ? t("sandbox.available", "可用") : t("sandbox.unavailable", "不可用")}
                    </Badge>
                  ),
                },
                {
                  key: "action", label: "", width: "20%",
                  render: (b: SandboxBackend) => (
                    <PrimaryButton small disabled={!b.available} onClick={() => { setNewBackend(b.type || b.name); }}>
                      {t("sandbox.use_backend", "使用")}
                    </PrimaryButton>
                  ),
                },
              ]}
              data={backends}
              keyFn={(b) => `${b.type}-${b.name}`}
            />
          )}
        </Card>
      </Section>

      <Section title={t("sandbox.create_session", "创建会话")} style={{ marginTop: "20px" }}>
        <Card>
          <div style={s.formRow}>
            <label style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t("sandbox.select_backend", "选择后端")}</label>
            <select style={s.select} value={newBackend} onChange={(e) => setNewBackend(e.target.value)}>
              <option value="">{t("sandbox.select_backend", "选择后端")}</option>
              {backends.map((b) => (
                <option key={`${b.type}-${b.name}`} value={b.type || b.name}>
                  {b.type} — {b.name}{!b.available ? ` (${t("sandbox.unavailable", "不可用")})` : ""}
                </option>
              ))}
            </select>
            <label style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t("sandbox.timeout_ms", "超时 (ms)")}</label>
            <input style={s.input} type="number" value={newTimeout} onChange={(e) => setNewTimeout(e.target.value)} min={1000} step={1000} />
            <PrimaryButton onClick={handleCreate} disabled={!newBackend || creating}>
              {creating ? t("sandbox.creating", "创建中...") : t("sandbox.create", "创建")}
            </PrimaryButton>
          </div>
        </Card>
      </Section>

      <Section title={t("sandbox.sessions_title", "活跃会话")} style={{ marginTop: "20px" }}>
        <Card>
          {sessions.length === 0 ? (
            <EmptyState icon="" title={t("sandbox.no_sessions", "暂无活跃会话")} />
          ) : (
            <DataTable
              columns={[
                { key: "id", label: t("sandbox.session_id", "会话 ID"), width: "30%", render: (sess: SandboxSession) => <span style={s.monoText}>{sess.id.slice(0, 16)}...</span> },
                { key: "backend", label: t("sandbox.backend", "后端"), width: "15%", render: (sess: SandboxSession) => <Badge variant="default">{sess.backend}</Badge> },
                { key: "createdAt", label: t("sandbox.created_at", "创建时间"), width: "20%", render: (sess: SandboxSession) => formatTime(sess.createdAt, locale) },
                { key: "timeoutMs", label: t("sandbox.timeout", "超时"), width: "15%", render: (sess: SandboxSession) => formatMs(sess.timeoutMs) },
                {
                  key: "actions", label: t("sandbox.actions", "操作"), width: "20%",
                  render: (sess: SandboxSession) => (
                    <div style={{ display: "flex", gap: "6px" }}>
                      <GhostLinkBtn active={execSessionId === sess.id} onClick={() => { setExecSessionId(sess.id); setExecResult(null); }}>
                        {t("sandbox.exec_code", "执行代码")}
                      </GhostLinkBtn>
                      <PrimaryButton small danger onClick={() => setDestroyId(sess.id)}>
                        {t("sandbox.destroy", "销毁")}
                      </PrimaryButton>
                    </div>
                  ),
                },
              ]}
              data={sessions}
              keyFn={(sess) => sess.id}
            />
          )}
        </Card>
      </Section>

      {execSessionId && (
        <Section title={t("sandbox.exec_code", "执行代码")} style={{ marginTop: "20px" }}>
          <Card>
            <div style={s.execSection}>
              <div style={s.formRow}>
                <label style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t("sandbox.select_session", "会话")}</label>
                <select style={s.select} value={execSessionId} onChange={(e) => { setExecSessionId(e.target.value); setExecResult(null); }}>
                  {sessions.map((sess) => (
                    <option key={sess.id} value={sess.id}>{sess.id.slice(0, 16)}... ({sess.backend})</option>
                  ))}
                </select>
                <label style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t("sandbox.language", "语言")}</label>
                <select style={s.select} value={language} onChange={(e) => setLanguage(e.target.value)}>
                  <option value="javascript">JavaScript</option>
                  <option value="typescript">TypeScript</option>
                  <option value="python">Python</option>
                  <option value="bash">Bash</option>
                  <option value="sh">Shell</option>
                </select>
                <label style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t("sandbox.timeout_ms", "超时 (ms)")}</label>
                <input style={s.input} type="number" value={execTimeout} onChange={(e) => setExecTimeout(e.target.value)} min={1000} step={1000} />
              </div>
              <textarea
                style={s.codeEditor}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t("sandbox.placeholder_code", "在此输入代码...")}
                spellCheck={false}
              />
              <div>
                <PrimaryButton onClick={handleExec} disabled={executing || !code.trim()}>
                  {executing ? t("sandbox.executing", "执行中...") : t("sandbox.execute", "执行")}
                </PrimaryButton>
              </div>
            </div>
          </Card>

          {execResult && (
            <Card title={t("sandbox.output", "输出")} style={{ marginTop: "16px" }}>
              <div style={s.metaRow}>
                {execResult.exitCode != null && (
                  <span>{t("sandbox.exit_code", "退出码")}: <strong style={{ color: execResult.exitCode === 0 ? "var(--success)" : "var(--error)" }}>{execResult.exitCode}</strong></span>
                )}
                {execResult.durationMs != null && (
                  <span>{t("sandbox.duration", "耗时")}: {formatMs(execResult.durationMs)}</span>
                )}
              </div>
              {execResult.error ? (
                <div style={{ ...s.outputBox, color: "var(--error)" }}>{execResult.error}</div>
              ) : (
                <div style={s.outputBox}>
                  {execResult.stdout || <span style={{ color: "var(--text-muted)" }}>{t("sandbox.no_output", "(无输出)")}</span>}
                  {execResult.stderr && (
                    <div style={{ color: "#f85149", marginTop: "8px" }}>{execResult.stderr}</div>
                  )}
                </div>
              )}
            </Card>
          )}
        </Section>
      )}

      {destroyId && (
        <ConfirmModal
          title={t("sandbox.destroy_confirm_title", "销毁会话")}
          message={t("sandbox.destroy_confirm", "确定要销毁此会话吗？此操作不可撤销。")}
          confirmLabel={t("sandbox.destroy", "销毁")}
          danger
          onConfirm={handleDestroy}
          onCancel={() => setDestroyId(null)}
        />
      )}
    </div>
  );
}

// ── 内联小组件 ────────────────────────────────────────────────

function GhostLinkBtn({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} style={{
      padding: "6px 14px", borderRadius: "8px", border: "none",
      background: active ? "var(--accent-bg)" : "transparent",
      color: active ? "var(--accent)" : "var(--text-secondary)",
      cursor: "pointer", fontSize: "12px", fontWeight: 600,
    }}>
      {children}
    </button>
  );
}
