/**
 * KanbanBoardPage — Kanban 多 Agent 工作队列看板页
 *
 * 展示看板列表（boardId/totalTasks/byStatus），
 * 任务列表（按 status 分组的看板视图），
 * 添加任务表单，以及领取/完成任务操作。
 */

import { useState, useEffect, useCallback } from "react";
import {
  PageHeader, Card, Badge, Loading, EmptyState,
  PrimaryButton, SecondaryButton, Section,
  StatsGrid, Modal, showToast, TextInput,
} from "./shared";
import { useApiCall } from "./useApiCall";
import { useTranslation } from "./i18n";
import {
  kanbanApi,
  type KanbanBoardInfo,
  type KanbanTask,
  type KanbanTaskStatus,
  type KanbanTaskPriority,
  type KanbanBoardStats,
} from "./api-client";

// ─── Column Definitions ──────────────────────────────────────

const COLUMNS: Array<{ id: KanbanTaskStatus; color: string; label: string; labelEn: string }> = [
  { id: "pending", color: "var(--text-muted)", label: "待处理", labelEn: "Pending" },
  { id: "ready", color: "var(--accent)", label: "就绪", labelEn: "Ready" },
  { id: "claimed", color: "#8b5cf6", label: "已领取", labelEn: "Claimed" },
  { id: "in_progress", color: "var(--warning)", label: "进行中", labelEn: "In Progress" },
  { id: "review", color: "#0891b2", label: "评审", labelEn: "Review" },
  { id: "done", color: "var(--success)", label: "完成", labelEn: "Done" },
  { id: "blocked", color: "#dc2626", label: "阻塞", labelEn: "Blocked" },
  { id: "failed", color: "var(--error)", label: "失败", labelEn: "Failed" },
];

const PRIORITIES: KanbanTaskPriority[] = ["high", "medium", "low"];

const PRIORITY_VARIANT: Record<KanbanTaskPriority, "error" | "warning" | "default"> = {
  high: "error",
  medium: "warning",
  low: "default",
};

