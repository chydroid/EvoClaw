/**
 * WorkboardPage — Comprehensive Kanban-style workboard dashboard.
 *
 * Features: 5-column board, task CRUD, status change, detail view,
 * auto-refresh, statistics, i18n, CSS variables theming.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Card, Badge, PageHeader, Loading, EmptyState,
  PrimaryButton, SecondaryButton, showToast, Toggle,
  StatsGrid, Section, Modal, ConfirmModal, TextInput,
} from "./shared";
import { useTranslation } from "./i18n";

const API = (window as any).__EVOCLAW_API__ || "";

// ─── Column Definitions ──────────────────────────────────────

const COLUMNS = [
  { id: "backlog", color: "var(--text-muted)" },
  { id: "todo", color: "var(--accent)" },
  { id: "in_progress", color: "var(--warning)" },
  { id: "review", color: "#8b5cf6" },
  { id: "done", color: "var(--success)" },
] as const;

type ColumnId = typeof COLUMNS[number]["id"];

// ─── Priority Config ─────────────────────────────────────────

const PRIORITIES = ["critical", "high", "normal", "low"] as const;
type Priority = typeof PRIORITIES[number];

const PRIORITY_VARIANT: Record<Priority, "error" | "warning" | "info" | "default"> = {
  critical: "error",
  high: "warning",
  normal: "info",
  low: "default",
};

// ─── Task Type ───────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  description?: string;
  priority: Priority;
  status: ColumnId;
  assignee?: string;
  tags?: string[];
  createdAt?: string;
}

// ─── API Helpers ─────────────────────────────────────────────

async function fetchBoard(): Promise<{ tasks: Record<string, Task[]>; stats: { totalTasks: number; activeRuns: number } | null }> {
  const res = await fetch(`${API}/api/workboard`);
  if (!res.ok) throw new Error("Failed to fetch board");
  return res.json();
}

async function createTaskAPI(body: { title: string; description: string; priority: Priority; tags: string[]; status: ColumnId }): Promise<Task> {
  const res = await fetch(`${API}/api/workboard/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to create task");
  return res.json();
}

async function updateTaskStatusAPI(id: string, status: ColumnId): Promise<Task> {
  const res = await fetch(`${API}/api/workboard/tasks/${id}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error("Failed to update status");
  return res.json();
}

async function deleteTaskAPI(id: string): Promise<void> {
  const res = await fetch(`${API}/api/workboard/tasks/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete task");
}

// ─── Main Component ──────────────────────────────────────────

export default function WorkboardPage() {
  const { t, lang } = useTranslation();
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const [boardData, setBoardData] = useState<{ tasks: Record<string, Task[]>; stats: { totalTasks: number; activeRuns: number } | null }>({
    tasks: {},
    stats: null,
  });
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);

  // Create form state
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPriority, setNewPriority] = useState<Priority>("normal");
  const [newTags, setNewTags] = useState("");
  const [creating, setCreating] = useState(false);

  // Status dropdown open state
  const [openStatusMenu, setOpenStatusMenu] = useState<string | null>(null);

  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const data = await fetchBoard();
      setBoardData(data);
      setLastRefresh(new Date());
    } catch {
      // silently ignore on background refresh
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load
  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    if (autoRefresh) {
      refreshTimerRef.current = setInterval(() => refresh(true), 10000);
    }
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [autoRefresh, refresh]);

  // Close status menu on outside click
  useEffect(() => {
    const handler = () => setOpenStatusMenu(null);
    if (openStatusMenu) {
      document.addEventListener("click", handler);
      return () => document.removeEventListener("click", handler);
    }
  }, [openStatusMenu]);

  // ─── Handlers ────────────────────────────────────────────────

  const handleCreateTask = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const tags = newTags.trim()
        ? newTags.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      await createTaskAPI({
        title: newTitle.trim(),
        description: newDescription.trim(),
        priority: newPriority,
        tags,
        status: "todo",
      });
      showToast(t("workboard.task_created_success"), "success");
      setShowCreateModal(false);
      setNewTitle("");
      setNewDescription("");
      setNewPriority("normal");
      setNewTags("");
      refresh();
    } catch {
      showToast(t("workboard.create_fail"), "error");
    } finally {
      setCreating(false);
    }
  };

  const handleStatusChange = async (taskId: string, newStatus: ColumnId) => {
    setOpenStatusMenu(null);
    try {
      await updateTaskStatusAPI(taskId, newStatus);
      showToast(t("workboard.status_updated"), "success");
      refresh();
    } catch {
      showToast(t("workboard.status_update_fail"), "error");
    }
  };

  const handleDeleteTask = async () => {
    if (!deleteTarget) return;
    try {
      await deleteTaskAPI(deleteTarget.id);
      showToast(t("workboard.task_deleted"), "success");
      setDeleteTarget(null);
      setSelectedTask(null);
      refresh();
    } catch {
      showToast(t("workboard.delete_fail"), "error");
    }
  };

  // ─── Compute Stats ───────────────────────────────────────────

  const allTasks = Object.values(boardData.tasks).flat();
  const priorityCounts = PRIORITIES.map((p) => ({
    priority: p,
    count: allTasks.filter((t) => t.priority === p).length,
  }));

  const statsItems = [
    { label: t("workboard.total_tasks"), value: boardData.stats?.totalTasks ?? allTasks.length, color: "var(--text-primary)" },
    { label: t("workboard.active_runs"), value: boardData.stats?.activeRuns ?? 0, color: "var(--accent)" },
    ...priorityCounts.map((pc) => ({
      label: t(`workboard.priority_${pc.priority}`),
      value: pc.count,
      color: pc.priority === "critical" ? "var(--error)" : pc.priority === "high" ? "var(--warning)" : pc.priority === "normal" ? "var(--accent)" : "var(--text-muted)",
    })),
  ];

  // ─── Render ──────────────────────────────────────────────────

  if (loading) {
    return <Loading text={t("workboard.loading")} />;
  }

  return (
    <div style={{ padding: 24 }}>
      <PageHeader
        title={t("workboard.title")}
        subtitle={t("workboard.subtitle")}
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Toggle
              checked={autoRefresh}
              onChange={setAutoRefresh}
              label={t("workboard.auto_refresh")}
            />
            {lastRefresh && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {refreshing ? t("workboard.refreshing") : `${t("workboard.last_refresh")}: ${lastRefresh.toLocaleTimeString(locale)}`}
              </span>
            )}
            <PrimaryButton onClick={() => setShowCreateModal(true)}>
              + {t("workboard.new_task")}
            </PrimaryButton>
          </div>
        }
      />

      {/* Stats Row */}
      <Section title={t("workboard.by_priority")}>
        <StatsGrid items={statsItems} />
      </Section>

      {/* Kanban Board */}
      <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 16, minHeight: 400 }}>
        {COLUMNS.map((col) => {
          const tasks = boardData.tasks?.[col.id] || [];
          return (
            <div key={col.id} style={{ minWidth: 260, flex: "0 0 260px", display: "flex", flexDirection: "column" }}>
              {/* Column Header */}
              <div style={{
                display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
                padding: "8px 12px", background: "var(--bg-card)", borderRadius: 8,
                border: "1px solid var(--border)",
              }}>
                <div style={{ width: 10, height: 10, borderRadius: 5, background: col.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-primary)", flex: 1 }}>
                  {t(`workboard.column_${col.id}`)}
                </span>
                <span style={{
                  fontSize: 11, color: "var(--text-muted)", background: "var(--bg-hover)",
                  padding: "2px 8px", borderRadius: 10, fontWeight: 600,
                }}>
                  {tasks.length}
                </span>
              </div>

              {/* Task List */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                {tasks.length === 0 ? (
                  <div style={{
                    padding: 20, textAlign: "center", color: "var(--text-muted)",
                    background: "var(--bg-card)", borderRadius: 8, fontSize: 12,
                    border: "1px dashed var(--border)",
                  }}>
                    {t("workboard.no_tasks")}
                  </div>
                ) : tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    t={t}
                    currentColumnId={col.id}
                    openStatusMenu={openStatusMenu}
                    onToggleStatusMenu={(id) => setOpenStatusMenu(openStatusMenu === id ? null : id)}
                    onStatusChange={handleStatusChange}
                    onClickTask={() => setSelectedTask(task)}
                    onDeleteTask={(e) => { e.stopPropagation(); setDeleteTarget(task); }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Task Modal */}
      {showCreateModal && (
        <Modal
          title={t("workboard.create_title")}
          onClose={() => setShowCreateModal(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowCreateModal(false)}>
                {t("workboard.cancel")}
              </SecondaryButton>
              <PrimaryButton onClick={handleCreateTask} disabled={!newTitle.trim() || creating}>
                {creating ? t("workboard.creating", "...") : t("workboard.new_task")}
              </PrimaryButton>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {t("workboard.task_title")}
              </label>
              <TextInput
                value={newTitle}
                onChange={setNewTitle}
                placeholder={t("workboard.task_title_placeholder")}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {t("workboard.task_description")}
              </label>
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={t("workboard.task_description_placeholder")}
                rows={3}
                style={{
                  width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 8,
                  border: "1px solid var(--input-border)", background: "var(--bg-input)",
                  color: "var(--text-primary)", fontSize: 13, resize: "vertical", outline: "none",
                  fontFamily: "inherit",
                }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {t("workboard.task_priority")}
              </label>
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value as Priority)}
                style={{
                  width: "100%", padding: "8px 12px", borderRadius: 8,
                  border: "1px solid var(--input-border)", background: "var(--bg-input)",
                  color: "var(--text-primary)", fontSize: 13, outline: "none",
                }}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{t(`workboard.priority_${p}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {t("workboard.task_tags")}
              </label>
              <TextInput
                value={newTags}
                onChange={setNewTags}
                placeholder={t("workboard.task_tags_placeholder")}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Task Detail Modal */}
      {selectedTask && (
        <Modal
          title={t("workboard.task_detail")}
          onClose={() => setSelectedTask(null)}
          width={560}
          footer={
            <>
              <SecondaryButton onClick={() => setSelectedTask(null)}>{t("workboard.close")}</SecondaryButton>
              <PrimaryButton danger onClick={() => setDeleteTarget(selectedTask)}>
                {t("workboard.delete_task")}
              </PrimaryButton>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>
                {selectedTask.title}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                <Badge variant={PRIORITY_VARIANT[selectedTask.priority] || "default"}>
                  {t(`workboard.priority_${selectedTask.priority}`)}
                </Badge>
                <Badge variant="info">
                  {t(`workboard.column_${selectedTask.status}`)}
                </Badge>
              </div>
            </div>

            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
                {t("workboard.task_description")}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                {selectedTask.description || t("workboard.no_description")}
              </div>
            </div>

            {selectedTask.assignee && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
                  {t("workboard.task_assignee")}
                </div>
                <span style={{ fontSize: 13, color: "var(--text-primary)" }}>{selectedTask.assignee}</span>
              </div>
            )}

            {selectedTask.tags && selectedTask.tags.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
                  {t("workboard.task_tags")}
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {selectedTask.tags.map((tag, i) => (
                    <Badge key={i} variant="default">{tag}</Badge>
                  ))}
                </div>
              </div>
            )}

            {selectedTask.createdAt && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
                  {t("workboard.task_created")}
                </div>
                <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                  {new Date(selectedTask.createdAt).toLocaleString(locale)}
                </span>
              </div>
            )}

            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
                {t("workboard.move_to")}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {COLUMNS.filter((c) => c.id !== selectedTask.status).map((col) => (
                  <SecondaryButton
                    key={col.id}
                    small
                    onClick={() => {
                      handleStatusChange(selectedTask.id, col.id);
                      setSelectedTask({ ...selectedTask, status: col.id });
                    }}
                  >
                    {t(`workboard.column_${col.id}`)}
                  </SecondaryButton>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <ConfirmModal
          title={t("workboard.delete_task")}
          message={t("workboard.delete_confirm")}
          danger
          confirmLabel={t("workboard.delete_task")}
          onConfirm={handleDeleteTask}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// ─── Task Card Sub-Component ─────────────────────────────────

function TaskCard({ task, t, currentColumnId, openStatusMenu, onToggleStatusMenu, onStatusChange, onClickTask, onDeleteTask }: {
  task: Task;
  t: (key: string, fallback?: string) => string;
  currentColumnId: ColumnId;
  openStatusMenu: string | null;
  onToggleStatusMenu: (id: string) => void;
  onStatusChange: (id: string, status: ColumnId) => void;
  onClickTask: () => void;
  onDeleteTask: (e: React.MouseEvent) => void;
}) {
  const isOpen = openStatusMenu === task.id;

  return (
    <div
      onClick={onClickTask}
      style={{
        background: "var(--bg-card)", borderRadius: 8, padding: 12,
        border: "1px solid var(--border)", cursor: "pointer",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = "var(--accent)";
        (e.currentTarget as HTMLDivElement).style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)";
        (e.currentTarget as HTMLDivElement).style.boxShadow = "none";
      }}
    >
      {/* Title + Priority */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-primary)", flex: 1, lineHeight: 1.4 }}>
          {task.title}
        </span>
        <Badge variant={PRIORITY_VARIANT[task.priority] || "default"} style={{ flexShrink: 0 }}>
          {t(`workboard.priority_${task.priority}`)}
        </Badge>
      </div>

      {/* Description (truncated) */}
      {task.description && (
        <div style={{
          fontSize: 11, color: "var(--text-muted)", marginBottom: 6, lineHeight: 1.4,
          overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box",
          WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>
          {task.description}
        </div>
      )}

      {/* Assignee */}
      {task.assignee && (
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>
          {task.assignee}
        </div>
      )}

      {/* Tags */}
      {task.tags && task.tags.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
          {task.tags.slice(0, 3).map((tag, i) => (
            <span key={i} style={{
              fontSize: 10, background: "var(--bg-hover)", color: "var(--text-secondary)",
              padding: "1px 6px", borderRadius: 4,
            }}>
              {tag}
            </span>
          ))}
          {task.tags.length > 3 && (
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>+{task.tags.length - 3}</span>
          )}
        </div>
      )}

      {/* Actions Row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
        {/* Status Dropdown */}
        <div style={{ position: "relative" }}>
          <button
            onClick={(e) => { e.stopPropagation(); onToggleStatusMenu(task.id); }}
            style={{
              fontSize: 10, padding: "3px 8px", borderRadius: 4,
              border: "1px solid var(--border)", background: "var(--bg-hover)",
              color: "var(--text-secondary)", cursor: "pointer", display: "flex",
              alignItems: "center", gap: 3,
            }}
          >
            {t("workboard.move_to")} ▾
          </button>
          {isOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "absolute", top: "100%", left: 0, zIndex: 100,
                background: "var(--bg-card)", border: "1px solid var(--border)",
                borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                minWidth: 140, padding: 4, marginTop: 2,
              }}
            >
              {COLUMNS.filter((c) => c.id !== currentColumnId).map((col) => (
                <button
                  key={col.id}
                  onClick={(e) => { e.stopPropagation(); onStatusChange(task.id, col.id); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, width: "100%",
                    padding: "6px 10px", border: "none", background: "transparent",
                    color: "var(--text-primary)", fontSize: 12, cursor: "pointer",
                    borderRadius: 4, textAlign: "left",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                >
                  <div style={{ width: 8, height: 8, borderRadius: 4, background: col.color, flexShrink: 0 }} />
                  {t(`workboard.column_${col.id}`)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Delete Button */}
        <button
          onClick={onDeleteTask}
          style={{
            fontSize: 10, padding: "3px 6px", borderRadius: 4,
            border: "1px solid transparent", background: "transparent",
            color: "var(--text-muted)", cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--error)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--error)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "transparent";
          }}
          title={t("workboard.delete_task")}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
