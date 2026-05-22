import React, { useState, useEffect, useCallback } from "react";

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
  { name: "每30分钟心跳检查", cron: "*/30 * * * *", desc: "定期检查Agent心跳状态", handlerType: "system" },
  { name: "每日技能刷新", cron: "0 2 * * *", desc: "每天凌晨2点刷新技能列表", handlerType: "skills" },
  { name: "每小时记忆清理", cron: "0 * * * *", desc: "每小时清理过期记忆条目", handlerType: "memory" },
  { name: "每6小时用户问候", cron: "0 */6 * * *", desc: "定期向用户发送问候", handlerType: "chat" },
  { name: "每日日志归档", cron: "0 3 * * *", desc: "每天凌晨3点归档日志", handlerType: "system" },
  { name: "每15分钟健康检查", cron: "*/15 * * * *", desc: "检查所有服务健康状态", handlerType: "system" },
];

interface TaskForm {
  name: string;
  cronExpression: string;
  description: string;
  handlerType: string;
  enabled: boolean;
}

export function CronPage() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<TaskForm>({
    name: "", cronExpression: "", description: "", handlerType: "system", enabled: true,
  });
  const [message, setMessage] = useState("");

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/scheduler/tasks");
      if (res.ok) {
        const data = await res.json();
        setTasks(Array.isArray(data.tasks) ? data.tasks : []);
      }
    } catch {
      // Scheduler API may not be available yet
    }
  }, []);

  useEffect(() => {
    loadTasks();
    const interval = setInterval(loadTasks, 10000);
    return () => clearInterval(interval);
  }, [loadTasks]);

  const applyTemplate = (tpl: typeof CRON_TEMPLATES[0]) => {
    setForm({
      name: tpl.name,
      cronExpression: tpl.cron,
      description: tpl.desc,
      handlerType: tpl.handlerType,
      enabled: true,
    });
  };

  const saveTask = async () => {
    if (!form.name || !form.cronExpression) {
      setMessage("名称和 Cron 表达式为必填项");
      return;
    }
    try {
      const res = await fetch("/api/scheduler/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setMessage("任务已创建");
        setShowModal(false);
        setForm({ name: "", cronExpression: "", description: "", handlerType: "system", enabled: true });
        loadTasks();
      } else {
        setMessage("创建失败");
      }
    } catch {
      setMessage("网络错误");
    }
    setTimeout(() => setMessage(""), 3000);
  };

  const toggleTask = async (taskId: string, enabled: boolean) => {
    try {
      await fetch(`/api/scheduler/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      loadTasks();
    } catch {}
  };

  const deleteTask = async (taskId: string) => {
    try {
      await fetch(`/api/scheduler/tasks/${taskId}`, { method: "DELETE" });
      loadTasks();
    } catch {}
  };

  const runTask = async (taskId: string) => {
    try {
      await fetch(`/api/scheduler/tasks/${taskId}/run`, { method: "POST" });
      setMessage("任务已触发执行");
      setTimeout(() => setMessage(""), 3000);
      loadTasks();
    } catch {}
  };

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>定时任务 (Cron)</div>
          <div style={s.subtitle}>管理定期自动执行的任务 · 支持标准 Cron 表达式</div>
        </div>
        <button style={s.addBtn} onClick={() => setShowModal(true)}>+ 新建任务</button>
      </div>

      {message && (
        <div style={{
          padding: "8px 14px", borderRadius: "6px", marginBottom: "12px",
          background: message.includes("失败") || message.includes("错误") ? "var(--error-bg)" : "var(--success-bg)",
          color: message.includes("失败") || message.includes("错误") ? "var(--error)" : "var(--success)",
          fontSize: "12px",
        }}>
          {message}
        </div>
      )}

      {tasks.length === 0 ? (
        <div style={s.empty}>
          暂无定时任务<br />
          <span style={{ fontSize: "11px" }}>点击"+ 新建任务"创建第一个定时任务，或从模板快速创建</span>
        </div>
      ) : (
        tasks.map((task) => (
          <div key={task.id} style={s.card}>
            <div style={s.cardHeader}>
              <div>
                <div style={s.cardTitle}>{task.name}</div>
                <div style={s.cardDesc}>{task.description || "无描述"}</div>
              </div>
              <span style={cronStatusBadgeStyle(task.enabled)}>{task.enabled ? "启用" : "禁用"}</span>
            </div>
            <div style={s.cronBadge}>{task.cronExpression}</div>
            <div style={s.metaRow}>
              <div style={s.metaItem}>
                类型: <span style={s.metaValue}>{task.handlerType}</span>
              </div>
              <div style={s.metaItem}>
                执行次数: <span style={s.metaValue}>{task.runCount || 0}</span>
              </div>
              <div style={s.metaItem}>
                错误次数: <span style={{ ...s.metaValue, color: task.errorCount > 0 ? "var(--error)" : "var(--text-secondary)" }}>{task.errorCount || 0}</span>
              </div>
              <div style={s.metaItem}>
                上次运行: <span style={s.metaValue}>{task.lastRun ? new Date(task.lastRun).toLocaleString() : "从未"}</span>
              </div>
              <div style={s.metaItem}>
                下次运行: <span style={s.metaValue}>{task.nextRun ? new Date(task.nextRun).toLocaleString() : "计算中..."}</span>
              </div>
            </div>
            <div style={s.actionBtns}>
              <button style={s.actionBtn} onClick={() => toggleTask(task.id, task.enabled)}>
                {task.enabled ? "禁用" : "启用"}
              </button>
              <button style={s.actionBtn} onClick={() => runTask(task.id)}>立即执行</button>
              <button style={s.dangerBtn} onClick={() => deleteTask(task.id)}>删除</button>
            </div>
          </div>
        ))
      )}

      {/* Create Modal */}
      {showModal && (
        <div style={s.modal} onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div style={s.modalCard}>
            <div style={s.modalTitle}>新建定时任务</div>

            {/* Templates */}
            <div style={s.templateSection}>
              <div style={{ color: "var(--text-muted)", fontSize: "11px", fontWeight: "bold", marginBottom: "8px" }}>
                快速模板 (点击应用)
              </div>
              <div style={s.templateGrid}>
                {CRON_TEMPLATES.map((tpl, i) => (
                  <div key={i} style={s.templateCard} onClick={() => applyTemplate(tpl)}>
                    <div style={s.templateName}>{tpl.name}</div>
                    <div style={s.templateDesc}>{tpl.desc}</div>
                    <div style={s.templateCron}>{tpl.cron}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>任务名称 *</label>
              <input style={s.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例: 每日技能刷新" />
            </div>
            <div style={s.field}>
              <label style={s.label}>Cron 表达式 *</label>
              <input style={s.input} value={form.cronExpression} onChange={(e) => setForm({ ...form, cronExpression: e.target.value })} placeholder="例: 0 2 * * *" />
              <div style={s.helpText}>格式: 分 时 日 月 周 (例: */30 * * * * = 每30分钟, 0 2 * * * = 每天2:00)</div>
            </div>
            <div style={s.field}>
              <label style={s.label}>描述</label>
              <input style={s.input} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="简要描述此任务" />
            </div>
            <div style={s.field}>
              <label style={s.label}>处理器类型</label>
              <select style={s.select} value={form.handlerType} onChange={(e) => setForm({ ...form, handlerType: e.target.value })}>
                <option value="system">系统任务</option>
                <option value="skills">技能任务</option>
                <option value="memory">记忆任务</option>
                <option value="chat">对话任务</option>
                <option value="custom">自定义</option>
              </select>
            </div>
            <div style={s.field}>
              <div style={s.checkbox}>
                <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} id="cron-enabled" />
                <label htmlFor="cron-enabled" style={{ color: "var(--text-secondary)", fontSize: "12px", cursor: "pointer" }}>创建后立即启用</label>
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
              <button style={s.addBtn} onClick={saveTask}>创建任务</button>
              <button style={s.actionBtn} onClick={() => setShowModal(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}