/**
 * 总体安全（Overall Security）
 *
 * 一个开关统管三处彼此独立的安全机制：文件访问边界、shell 危险命令、高危操作审批。
 * 三档定义见 `@evoclaw/security` 的 security-level.ts。
 */
import React, { useEffect, useState, useCallback } from "react";

interface SecurityPolicy {
  level: string;
  label: string;
  summary: string;
  sandbox: { read: string; write: string };
  outsideSandbox: { read: string; write: string };
  shell: { blockAtOrAbove: string | null; approveAtOrAbove: string | null };
  approveRiskyOperations: boolean;
}

interface Message {
  type: "success" | "error" | "warning" | "info";
  text: string;
}

const ACCESS_LABEL: Record<string, { text: string; color: string }> = {
  allow: { text: "允许", color: "var(--success, #3fb950)" },
  confirm: { text: "需确认", color: "var(--warning, #d29922)" },
  deny: { text: "禁止", color: "var(--error, #f85149)" },
};

const st = {
  page: { padding: "20px", maxWidth: "960px", margin: "0 auto", color: "var(--text-primary)" } as React.CSSProperties,
  title: { fontSize: "20px", fontWeight: 600, marginBottom: "4px" } as React.CSSProperties,
  sub: { fontSize: "13px", color: "var(--text-muted)", marginBottom: "20px", lineHeight: 1.6 } as React.CSSProperties,
  card: (active: boolean) => ({
    border: `1px solid ${active ? "var(--accent, #58a6ff)" : "var(--border)"}`,
    borderRadius: 8,
    padding: "14px 16px",
    marginBottom: "12px",
    cursor: "pointer",
    background: active ? "var(--bg-tertiary, #21262d)" : "transparent",
    transition: "border-color .15s, background .15s",
  }) as React.CSSProperties,
  cardHead: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" } as React.CSSProperties,
  radio: { width: "16px", height: "16px", accentColor: "var(--accent, #58a6ff)", cursor: "pointer" } as React.CSSProperties,
  label: { fontSize: "15px", fontWeight: 600 } as React.CSSProperties,
  badge: (level: string) => ({
    fontSize: "11px",
    padding: "1px 7px",
    borderRadius: 10,
    border: `1px solid ${level === "risky" ? "var(--error, #f85149)" : level === "strict" ? "var(--success, #3fb950)" : "var(--warning, #d29922)"}`,
    color: level === "risky" ? "var(--error, #f85149)" : level === "strict" ? "var(--success, #3fb950)" : "var(--warning, #d29922)",
  }) as React.CSSProperties,
  summary: { fontSize: "13px", color: "var(--text-secondary, #8b949e)", marginBottom: "10px", lineHeight: 1.6 } as React.CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: "12px", marginTop: "4px" } as React.CSSProperties,
  th: { textAlign: "left", padding: "5px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontWeight: 500 } as React.CSSProperties,
  td: { padding: "5px 8px", borderBottom: "1px solid var(--border-light, #21262d)" } as React.CSSProperties,
  msg: (t: Message["type"]) => ({
    padding: "9px 12px",
    borderRadius: 6,
    fontSize: "13px",
    marginBottom: "14px",
    border: `1px solid ${t === "success" ? "var(--success, #3fb950)" : t === "error" ? "var(--error, #f85149)" : "var(--warning, #d29922)"}`,
    color: t === "success" ? "var(--success, #3fb950)" : t === "error" ? "var(--error, #f85149)" : "var(--warning, #d29922)",
  }) as React.CSSProperties,
  note: { fontSize: "12px", color: "var(--text-muted)", marginTop: "14px", lineHeight: 1.7, padding: "10px 12px", background: "var(--bg-sidebar)", borderRadius: 6, border: "1px solid var(--border-light, #21262d)" } as React.CSSProperties,
  saving: { fontSize: "12px", color: "var(--text-muted)", marginLeft: "8px" } as React.CSSProperties,
};

