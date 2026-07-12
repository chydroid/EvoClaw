import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "./i18n";

interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
}

interface QueueItem {
  id: string;
  sessionId: string;
  mode: string;
  message: string;
  priority: number;
  createdAt: string;
  status: string;
  retryCount: number;
  result?: string;
  error?: string;
}

const logLevelStyle = (level: string): React.CSSProperties => ({
  fontWeight: "bold", fontSize: "11px", minWidth: "45px", textTransform: "uppercase" as const,
  color: level === "error" ? "var(--error)" : level === "warn" ? "var(--warning)" : level === "debug" ? "var(--text-muted)" : "var(--text-secondary)",
});

const queueModeStyle = (mode: string): React.CSSProperties => ({
  padding: "2px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: "bold", textTransform: "uppercase" as const,
  background: mode === "interrupt" ? "var(--error-bg)" : mode === "steer" ? "var(--accent-bg)" : mode === "followup" ? "var(--warning-bg)" : "var(--bg-hover)",
  color: mode === "interrupt" ? "var(--error)" : mode === "steer" ? "var(--accent)" : mode === "followup" ? "var(--warning)" : "var(--text-muted)",
});

const queueStatusStyle = (status: string): React.CSSProperties => ({
  padding: "2px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: "bold",
  background: status === "done" ? "var(--success-bg)" : status === "failed" ? "var(--error-bg)" : status === "processing" ? "var(--accent-bg)" : "var(--bg-hover)",
  color: status === "done" ? "var(--success)" : status === "failed" ? "var(--error)" : status === "processing" ? "var(--accent)" : "var(--text-muted)",
});

