import React, { useState, useEffect, useCallback, useRef } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "./i18n";

interface QueueItem {
  id: string;
  sessionId: string;
  mode: string;
  message: string;
  priority: number;
  createdAt: string;
  retryCount: number;
  maxRetries: number;
  status: "pending" | "processing" | "done" | "failed";
  result?: string;
  error?: string;
}

const styles: Record<string, CSSProperties> = {
  container: {
    padding: "24px",
    maxWidth: "900px",
    margin: "0 auto",
    color: "var(--text-primary, #c9d1d9)",
  },
  title: {
    fontSize: "20px",
    fontWeight: 700,
    marginBottom: "20px",
    color: "var(--text-primary, #c9d1d9)",
  },
  empty: {
    textAlign: "center",
    padding: "60px 20px",
    color: "var(--text-secondary, #8b949e)",
    fontSize: "14px",
  },
  sessionCard: {
    background: "var(--bg-secondary, #161b22)",
    border: "1px solid var(--border, #30363d)",
    borderRadius: "10px",
    marginBottom: "16px",
    overflow: "hidden",
  },
  sessionHeader: {
    padding: "12px 16px",
    background: "var(--bg-tertiary, #21262d)",
    borderBottom: "1px solid var(--border, #30363d)",
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--text-primary, #c9d1d9)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  queueList: {
    listStyle: "none",
    padding: 0,
    margin: 0,
  },
  queueItem: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 16px",
    borderBottom: "1px solid var(--border, #30363d)",
    cursor: "grab",
    transition: "background 0.15s",
  },
  queueItemDragging: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 16px",
    borderBottom: "1px solid var(--border, #30363d)",
    cursor: "grabbing",
    background: "var(--bg-tertiary, #21262d)",
    opacity: 0.6,
  },
  dragHandle: {
    color: "var(--text-muted, #6e7681)",
    fontSize: "14px",
    flexShrink: 0,
    cursor: "grab",
  },
  orderControls: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    flexShrink: 0,
  },
  orderBtn: {
    width: "20px",
    height: "16px",
    border: "none",
    background: "transparent",
    color: "var(--text-muted, #6e7681)",
    cursor: "pointer",
    fontSize: "10px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "2px",
  },
  itemNumber: {
    color: "var(--text-muted, #6e7681)",
    fontSize: "11px",
    flexShrink: 0,
    width: "22px",
  },
  itemMessage: {
    flex: 1,
    fontSize: "13px",
    color: "var(--text-primary, #c9d1d9)",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  itemMessageEditing: {
    flex: 1,
    fontSize: "13px",
    minWidth: 0,
    padding: "4px 8px",
    background: "var(--bg-primary, #0d1117)",
    border: "1px solid var(--accent, #58a6ff)",
    borderRadius: "4px",
    color: "var(--text-primary, #c9d1d9)",
    outline: "none",
  },
  statusBadge: {
    fontSize: "11px",
    padding: "2px 8px",
    borderRadius: "10px",
    fontWeight: 600,
    flexShrink: 0,
  },
  actionBtn: {
    width: "26px",
    height: "26px",
    border: "none",
    background: "transparent",
    color: "var(--text-muted, #6e7681)",
    cursor: "pointer",
    fontSize: "13px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "4px",
    flexShrink: 0,
  },
  addForm: {
    display: "flex",
    gap: "8px",
    padding: "12px 16px",
    borderTop: "1px solid var(--border, #30363d)",
    background: "var(--bg-secondary, #161b22)",
  },
  addInput: {
    flex: 1,
    padding: "8px 12px",
    background: "var(--bg-primary, #0d1117)",
    border: "1px solid var(--border, #30363d)",
    borderRadius: "6px",
    color: "var(--text-primary, #c9d1d9)",
    fontSize: "13px",
    outline: "none",
  },
  addSelect: {
    padding: "8px 12px",
    background: "var(--bg-primary, #0d1117)",
    border: "1px solid var(--border, #30363d)",
    borderRadius: "6px",
    color: "var(--text-primary, #c9d1d9)",
    fontSize: "13px",
    outline: "none",
  },
  addBtn: {
    padding: "8px 16px",
    background: "var(--accent, #1f6feb)",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  refreshBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "16px",
  },
  refreshBtn: {
    padding: "6px 14px",
    background: "var(--bg-tertiary, #21262d)",
    border: "1px solid var(--border, #30363d)",
    borderRadius: "6px",
    color: "var(--text-primary, #c9d1d9)",
    cursor: "pointer",
    fontSize: "12px",
  },
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: "#1a2332", text: "#58a6ff" },
  processing: { bg: "#2a1f00", text: "#d29922" },
  done: { bg: "#0d2a1a", text: "#3fb950" },
  failed: { bg: "#2d1518", text: "#f85149" },
};