function AccessText({ value }: { value: string }) {
  const meta = ACCESS_LABEL[value] ?? { text: value, color: "var(--text-muted)" };
  return <span style={{ color: meta.color, fontWeight: 500 }}>{meta.text}</span>;
}

export default function OverallSecurityPage() {
  const [current, setCurrent] = useState<SecurityPolicy | null>(null);
  const [levels, setLevels] = useState<SecurityPolicy[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/security-level");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCurrent(data.current);
      setLevels(data.levels || []);
    } catch (err) {
      setMessage({ type: "error", text: `加载失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const switchTo = async (level: string) => {
    if (saving || current?.level === level) return;
    const prev = current;
    // 乐观更新，失败回滚
    const target = levels.find((l) => l.level === level);
    if (target) setCurrent(target);
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/security-level", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setCurrent(data.current);
      if (data.levels) setLevels(data.levels);
      setMessage({ type: "success", text: `已切换到「${data.current.label}」` });
    } catch (err) {
      if (prev) setCurrent(prev);
      setMessage({ type: "error", text: `切换失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={st.page}>
      <div style={st.title}>总体安全</div>
      <div style={st.sub}>
        一个开关统管文件访问边界、shell 危险命令与高危操作审批三处机制。修改后<strong>立即生效</strong>，无需重启。
      </div>

      {message && <div style={st.msg(message.type)}>{message.text}</div>}
      {saving && <span style={st.saving}>保存中…</span>}

      {levels.length === 0 && !message && <div style={st.sub}>加载中…</div>}

      {levels.map((lv) => {
        const active = current?.level === lv.level;
        return (
          <div key={lv.level} style={st.card(active)} onClick={() => switchTo(lv.level)}>
            <div style={st.cardHead}>
              <input
                type="radio"
                checked={active}
                readOnly
                style={st.radio}
                onChange={() => switchTo(lv.level)}
                onClick={(e) => e.stopPropagation()}
              />
              <span style={st.label}>{lv.label}</span>
              <span style={st.badge(lv.level)}>{lv.level}</span>
            </div>
            <div style={st.summary}>{lv.summary}</div>

            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>范围</th>
                  <th style={st.th}>读取</th>
                  <th style={st.th}>写入 / 修改 / 删除</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={st.td}>沙箱内（工作区）</td>
                  <td style={st.td}><AccessText value={lv.sandbox.read} /></td>
                  <td style={st.td}><AccessText value={lv.sandbox.write} /></td>
                </tr>
                <tr>
                  <td style={st.td}>沙箱外</td>
                  <td style={st.td}><AccessText value={lv.outsideSandbox.read} /></td>
                  <td style={st.td}><AccessText value={lv.outsideSandbox.write} /></td>
                </tr>
                <tr>
                  <td style={st.td}>危险 shell 命令</td>
                  <td style={st.td} colSpan={2}>
                    {lv.shell.blockAtOrAbove
                      ? `达到「${lv.shell.blockAtOrAbove}」即硬拦（不接受审批）`
                      : "不额外硬拦"}
                    {" · "}
                    {lv.shell.approveAtOrAbove
                      ? `达到「${lv.shell.approveAtOrAbove}」需人工审批`
                      : "无需审批"}
                  </td>
                </tr>
                <tr>
                  <td style={st.td}>高危操作（删文件 / 发邮件 / git push 等）</td>
                  <td style={st.td} colSpan={2}>
                    {lv.approveRiskyOperations ? "需人工审批" : <span style={{ color: "var(--warning, #d29922)", fontWeight: 500 }}>免审批</span>}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}

      <div style={st.note}>
        <strong>任何等级都不会放宽的两条红线：</strong>
        <br />① 命令注入特征（换行、反引号、命令替换）—— 任何等级都直接拦截，不接受审批；
        <br />② 格式化磁盘、直接写磁盘设备、递归强删根目录 / 主目录 / 整盘 —— 任何等级都直接拦截。
        <br />
        <br />
        <strong>提示：</strong>「一定风险」档下文件操作与常规危险命令都不再弹审批，请确认你清楚它的含义后再切换。
      </div>
    </div>
  );
}