const s: Record<string, React.CSSProperties> = {
  container: { padding: "20px", height: "100%", overflow: "auto", background: "var(--bg-secondary)" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" },
  title: { color: "var(--section-title-color)", fontSize: "18px", fontWeight: "bold" },
  subtitle: { color: "var(--text-muted)", fontSize: "12px", marginTop: "4px" },
  controls: { display: "flex", gap: "8px", marginBottom: "16px" },
  btn: {
    padding: "6px 14px", borderRadius: "6px", border: "1px solid var(--border-light)", cursor: "pointer",
    background: "var(--bg-card)", color: "var(--text-secondary)", fontSize: "12px",
  },
  btnActive: {
    padding: "6px 14px", borderRadius: "6px", border: "none", cursor: "pointer",
    background: "var(--accent)", color: "#fff", fontSize: "12px", fontWeight: "bold",
  },
  logList: {
    background: "var(--bg-card)", borderRadius: "8px", border: "1px solid var(--border-light)",
    maxHeight: "calc(100vh - 280px)", overflow: "auto", fontFamily: "Consolas, Monaco, monospace",
  },
  logEntry: { padding: "4px 14px", fontSize: "12px", borderBottom: "1px solid var(--border-light)", display: "flex", gap: "10px", alignItems: "flex-start" },
  logTime: { color: "var(--text-muted)", fontSize: "11px", whiteSpace: "nowrap" as const, minWidth: "75px" },
  logSource: { color: "var(--accent)", fontSize: "11px", minWidth: "100px", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" },
  logMsg: { color: "var(--text-primary)", fontSize: "12px", flex: 1, wordBreak: "break-all" as const },
  queueSection: { marginTop: "24px" },
  sectionTitle: { color: "var(--text-primary)", fontSize: "14px", fontWeight: "bold", marginBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" },
  queueCard: {
    background: "var(--bg-card)", borderRadius: "8px", border: "1px solid var(--border-light)",
    padding: "12px", marginBottom: "8px",
  },
  queueHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" },
  queueMsg: { color: "var(--text-primary)", fontSize: "12px" },
  queueMeta: { color: "var(--text-muted)", fontSize: "10px", marginTop: "4px" },
  empty: { color: "var(--text-muted)", fontSize: "13px", padding: "24px", textAlign: "center" as const },
};

// 真实日志由后端 API 提供；无 API 时显示空状态，不再生成模拟日志误导用户

export function LogsPage() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [queue, setQueue] = useState<{ queue: QueueItem[]; stats: { total: number; pending: number; processing: number; done: number; failed: number }; hasPending: boolean } | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const loadData = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/queue", { signal });
      if (signal?.aborted) return;
      if (res.ok) {
        const data = await res.json();
        // Backend returns { success, sessions: Record<string, QueueItem[]> }
        // Flatten sessions map into a single queue list and compute stats
        // client-side so this page works without a dedicated stats endpoint.
        const sessionsMap: Record<string, QueueItem[]> = data.sessions || {};
        const allItems: QueueItem[] = [];
        for (const sid of Object.keys(sessionsMap)) {
          const items = sessionsMap[sid] || [];
          for (const item of items) {
            // Backend may omit sessionId on per-session items; derive from key
            if (!item.sessionId) item.sessionId = sid;
            allItems.push(item);
          }
        }
        // Newest first (matching previous behavior)
        allItems.sort((a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        const stats = {
          total: allItems.length,
          pending: allItems.filter(i => i.status === "pending").length,
          processing: allItems.filter(i => i.status === "processing").length,
          done: allItems.filter(i => i.status === "done").length,
          failed: allItems.filter(i => i.status === "failed").length,
        };
        setQueue({
          queue: allItems,
          stats,
          hasPending: stats.pending > 0,
        });
      }
    } catch (err) {
      if (signal?.aborted) return;
      console.error("Failed to load queue data:", err);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    loadData(controller.signal);
    const interval = setInterval(() => loadData(controller.signal), 8000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [loadData]);

  useEffect(() => {
    if (autoScroll) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll]);

  const filteredLogs = filter === "all" ? logs : logs.filter(l => l.level === filter);

  const clearQueue = async () => {
    try {
      await fetch("/api/queue/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "web-ui" }) });
      loadData();
    } catch (err) {
      console.error("Failed to clear queue:", err);
    }
  };

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>{t("logs.logs_queue_title")}</div>
          <div style={s.subtitle}>{t("logs.logs_queue_subtitle")}</div>
        </div>
      </div>

      {/* Log Controls */}
      <div style={s.controls}>
        <button style={filter === "all" ? s.btnActive : s.btn} onClick={() => setFilter("all")}>{t("logs.filter_all")}</button>
        <button style={filter === "info" ? s.btnActive : s.btn} onClick={() => setFilter("info")}>INFO</button>
        <button style={filter === "warn" ? s.btnActive : s.btn} onClick={() => setFilter("warn")}>WARN</button>
        <button style={filter === "error" ? s.btnActive : s.btn} onClick={() => setFilter("error")}>ERROR</button>
        <button style={filter === "debug" ? s.btnActive : s.btn} onClick={() => setFilter("debug")}>DEBUG</button>
        <button style={autoScroll ? s.btnActive : s.btn} onClick={() => setAutoScroll(!autoScroll)}>
          {autoScroll ? t("logs.auto_scroll_on") : t("logs.auto_scroll_off")}
        </button>
      </div>

      {/* Log List */}
      <div style={s.logList}>
        {filteredLogs.length === 0 ? (
          <div style={s.empty}>{t("logs.no_log_records")}</div>
        ) : (
          filteredLogs.map((log) => (
            <div key={log.id} style={s.logEntry}>
              <span style={s.logTime}>{new Date(log.timestamp).toLocaleTimeString()}</span>
              <span style={logLevelStyle(log.level)}>{log.level}</span>
              <span style={s.logSource}>{log.source}</span>
              <span style={s.logMsg}>{log.message}</span>
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>

      {/* Queue Section */}
      <div style={s.queueSection}>
        <div style={s.sectionTitle}>
          <span>{t("logs.queue_header")}</span>
          <div style={{ display: "flex", gap: "8px" }}>
            {queue?.stats && (
              <span style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: "normal" }}>
                {t("logs.total")}: {queue.stats.total} · {t("logs.pending")}: {queue.stats.pending} · {t("logs.processing")}: {queue.stats.processing} · {t("logs.done")}: {queue.stats.done} · {t("logs.failed")}: {queue.stats.failed}
              </span>
            )}
            <button style={s.btn} onClick={() => loadData()}>{t("logs.refresh")}</button>
            <button style={s.btn} onClick={clearQueue}>{t("logs.clear_queue")}</button>
          </div>
        </div>
        {!queue?.queue || queue.queue.length === 0 ? (
          <div style={s.empty}>{t("logs.queue_empty")}</div>
        ) : (
          queue.queue.slice(0, 20).map((item) => (
            <div key={item.id} style={s.queueCard}>
              <div style={s.queueHeader}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <span style={queueModeStyle(item.mode)}>{item.mode}</span>
                  <span style={queueStatusStyle(item.status)}>{item.status}</span>
                  <span style={{ color: "var(--text-muted)", fontSize: "10px" }}>P{item.priority}</span>
                </div>
                <span style={{ color: "var(--text-muted)", fontSize: "10px" }}>
                  {new Date(item.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div style={s.queueMsg}>{item.message}</div>
              <div style={s.queueMeta}>
                {t("logs.id_label")}: {item.id} · {t("logs.retry")}: {item.retryCount} · {t("logs.session")}: {item.sessionId}
                {item.error && <span style={{ color: "var(--error)", marginLeft: "8px" }}>{t("logs.error_label")}: {item.error}</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}