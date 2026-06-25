import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "./i18n";

interface ScheduledTask {
  id: string;
  name: string;
  cronExpression: string;
  description: string;
  enabled: boolean;
  handlerType: string;
  handlerConfig: Record<string, unknown>;
  lastRun?: string;
  nextRun?: string;
  status: string;
  runCount: number;
  errorCount: number;
}

const cronStatusBadgeStyle = (enabled: boolean): React.CSSProperties => ({
  display: "inline-block", padding: "2px 10px", borderRadius: "10px", fontSize: "10px", fontWeight: "bold",
  background: enabled ? "var(--success-bg)" : "var(--bg-hover)",
  color: enabled ? "var(--success)" : "var(--text-muted)",
});

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" },
  title: { color: "var(--section-title-color)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  addBtn: {
    padding: "8px 16px", borderRadius: "6px", border: "none", cursor: "pointer",
    background: "var(--accent)", color: "#fff", fontSize: "12px", fontWeight: "bold",
  },
  card: {
    background: "var(--bg-card)", borderRadius: "8px", padding: "16px", border: "1px solid var(--border-light)", marginBottom: "12px",
  },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" },
  cardTitle: { color: "var(--text-primary)", fontSize: "14px", fontWeight: "bold" },
  cardDesc: { color: "var(--text-secondary)", fontSize: "12px", marginTop: "4px" },
  cronBadge: {
    display: "inline-block", padding: "4px 10px", borderRadius: "4px", fontSize: "12px",
    fontFamily: "Consolas, Monaco, monospace", background: "var(--bg-hover)", color: "var(--accent)",
    fontWeight: "bold", marginTop: "8px",
  },
  metaRow: { display: "flex", gap: "20px", marginTop: "10px", flexWrap: "wrap" as const },
  metaItem: { color: "var(--text-muted)", fontSize: "11px" },
  metaValue: { color: "var(--text-secondary)", fontWeight: "bold" },
  actionBtns: { display: "flex", gap: "6px", marginTop: "10px" },
  actionBtn: {
    padding: "4px 12px", borderRadius: "4px", border: "1px solid var(--border-light)", cursor: "pointer",
    background: "var(--bg-hover)", color: "var(--text-secondary)", fontSize: "11px",
  },
  dangerBtn: {
    padding: "4px 12px", borderRadius: "4px", border: "1px solid var(--error)", cursor: "pointer",
    background: "transparent", color: "var(--error)", fontSize: "11px",
  },
  modal: {
    position: "fixed" as const, top: 0, left: 0, right: 0, bottom: 0,
    background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
  },
  modalCard: {
    background: "var(--bg-card)", borderRadius: "12px", padding: "24px", border: "1px solid var(--border-light)",
    maxWidth: "520px", width: "90%", maxHeight: "80vh", overflow: "auto",
  },
  modalTitle: { color: "var(--text-primary)", fontSize: "16px", fontWeight: "bold", marginBottom: "16px" },
  field: { marginBottom: "14px" },
  label: { color: "var(--text-secondary)", fontSize: "12px", fontWeight: "bold", marginBottom: "4px", display: "block" },
  input: {
    width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border-light)",
    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: "13px", boxSizing: "border-box" as const,
  },
  select: {
    width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--border-light)",
    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: "13px",
  },
  helpText: { color: "var(--text-muted)", fontSize: "10px", marginTop: "4px" },
  checkbox: { display: "flex", alignItems: "center", gap: "8px" },
  empty: { color: "var(--text-muted)", fontSize: "13px", padding: "40px", textAlign: "center" as const },
  templateSection: { marginBottom: "20px" },
  templateGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "8px" },
  templateCard: {
    padding: "12px", borderRadius: "6px", border: "1px solid var(--border-light)", cursor: "pointer",
    background: "var(--bg-hover)", transition: "all 0.15s",
  },
  templateName: { color: "var(--text-primary)", fontSize: "13px", fontWeight: "bold" },
  templateDesc: { color: "var(--text-muted)", fontSize: "11px", marginTop: "4px" },
  templateCron: { color: "var(--accent)", fontSize: "11px", fontFamily: "monospace", marginTop: "4px" },
};

