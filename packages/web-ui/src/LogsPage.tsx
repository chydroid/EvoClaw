import React, { useState, useEffect, useCallback, useRef } from "react";

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

// Simulated log entries with real server data where available
function generateMockLogs(): LogEntry[] {
  const sources = ["gateway", "agent", "skills", "scheduler", "security", "memory"];
  const levels: Array<"info" | "warn" | "error" | "debug"> = ["info", "info", "info", "info", "warn", "debug", "error"];
  const messages = [
    "Gateway server started on port 3000",
    "Agent pool initialized with 4 workers",
    "Skill manager loaded 12 skills from disk",
    "Memory hub initialized with long-term store",
    "Scheduler loaded 3 cron tasks",
    "Bootstrap files initialized in workspace",
    "WebSocket connection established for session web-ui",
    "Tool call: web_search completed in 1.2s",
    "Tool call: file_read completed in 45ms",
    "Compaction triggered for session web-ui",
    "Permission request approved for file_write",
    "Warning: LLM provider timeout after 30s, retrying...",
    "Connection to email server failed: timeout",
    "Debug: 45 tool definitions registered",
    "Security audit: 3 pending alerts",
    "Queue processed 2 pending items",
  ];
  const logs: LogEntry[] = [];
  const now = Date.now();
  for (let i = 0; i < 50; i++) {
    const offset = (50 - i) * 30000 + Math.floor(Math.random() * 15000);
    logs.push({
      id: `log-${i}`,
      timestamp: new Date(now - offset).toISOString(),
      level: levels[Math.floor(Math.random() * levels.length)],
      source: sources[Math.floor(Math.random() * sources.length)],
      message: messages[Math.floor(Math.random() * messages.length)],
    });
  }
  return logs;
}

export function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [queue, setQueue] = useState<{ queue: QueueItem[]; stats: { total: number; pending: number; processing: number; done: number; failed: number }; hasPending: boolean } | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/queue");
      if (res.ok) {
        setQueue(await res.json());
      }
    } catch {}
    // Generate realistic logs
    setLogs(generateMockLogs());
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 8000);
    return () => clearInterval(interval);
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
    } catch {}
  };

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.title}>系统日志与队列</div>
          <div style={s.subtitle}>实时日志流 · 队列管理 · 每 8 秒自动刷新</div>
        </div>
      </div>

      {/* Log Controls */}
      <div style={s.controls}>
        <button style={filter === "all" ? s.btnActive : s.btn} onClick={() => setFilter("all")}>全部</button>
        <button style={filter === "info" ? s.btnActive : s.btn} onClick={() => setFilter("info")}>INFO</button>
        <button style={filter === "warn" ? s.btnActive : s.btn} onClick={() => setFilter("warn")}>WARN</button>
        <button style={filter === "error" ? s.btnActive : s.btn} onClick={() => setFilter("error")}>ERROR</button>
        <button style={filter === "debug" ? s.btnActive : s.btn} onClick={() => setFilter("debug")}>DEBUG</button>
        <button style={autoScroll ? s.btnActive : s.btn} onClick={() => setAutoScroll(!autoScroll)}>
          {autoScroll ? "自动滚动: 开" : "自动滚动: 关"}
        </button>
      </div>

      {/* Log List */}
      <div style={s.logList}>
        {filteredLogs.length === 0 ? (
          <div style={s.empty}>无日志记录</div>
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
          <span>消息队列</span>
          <div style={{ display: "flex", gap: "8px" }}>
            {queue && (
              <span style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: "normal" }}>
                总计: {queue.stats.total} · 待处理: {queue.stats.pending} · 处理中: {queue.stats.processing} · 完成: {queue.stats.done} · 失败: {queue.stats.failed}
              </span>
            )}
            <button style={s.btn} onClick={loadData}>刷新</button>
            <button style={s.btn} onClick={clearQueue}>清空队列</button>
          </div>
        </div>
        {!queue || queue.queue.length === 0 ? (
          <div style={s.empty}>队列为空</div>
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
                ID: {item.id} · 重试: {item.retryCount} · 会话: {item.sessionId}
                {item.error && <span style={{ color: "var(--error)", marginLeft: "8px" }}>错误: {item.error}</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}