export default function KanbanBoardPage() {
  const { t, lang } = useTranslation();
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const { call } = useApiCall();

  const [boards, setBoards] = useState<KanbanBoardInfo[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string>("");
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [stats, setStats] = useState<KanbanBoardStats | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);

  // Modal state
  const [showCreateBoard, setShowCreateBoard] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [selectedTask, setSelectedTask] = useState<KanbanTask | null>(null);

  // Create board form
  const [newBoardId, setNewBoardId] = useState("");
  const [newBoardTenant, setNewBoardTenant] = useState("");
  const [creatingBoard, setCreatingBoard] = useState(false);

  // Add task form
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskPriority, setTaskPriority] = useState<KanbanTaskPriority>("medium");
  const [addingTask, setAddingTask] = useState(false);

  const refreshBoards = useCallback(async () => {
    setLoadingState(true);
    const result = await kanbanApi.listBoards();
    const list = result.boards || [];
    setBoards(list);
    if (!activeBoardId && list.length > 0) {
      setActiveBoardId(list[0].boardId);
    }
    setLoadingState(false);
  }, [activeBoardId]);

  const refreshTasks = useCallback(async () => {
    if (!activeBoardId) {
      setTasks([]);
      setStats(null);
      return;
    }
    setTasksLoading(true);
    const [tResult, sResult] = await Promise.all([
      kanbanApi.listTasks(activeBoardId),
      kanbanApi.stats(activeBoardId),
    ]);
    setTasks(tResult.tasks || []);
    setStats(sResult);
    setTasksLoading(false);
  }, [activeBoardId]);

  useEffect(() => { refreshBoards(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeBoardId) refreshTasks();
  }, [activeBoardId, refreshTasks]);

  async function handleCreateBoard() {
    if (!newBoardId.trim()) return;
    setCreatingBoard(true);
    const result = await call(
      () => kanbanApi.createBoard(newBoardId.trim(), newBoardTenant.trim() || undefined),
      { errorMessage: t("kanban.create_board_failed", "创建看板失败") },
    );
    if (result) {
      showToast(t("kanban.board_created", "看板已创建"), "success");
      setShowCreateBoard(false);
      setNewBoardId("");
      setNewBoardTenant("");
      await refreshBoards();
      setActiveBoardId(newBoardId.trim());
    }
    setCreatingBoard(false);
  }

  async function handleAddTask() {
    if (!taskTitle.trim() || !activeBoardId) return;
    setAddingTask(true);
    const result = await call(
      () => kanbanApi.addTask(activeBoardId, {
        title: taskTitle.trim(),
        description: taskDescription.trim(),
        priority: taskPriority,
      }),
      { errorMessage: t("kanban.add_task_failed", "添加任务失败") },
    );
    if (result) {
      showToast(t("kanban.task_added", "任务已添加"), "success");
      setShowAddTask(false);
      setTaskTitle("");
      setTaskDescription("");
      setTaskPriority("medium");
      refreshTasks();
    }
    setAddingTask(false);
  }

  async function handleClaimTask(taskId: string) {
    const agentId = `webui-${Date.now().toString(36)}`;
    const result = await call(
      () => kanbanApi.claimTask(taskId, agentId),
      { errorMessage: t("kanban.claim_failed", "领取任务失败") },
    );
    if (result) {
      showToast(t("kanban.task_claimed", "任务已领取"), "success");
      setSelectedTask(null);
      refreshTasks();
    }
  }

  async function handleCompleteTask(taskId: string) {
    const result = await call(
      () => kanbanApi.completeTask(taskId, "completed via web-ui"),
      { errorMessage: t("kanban.complete_failed", "完成任务失败") },
    );
    if (result) {
      showToast(t("kanban.task_completed", "任务已完成"), "success");
      setSelectedTask(null);
      refreshTasks();
    }
  }

  function colLabel(col: { id: KanbanTaskStatus; label: string; labelEn: string }): string {
    return lang === "zh" ? col.label : col.labelEn;
  }

  if (loadingState) {
    return <Loading text={t("kanban.loading", "加载看板...")} />;
  }

  const statsItems = stats ? [
    { label: t("kanban.total", "总计"), value: stats.total, color: "var(--text-primary)" },
    ...COLUMNS.slice(0, 6).map(c => ({
      label: colLabel(c),
      value: stats.byStatus?.[c.id] || 0,
      color: c.color,
    })),
  ] : [];

  return (
    <div style={{ padding: 24 }}>
      <PageHeader
        title={t("kanban.title", "Kanban 工作队列")}
        subtitle={t("kanban.subtitle", "多 Agent 工作队列看板：领取/完成任务，按状态分组")}
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <SecondaryButton onClick={refreshBoards}>
              {t("kanban.refresh", "刷新")}
            </SecondaryButton>
            <PrimaryButton onClick={() => setShowCreateBoard(true)}>
              + {t("kanban.new_board", "新建看板")}
            </PrimaryButton>
          </div>
        }
      />

      {/* Board Selector */}
      {boards.length === 0 ? (
        <EmptyState
          title={t("kanban.no_boards", "暂无看板")}
          description={t("kanban.no_boards_desc", "点击「新建看板」创建第一个看板")}
        />
      ) : (
        <>
          <Section>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {boards.map(b => (
                <button
                  key={b.boardId}
                  onClick={() => setActiveBoardId(b.boardId)}
                  style={{
                    padding: "8px 14px", borderRadius: 8, cursor: "pointer",
                    border: activeBoardId === b.boardId ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: activeBoardId === b.boardId ? "var(--accent-bg)" : "var(--bg-card)",
                    color: activeBoardId === b.boardId ? "var(--accent)" : "var(--text-secondary)",
                    fontSize: 13, fontWeight: 600,
                  }}
                >
                  {b.boardId}
                  {b.totalTasks !== undefined && (
                    <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.7 }}>
                      ({b.totalTasks})
                    </span>
                  )}
                </button>
              ))}
            </div>
          </Section>

          {/* Stats */}
          {stats && (
            <Section>
              <StatsGrid items={statsItems} />
            </Section>
          )}

          {/* Actions */}
          <div style={{ marginBottom: 12, display: "flex", justifyContent: "flex-end" }}>
            <PrimaryButton onClick={() => setShowAddTask(true)} small>
              + {t("kanban.add_task", "添加任务")}
            </PrimaryButton>
          </div>

          {/* Kanban Board */}
          {tasksLoading ? (
            <Loading text={t("kanban.loading_tasks", "加载任务...")} />
          ) : (
            <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 16, minHeight: 400 }}>
              {COLUMNS.map(col => {
                const colTasks = tasks.filter(t => t.status === col.id);
                return (
                  <div key={col.id} style={{ minWidth: 220, flex: "0 0 220px", display: "flex", flexDirection: "column" }}>
                    {/* Column Header */}
                    <div style={{
                      display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
                      padding: "8px 12px", background: "var(--bg-card)", borderRadius: 8,
                      border: "1px solid var(--border)",
                    }}>
                      <div style={{ width: 10, height: 10, borderRadius: 5, background: col.color, flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, fontSize: 12, color: "var(--text-primary)", flex: 1 }}>
                        {colLabel(col)}
                      </span>
                      <span style={{
                        fontSize: 11, color: "var(--text-muted)", background: "var(--bg-hover)",
                        padding: "2px 8px", borderRadius: 10, fontWeight: 600,
                      }}>
                        {colTasks.length}
                      </span>
                    </div>

                    {/* Task List */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                      {colTasks.length === 0 ? (
                        <div style={{
                          padding: 16, textAlign: "center", color: "var(--text-muted)",
                          background: "var(--bg-card)", borderRadius: 8, fontSize: 11,
                          border: "1px dashed var(--border)",
                        }}>
                          —
                        </div>
                      ) : colTasks.map(task => (
                        <KanbanTaskCard
                          key={task.id}
                          task={task}
                          locale={locale}
                          onClick={() => setSelectedTask(task)}
                          t={t}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Create Board Modal */}
      {showCreateBoard && (
        <Modal
          title={t("kanban.create_board", "创建看板")}
          onClose={() => setShowCreateBoard(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowCreateBoard(false)}>
                {t("kanban.cancel", "取消")}
              </SecondaryButton>
              <PrimaryButton onClick={handleCreateBoard} disabled={!newBoardId.trim() || creatingBoard}>
                {creatingBoard ? t("kanban.creating", "创建中...") : t("kanban.create", "创建")}
              </PrimaryButton>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {t("kanban.board_id", "看板 ID")} *
              </label>
              <TextInput
                value={newBoardId}
                onChange={setNewBoardId}
                placeholder={t("kanban.board_id_placeholder", "如：default-board")}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {t("kanban.tenant", "租户")} ({t("kanban.optional", "可选")})
              </label>
              <TextInput
                value={newBoardTenant}
                onChange={setNewBoardTenant}
                placeholder={t("kanban.tenant_placeholder", "留空则无租户隔离")}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Add Task Modal */}
      {showAddTask && (
        <Modal
          title={t("kanban.add_task_title", "添加任务")}
          onClose={() => setShowAddTask(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowAddTask(false)}>
                {t("kanban.cancel", "取消")}
              </SecondaryButton>
              <PrimaryButton onClick={handleAddTask} disabled={!taskTitle.trim() || addingTask}>
                {addingTask ? t("kanban.adding", "添加中...") : t("kanban.add", "添加")}
              </PrimaryButton>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {t("kanban.task_title", "标题")} *
              </label>
              <TextInput
                value={taskTitle}
                onChange={setTaskTitle}
                placeholder={t("kanban.task_title_placeholder", "任务标题")}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                {t("kanban.task_desc", "描述")}
              </label>
              <textarea
                value={taskDescription}
                onChange={(e) => setTaskDescription(e.target.value)}
                placeholder={t("kanban.task_desc_placeholder", "任务描述...")}
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
                {t("kanban.priority", "优先级")}
              </label>
              <select
                value={taskPriority}
                onChange={(e) => setTaskPriority(e.target.value as KanbanTaskPriority)}
                style={{
                  width: "100%", padding: "8px 12px", borderRadius: 8,
                  border: "1px solid var(--input-border)", background: "var(--bg-input)",
                  color: "var(--text-primary)", fontSize: 13, outline: "none",
                }}
              >
                {PRIORITIES.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>
        </Modal>
      )}

      {/* Task Detail Modal */}
      {selectedTask && (
        <Modal
          title={t("kanban.task_detail", "任务详情")}
          onClose={() => setSelectedTask(null)}
          width={560}
          footer={
            <>
              <SecondaryButton onClick={() => setSelectedTask(null)}>
                {t("kanban.close", "关闭")}
              </SecondaryButton>
              {(selectedTask.status === "ready" || selectedTask.status === "pending") && (
                <PrimaryButton onClick={() => handleClaimTask(selectedTask.id)}>
                  {t("kanban.claim", "领取任务")}
                </PrimaryButton>
              )}
              {(selectedTask.status === "claimed" || selectedTask.status === "in_progress" || selectedTask.status === "review") && (
                <PrimaryButton onClick={() => handleCompleteTask(selectedTask.id)}>
                  {t("kanban.complete", "完成任务")}
                </PrimaryButton>
              )}
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>
              {selectedTask.title}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Badge variant={PRIORITY_VARIANT[selectedTask.priority]}>
                {selectedTask.priority}
              </Badge>
              <Badge variant="info">{selectedTask.status}</Badge>
              <code style={{ fontSize: 11, color: "var(--text-muted)", background: "var(--bg-hover)", padding: "1px 6px", borderRadius: 4 }}>
                {selectedTask.id}
              </code>
            </div>
            {selectedTask.description && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
                  {t("kanban.task_desc", "描述")}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                  {selectedTask.description}
                </div>
              </div>
            )}
            {selectedTask.assignedAgent && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
                  {t("kanban.assigned_agent", "执行 Agent")}
                </div>
                <code style={{ fontSize: 12, color: "var(--accent)" }}>{selectedTask.assignedAgent}</code>
              </div>
            )}
            {selectedTask.dependencies.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
                  {t("kanban.dependencies", "依赖")}
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {selectedTask.dependencies.map((dep, i) => (
                    <Badge key={i} variant="default">{dep}</Badge>
                  ))}
                </div>
              </div>
            )}
            {selectedTask.error && (
              <div style={{ padding: 8, background: "var(--error-bg)", borderRadius: 6, color: "var(--error)", fontSize: 12 }}>
                {selectedTask.error}
              </div>
            )}
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {t("kanban.created_at", "创建时间")}: {new Date(selectedTask.createdAt).toLocaleString(locale)}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Task Card Sub-Component ─────────────────────────────────

function KanbanTaskCard({ task, locale, onClick, t }: {
  task: KanbanTask;
  locale: string;
  onClick: () => void;
  t: (key: string, fallback?: string) => string;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: "var(--bg-card)", borderRadius: 8, padding: 10,
        border: "1px solid var(--border)", cursor: "pointer",
        transition: "border-color 0.15s",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "var(--accent)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)"; }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6, marginBottom: 4 }}>
        <span style={{ fontWeight: 600, fontSize: 12, color: "var(--text-primary)", flex: 1, lineHeight: 1.4 }}>
          {task.title}
        </span>
        <Badge variant={PRIORITY_VARIANT[task.priority]} style={{ flexShrink: 0 }}>
          {task.priority}
        </Badge>
      </div>
      {task.description && (
        <div style={{
          fontSize: 11, color: "var(--text-muted)", marginBottom: 4, lineHeight: 1.4,
          overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box",
          WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>
          {task.description}
        </div>
      )}
      {task.assignedAgent && (
        <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
          {t("kanban.agent", "Agent")}: <code style={{ fontSize: 10 }}>{task.assignedAgent.slice(0, 16)}</code>
        </div>
      )}
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
        {new Date(task.createdAt).toLocaleDateString(locale)}
      </div>
    </div>
  );
}