export default function QueueManagerPage() {
  const { t, lang } = useTranslation();

  function formatTime(iso: string | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  const [allQueues, setAllQueues] = useState<Record<string, QueueItem[]>>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Per-session new message form state
  const [newMessages, setNewMessages] = useState<Record<string, string>>({});
  const [newModes, setNewModes] = useState<Record<string, string>>({});

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Drag state
  const dragItemRef = useRef<number | null>(null);
  const dragSessionRef = useRef<string | null>(null);

  const fetchQueues = useCallback(async () => {
    try {
      const res = await fetch("/api/queue");
      const data = await res.json();
      if (data.success) {
        setAllQueues(data.sessions || {});
      }
    } catch (err) {
      console.error("Failed to fetch queues:", err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchQueues();
    const interval = setInterval(fetchQueues, 5000);
    return () => clearInterval(interval);
  }, [fetchQueues]);

  const showMsg = (type: "success" | "error", text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  };

  const handleDelete = async (itemId: string) => {
    try {
      const res = await fetch(`/api/queue/${encodeURIComponent(itemId)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showMsg("success", t("queue.deleted", "已删除"));
        fetchQueues();
      } else {
        showMsg("error", data.error || t("queue.delete_fail", "删除失败"));
      }
    } catch {
      showMsg("error", t("queue.delete_fail", "删除失败"));
    }
  };

  const handleMove = async (sessionId: string, itemId: string, direction: "up" | "down") => {
    try {
      await fetch("/api/queue/move", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, itemId, direction }),
      });
      fetchQueues();
    } catch {
      showMsg("error", t("queue.move_fail", "移动失败"));
    }
  };

  const handleEdit = (item: QueueItem) => {
    setEditingId(item.id);
    setEditValue(item.message);
  };

  const handleSaveEdit = async (sessionId: string, itemId: string) => {
    if (!editValue.trim()) return;
    try {
      const res = await fetch(`/api/queue/${encodeURIComponent(itemId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: editValue.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setEditingId(null);
        setEditValue("");
        showMsg("success", t("queue.updated", "已更新"));
        fetchQueues();
      } else {
        showMsg("error", data.error || t("queue.update_fail", "更新失败"));
      }
    } catch {
      showMsg("error", t("queue.update_fail", "更新失败"));
    }
  };

  const handleAddToSession = async (sessionId: string) => {
    const msg = (newMessages[sessionId] || "").trim();
    if (!msg) return;
    const mode = newModes[sessionId] || "followup";

    try {
      const res = await fetch("/api/queue/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: msg, mode }),
      });
      const data = await res.json();
      if (data.success) {
        setNewMessages((prev) => ({ ...prev, [sessionId]: "" }));
        showMsg("success", t("queue.added", "已添加"));
        fetchQueues();
      } else {
        showMsg("error", data.error || t("queue.add_fail", "添加失败"));
      }
    } catch {
      showMsg("error", t("queue.add_fail", "添加失败"));
    }
  };

  // Drag and drop
  const handleDragStart = (sessionId: string, index: number) => {
    dragSessionRef.current = sessionId;
    dragItemRef.current = index;
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDragEnd = () => {
    dragItemRef.current = null;
    dragSessionRef.current = null;
  };

  const handleDrop = async (sessionId: string, dropIndex: number) => {
    const dragIndex = dragItemRef.current;
    if (dragIndex === null || dragIndex === dropIndex || dragSessionRef.current !== sessionId) return;

    const queue = [...(allQueues[sessionId] || [])];
    const [movedItem] = queue.splice(dragIndex, 1);
    queue.splice(dropIndex, 0, movedItem);

    // Update local state immediately
    setAllQueues((prev) => ({ ...prev, [sessionId]: queue }));

    const orderedIds = queue.map((q) => q.id);
    try {
      await fetch("/api/queue/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, orderedIds }),
      });
    } catch {
      showMsg("error", t("queue.reorder_fail", "排序失败"));
      fetchQueues(); // Revert
    }

    handleDragEnd();
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.title}>{t("queue.title", "消息队列管理")}</div>
        <div style={{ color: "var(--text-secondary, #8b949e)", textAlign: "center", padding: "40px" }}>{t("sessions.loading", "加载中...")}</div>
      </div>
    );
  }

  const sessionIds = Object.keys(allQueues);

  return (
    <div style={styles.container}>
      <div style={styles.refreshBar}>
        <div style={styles.title}>{t("queue.title", "消息队列管理")}</div>
        <button style={styles.refreshBtn} onClick={fetchQueues}>
          {t("queue.refresh", "🔄 刷新")}
        </button>
      </div>

      {message && (
        <div style={{
          padding: "8px 14px", marginBottom: "16px", borderRadius: "6px", fontSize: "13px",
          background: message.type === "success" ? "rgba(63,185,80,0.15)" : "rgba(248,81,73,0.15)",
          color: message.type === "success" ? "#3fb950" : "#f85149",
          border: `1px solid ${message.type === "success" ? "rgba(63,185,80,0.3)" : "rgba(248,81,73,0.3)"}`,
        }}>
          {message.text}
        </div>
      )}

      {sessionIds.length === 0 && (
        <div style={styles.empty}>
          <div style={{ fontSize: "36px", marginBottom: "12px" }}>📭</div>
          <div>{t("queue.empty", "暂无消息队列")}</div>
          <div style={{ fontSize: "12px", marginTop: "8px", color: "var(--text-muted, #6e7681)" }}>
            {t("queue.empty_hint", "在聊天页面执行任务时，点击停止按钮旁的 📋 按钮将消息加入队列")}
          </div>
        </div>
      )}

      {sessionIds.map((sessionId) => {
        const queue = allQueues[sessionId] || [];
        const pendingCount = queue.filter((q) => q.status === "pending").length;

        return (
          <div key={sessionId} style={styles.sessionCard}>
            <div style={styles.sessionHeader}>
              <span>{t("queue.session_header", "会话: {0}").replace("{0}", sessionId.slice(0, 12))}...</span>
              <span style={{ color: "var(--text-secondary, #8b949e)", fontSize: "12px" }}>
                {t("queue.message_count", "{0} 条消息 ({1} 等待中)").replace("{0}", String(queue.length)).replace("{1}", String(pendingCount))}
              </span>
            </div>

            {queue.length > 0 && (
              <ul style={styles.queueList}>
                {queue.map((item, index) => {
                  const isEditing = editingId === item.id;
                  const statusStyle = STATUS_COLORS[item.status] || STATUS_COLORS.pending;
                  const statusLabelMap: Record<string, string> = {
                    pending: t("queue.status_pending", "等待中"),
                    processing: t("queue.status_processing", "发送中"),
                    done: t("queue.status_done", "已完成"),
                    failed: t("queue.status_failed", "失败"),
                  };

                  return (
                    <li
                      key={item.id}
                      style={dragItemRef.current === index && dragSessionRef.current === sessionId ? styles.queueItemDragging : styles.queueItem}
                      draggable={item.status === "pending"}
                      onDragStart={() => item.status === "pending" && handleDragStart(sessionId, index)}
                      onDragOver={handleDragOver}
                      onDrop={() => handleDrop(sessionId, index)}
                      onDragEnd={handleDragEnd}
                    >
                      {/* Order controls */}
                      {item.status === "pending" && (
                        <div style={styles.orderControls}>
                          <button
                            style={styles.orderBtn}
                            title={t("queue.move_up", "上移")}
                            onClick={() => handleMove(sessionId, item.id, "up")}
                            disabled={index === 0}
                          >
                            ▲
                          </button>
                          <button
                            style={styles.orderBtn}
                            title={t("queue.move_down", "下移")}
                            onClick={() => handleMove(sessionId, item.id, "down")}
                            disabled={index === queue.length - 1}
                          >
                            ▼
                          </button>
                        </div>
                      )}

                      {item.status !== "pending" && <div style={{ width: "20px", flexShrink: 0 }} />}

                      {/* Drag handle */}
                      {item.status === "pending" && (
                        <span style={styles.dragHandle}>⋮⋮</span>
                      )}

                      {/* Index */}
                      <span style={styles.itemNumber}>#{index + 1}</span>

                      {/* Message */}
                      {isEditing ? (
                        <input
                          style={styles.itemMessageEditing}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSaveEdit(sessionId, item.id);
                            if (e.key === "Escape") { setEditingId(null); setEditValue(""); }
                          }}
                          onBlur={() => handleSaveEdit(sessionId, item.id)}
                          autoFocus
                        />
                      ) : (
                        <span style={styles.itemMessage} title={item.message}>
                          {item.message}
                        </span>
                      )}

                      {/* Status */}
                      <span style={{
                        ...styles.statusBadge,
                        background: statusStyle.bg,
                        color: statusStyle.text,
                      }}>
                        {statusLabelMap[item.status] || item.status}
                      </span>

                      {/* Time */}
                      <span style={{ fontSize: "11px", color: "var(--text-muted, #6e7681)", flexShrink: 0 }}>
                        {formatTime(item.createdAt)}
                      </span>

                      {/* Actions */}
                      {item.status === "pending" && (
                        <>
                          <button
                            style={styles.actionBtn}
                            title={t("queue.edit", "编辑")}
                            onClick={() => handleEdit(item)}
                            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary, #21262d)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                          >
                            ✏️
                          </button>
                          <button
                            style={styles.actionBtn}
                            title={t("app.delete", "删除")}
                            onClick={() => handleDelete(item.id)}
                            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(248,81,73,0.15)"; e.currentTarget.style.color = "#f85149"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted, #6e7681)"; }}
                          >
                            🗑️
                          </button>
                        </>
                      )}

                      {item.status === "done" && (
                        <button
                          style={styles.actionBtn}
                          title={t("app.delete", "删除")}
                          onClick={() => handleDelete(item.id)}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(248,81,73,0.15)"; e.currentTarget.style.color = "#f85149"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted, #6e7681)"; }}
                        >
                          🗑️
                        </button>
                      )}

                      {item.status === "failed" && (
                        <>
                          <span style={{ fontSize: "10px", color: "#f85149", maxWidth: "100px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.error}>
                            {item.error || t("queue.status_failed", "失败")}
                          </span>
                          <button
                            style={styles.actionBtn}
                            title={t("app.delete", "删除")}
                            onClick={() => handleDelete(item.id)}
                            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(248,81,73,0.15)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                          >
                            🗑️
                          </button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Add new message form */}
            <div style={styles.addForm}>
              <select
                style={styles.addSelect}
                value={newModes[sessionId] || "followup"}
                onChange={(e) => setNewModes((prev) => ({ ...prev, [sessionId]: e.target.value }))}
              >
                <option value="followup">{t("queue.mode_followup", "后续")}</option>
                <option value="steer">{t("queue.mode_steer", "引导")}</option>
                <option value="collect">{t("queue.mode_collect", "收集")}</option>
              </select>
              <input
                style={styles.addInput}
                placeholder={t("queue.new_message_placeholder", "输入新消息...")}
                value={newMessages[sessionId] || ""}
                onChange={(e) => setNewMessages((prev) => ({ ...prev, [sessionId]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddToSession(sessionId);
                }}
              />
              <button
                style={styles.addBtn}
                onClick={() => handleAddToSession(sessionId)}
                disabled={!newMessages[sessionId]?.trim()}
              >
                {t("queue.add", "+ 添加")}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}