const CRON_TEMPLATES = [
  { nameKey: "cron.tpl_heartbeat", descKey: "cron.tpl_heartbeat_desc", cron: "*/30 * * * *", handlerType: "system" },
  { nameKey: "cron.tpl_skill_refresh", descKey: "cron.tpl_skill_refresh_desc", cron: "0 2 * * *", handlerType: "skills" },
  { nameKey: "cron.tpl_memory_clean", descKey: "cron.tpl_memory_clean_desc", cron: "0 * * * *", handlerType: "memory" },
  { nameKey: "cron.tpl_greeting", descKey: "cron.tpl_greeting_desc", cron: "0 */6 * * *", handlerType: "chat" },
  { nameKey: "cron.tpl_log_archive", descKey: "cron.tpl_log_archive_desc", cron: "0 3 * * *", handlerType: "system" },
  { nameKey: "cron.tpl_health_check", descKey: "cron.tpl_health_check_desc", cron: "*/15 * * * *", handlerType: "system" },
];

interface TaskForm {
  name: string;
  cronExpression: string;
  description: string;
  handlerType: string;
  enabled: boolean;
}

export function CronPage() {
  const { t, lang } = useTranslation();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<TaskForm>({
    name: "", cronExpression: "", description: "", handlerType: "system", enabled: true,
  });
  const [message, setMessage] = useState("");
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleClearMessage = () => {
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    messageTimerRef.current = setTimeout(() => { setMessage(""); }, 3000);
  };
  useEffect(() => { return () => { if (messageTimerRef.current) clearTimeout(messageTimerRef.current); }; }, []);

  const loadTasks = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/scheduler/tasks", { signal });
      if (signal?.aborted) return;
      if (res.ok) {
        const data = await res.json();
        setTasks(Array.isArray(data.tasks) ? data.tasks : []);
      }
    } catch {
      // Scheduler API may not be available yet
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadTasks(controller.signal);
    const interval = setInterval(() => loadTasks(controller.signal), 10000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [loadTasks]);

  const applyTemplate = (tpl: typeof CRON_TEMPLATES[0]) => {
    setForm({
      name: t(tpl.nameKey),
      cronExpression: tpl.cron,
      description: t(tpl.descKey),
      handlerType: tpl.handlerType,
      enabled: true,
    });
  };

  const saveTask = async () => {
    if (!form.name || !form.cronExpression) {
      setMessage(t("cron.name_cron_required"));
      return;
    }
    try {
      const res = await fetch("/api/scheduler/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setMessage(t("cron.created_ok"));
        setShowModal(false);
        setForm({ name: "", cronExpression: "", description: "", handlerType: "system", enabled: true });
        loadTasks();
      } else {
        const errorData = await res.json().catch(() => ({ error: "Unknown error" }));
        setMessage(`${t("cron.create_fail")}: ${errorData.error || res.statusText}`);
      }
    } catch {
      setMessage(t("cron.network_error"));
    }
    scheduleClearMessage();
  };

  const toggleTask = async (taskId: string, enabled: boolean) => {
    try {
      await fetch(`/api/scheduler/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      loadTasks();
    } catch (err) {
      console.error("Failed to toggle task:", err);
      setMessage(t("cron.network_error"));
      scheduleClearMessage();
    }
  };

  const deleteTask = async (taskId: string) => {
    try {
      await fetch(`/api/scheduler/tasks/${taskId}`, { method: "DELETE" });
      loadTasks();
    } catch (err) {
      console.error("Failed to delete task:", err);
      setMessage(t("cron.network_error"));
      scheduleClearMessage();
    }
  };

  const runTask = async (taskId: string) => {
    try {
      await fetch(`/api/scheduler/tasks/${taskId}/run`, { method: "POST" });
      setMessage(t("cron.triggered"));
      scheduleClearMessage();
      loadTasks();
    } catch (err) {
      console.error("Failed to run task:", err);
      setMessage(t("cron.network_error"));
      scheduleClearMessage();
    }
  };

  const isErrorMsg = lang === "zh"
    ? message.includes("失败") || message.includes("错误")
    : /fail|error/i.test(message);

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>{t("cron.title")}</div>
          <div style={s.subtitle}>{t("cron.subtitle")}</div>
        </div>
        <button style={s.addBtn} onClick={() => setShowModal(true)}>{t("cron.new_task")}</button>
      </div>

      {message && (
        <div style={{
          padding: "8px 14px", borderRadius: "6px", marginBottom: "12px",
          background: isErrorMsg ? "var(--error-bg)" : "var(--success-bg)",
          color: isErrorMsg ? "var(--error)" : "var(--success)",
          fontSize: "12px",
        }}>
          {message}
        </div>
      )}

      {tasks.length === 0 ? (
        <div style={s.empty}>
          {t("cron.empty")}<br />
          <span style={{ fontSize: "11px" }}>{t("cron.empty_hint")}</span>
        </div>
      ) : (
        tasks.map((task) => (
          <div key={task.id} style={s.card}>
            <div style={s.cardHeader}>
              <div>
                <div style={s.cardTitle}>{task.name}</div>
                <div style={s.cardDesc}>{task.description || t("cron.no_desc")}</div>
              </div>
              <span style={cronStatusBadgeStyle(task.enabled)}>{task.enabled ? t("cron.enabled") : t("cron.disabled")}</span>
            </div>
            <div style={s.cronBadge}>{task.cronExpression}</div>
            <div style={s.metaRow}>
              <div style={s.metaItem}>
                {t("cron.type")}: <span style={s.metaValue}>{task.handlerType}</span>
              </div>
              <div style={s.metaItem}>
                {t("cron.run_count")}: <span style={s.metaValue}>{task.runCount || 0}</span>
              </div>
              <div style={s.metaItem}>
                {t("cron.error_count")}: <span style={{ ...s.metaValue, color: task.errorCount > 0 ? "var(--error)" : "var(--text-secondary)" }}>{task.errorCount || 0}</span>
              </div>
              <div style={s.metaItem}>
                {t("cron.last_run")}: <span style={s.metaValue}>{task.lastRun ? new Date(task.lastRun).toLocaleString() : t("cron.never")}</span>
              </div>
              <div style={s.metaItem}>
                {t("cron.next_run")}: <span style={s.metaValue}>{task.nextRun ? new Date(task.nextRun).toLocaleString() : t("cron.calculating")}</span>
              </div>
            </div>
            <div style={s.actionBtns}>
              <button style={s.actionBtn} onClick={() => toggleTask(task.id, task.enabled)}>
                {task.enabled ? t("cron.disable") : t("cron.enable")}
              </button>
              <button style={s.actionBtn} onClick={() => runTask(task.id)}>{t("cron.run_now")}</button>
              <button style={s.dangerBtn} onClick={() => deleteTask(task.id)}>{t("cron.delete")}</button>
            </div>
          </div>
        ))
      )}

      {/* Create Modal */}
      {showModal && (
        <div style={s.modal} onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div style={s.modalCard}>
            <div style={s.modalTitle}>{t("cron.modal_title")}</div>

            {/* Templates */}
            <div style={s.templateSection}>
              <div style={{ color: "var(--text-muted)", fontSize: "11px", fontWeight: "bold", marginBottom: "8px" }}>
                {t("cron.template_title")}
              </div>
              <div style={s.templateGrid}>
                {CRON_TEMPLATES.map((tpl, i) => (
                  <div key={i} style={s.templateCard} onClick={() => applyTemplate(tpl)}>
                    <div style={s.templateName}>{t(tpl.nameKey)}</div>
                    <div style={s.templateDesc}>{t(tpl.descKey)}</div>
                    <div style={s.templateCron}>{tpl.cron}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>{t("cron.task_name_label")}</label>
              <input style={s.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("cron.task_name_placeholder")} />
            </div>
            <div style={s.field}>
              <label style={s.label}>{t("cron.cron_label")}</label>
              <input style={s.input} value={form.cronExpression} onChange={(e) => setForm({ ...form, cronExpression: e.target.value })} placeholder={t("cron.cron_placeholder")} />
              <div style={s.helpText}>{t("cron.cron_help")}</div>
            </div>
            <div style={s.field}>
              <label style={s.label}>{t("cron.desc_label")}</label>
              <input style={s.input} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t("cron.desc_placeholder")} />
            </div>
            <div style={s.field}>
              <label style={s.label}>{t("cron.handler_label")}</label>
              <select style={s.select} value={form.handlerType} onChange={(e) => setForm({ ...form, handlerType: e.target.value })}>
                <option value="system">{t("cron.handler_system")}</option>
                <option value="skills">{t("cron.handler_skills")}</option>
                <option value="memory">{t("cron.handler_memory")}</option>
                <option value="chat">{t("cron.handler_chat")}</option>
                <option value="custom">{t("cron.handler_custom")}</option>
              </select>
            </div>
            <div style={s.field}>
              <div style={s.checkbox}>
                <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} id="cron-enabled" />
                <label htmlFor="cron-enabled" style={{ color: "var(--text-secondary)", fontSize: "12px", cursor: "pointer" }}>{t("cron.enable_checkbox")}</label>
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
              <button style={s.addBtn} onClick={saveTask}>{t("cron.create_btn")}</button>
              <button style={s.actionBtn} onClick={() => setShowModal(false)}>{t("cron.cancel")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}