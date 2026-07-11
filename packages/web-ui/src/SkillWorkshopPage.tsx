/**
 * EvoClaw WebUI — Skill Workshop Page
 *
 * 技能工坊：展示提案驱动的技能创作与审核流程。
 * 覆盖统计概览、提案列表、创建提案、提案详情（含审核/修订/安装/回滚）、今日活动。
 *
 * 后端 API（见 packages/gateway/src/protocol-adapter.ts）：
 *   GET    /api/skills/workshop/stats
 *   GET    /api/skills/workshop/today
 *   GET    /api/skills/workshop/proposals
 *   POST   /api/skills/workshop/proposals
 *   GET    /api/skills/workshop/proposals/:id
 *   POST   /api/skills/workshop/proposals/:id/submit
 *   POST   /api/skills/workshop/proposals/:id/review
 *   POST   /api/skills/workshop/proposals/:id/revise
 *   POST   /api/skills/workshop/proposals/:id/install
 *   POST   /api/skills/workshop/proposals/:id/rollback
 *
 * 后端实际状态机：draft → submitted → (under_review) → approved/rejected/quarantined
 * 安装/回滚不改变 proposal.status（仍为 approved），故本页在客户端追踪已安装集合。
 */
import React, { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "./i18n";
import {
  PageHeader, Card, Badge, PrimaryButton, SecondaryButton, GhostButton,
  Modal, StatsGrid, EmptyState, ErrorBanner, Loading, showToast,
  type BadgeVariant,
} from "./shared";

// ─── 后端数据结构 ─────────────────────────────────────────────

type ProposalStatus =
  | "draft" | "submitted" | "under_review" | "approved" | "rejected" | "quarantined";

interface WorkshopFile {
  path: string;
  content: string;
  hash: string;
  type: "skill" | "config" | "asset" | "script";
}

interface Proposal {
  id: string;
  name: string;
  description: string;
  author: string;
  status: ProposalStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
  reviewedBy?: string;
  reviewComment?: string;
  files: WorkshopFile[];
  frontmatter: {
    version: number;
    date: string;
    author: string;
    reviewedAt?: string;
  };
}

interface Stats {
  total: number;
  byStatus: Record<string, number>;
  avgReviewTime: number;
}

interface TodayActions {
  pendingReview: Proposal[];
  recentlyApproved: Proposal[];
  recentlyRejected: Proposal[];
}

// ─── API helpers ──────────────────────────────────────────────

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

const api = {
  stats: () => fetch("/api/skills/workshop/stats").then(jsonOrThrow<{ success: boolean; stats: Stats }>),
  today: () => fetch("/api/skills/workshop/today").then(jsonOrThrow<{ success: boolean } & TodayActions>),
  list: () => fetch("/api/skills/workshop/proposals").then(jsonOrThrow<{ success: boolean; proposals: Proposal[] }>),
  get: (id: string) => fetch(`/api/skills/workshop/proposals/${encodeURIComponent(id)}`).then(jsonOrThrow<{ success: boolean; proposal: Proposal }>),
  create: (body: {
    name: string; description: string; author: string;
    files: Array<{ path: string; content: string; type: WorkshopFile["type"] }>;
  }) => fetch("/api/skills/workshop/proposals", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(jsonOrThrow<{ success: boolean; proposal: Proposal }>),
  submit: (id: string) => fetch(`/api/skills/workshop/proposals/${encodeURIComponent(id)}/submit`, { method: "POST" })
    .then(jsonOrThrow<{ success: boolean; proposal: Proposal }>),
  review: (id: string, body: { reviewer: string; decision: "approve" | "reject"; comment?: string }) =>
    fetch(`/api/skills/workshop/proposals/${encodeURIComponent(id)}/review`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(jsonOrThrow<{ success: boolean; proposal: Proposal }>),
  revise: (id: string, body: {
    files: Array<{ path: string; content: string; type: WorkshopFile["type"] }>; comment?: string;
  }) => fetch(`/api/skills/workshop/proposals/${encodeURIComponent(id)}/revise`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(jsonOrThrow<{ success: boolean; proposal: Proposal }>),
  install: (id: string) => fetch(`/api/skills/workshop/proposals/${encodeURIComponent(id)}/install`, { method: "POST" })
    .then(jsonOrThrow<{ success: boolean }>),
  rollback: (id: string) => fetch(`/api/skills/workshop/proposals/${encodeURIComponent(id)}/rollback`, { method: "POST" })
    .then(jsonOrThrow<{ success: boolean }>),
};

// ─── 状态映射 ─────────────────────────────────────────────────

function statusBadgeVariant(status: ProposalStatus, installed: boolean): BadgeVariant {
  if (installed && status === "approved") return "info";
  switch (status) {
    case "approved": return "success";
    case "submitted":
    case "under_review": return "warning";
    case "rejected":
    case "quarantined": return "error";
    default: return "default"; // draft
  }
}

function statusLabel(status: ProposalStatus, installed: boolean, t: (k: string, fb?: string) => string): string {
  if (installed && status === "approved") return t("workshop.status.installed", "已安装");
  switch (status) {
    case "draft": return t("workshop.status.draft", "草稿");
    case "submitted": return t("workshop.status.submitted", "待审核");
    case "under_review": return t("workshop.status.under_review", "审核中");
    case "approved": return t("workshop.status.approved", "已批准");
    case "rejected": return t("workshop.status.rejected", "已拒绝");
    case "quarantined": return t("workshop.status.quarantined", "已隔离");
    default: return status;
  }
}

function formatTime(ts: number): string {
  if (!ts) return "-";
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

// ─── 样式 ─────────────────────────────────────────────────────

const styles: Record<string, CSSProperties> = {
  wrap: { padding: "20px 24px", display: "flex", flexDirection: "column", gap: "20px", overflow: "auto" },
  row: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" },
  formField: { display: "flex", flexDirection: "column", gap: "6px", marginBottom: "14px" },
  label: { fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" },
  input: {
    padding: "8px 12px", borderRadius: "8px",
    border: "1px solid var(--input-border)", background: "var(--bg-input)",
    color: "var(--text-primary)", fontSize: "13px", outline: "none",
    width: "100%", boxSizing: "border-box",
  },
  textarea: {
    padding: "10px 12px", borderRadius: "8px",
    border: "1px solid var(--input-border)", background: "var(--bg-input)",
    color: "var(--text-primary)", fontSize: "12px", fontFamily: "'Cascadia Code','Fira Code',Consolas,monospace",
    outline: "none", width: "100%", boxSizing: "border-box",
    minHeight: "140px", resize: "vertical", lineHeight: 1.5,
  },
  codeBlock: {
    background: "var(--bg-input)", border: "1px solid var(--border-light)",
    borderRadius: "6px", padding: "10px 12px",
    fontFamily: "'Cascadia Code','Fira Code',Consolas,monospace",
    fontSize: "11px", color: "var(--text-primary)", whiteSpace: "pre-wrap",
    wordBreak: "break-word", maxHeight: "220px", overflow: "auto",
  },
  infoRow: { display: "flex", padding: "4px 0", fontSize: "12px", gap: "8px" },
  infoLabel: { color: "var(--text-muted)", minWidth: "80px", flexShrink: 0 },
  infoValue: { color: "var(--text-primary)", wordBreak: "break-all" },
  sectionTitle: {
    fontSize: "13px", fontWeight: 700, color: "var(--section-title-color)",
    marginBottom: "8px", marginTop: "4px",
  },
  todayGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" },
  todayItem: {
    padding: "8px 10px", borderRadius: "6px", background: "var(--bg-hover)",
    border: "1px solid var(--border-light)", cursor: "pointer",
  },
  todayItemName: { fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" },
  todayItemMeta: { fontSize: "10px", color: "var(--text-muted)", marginTop: "2px" },
  actionRow: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "12px" },
  emptyInline: { color: "var(--text-muted)", fontSize: "12px", padding: "8px 0" },
  fileBlock: { marginBottom: "10px" },
  filePath: { fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px", fontFamily: "monospace" },
};

// ─── 主组件 ───────────────────────────────────────────────────

export default function SkillWorkshopPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [today, setToday] = useState<TodayActions | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set());
  // 客户端追踪已安装提案（后端 install/rollback 不改变 proposal.status）
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());

  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showRevise, setShowRevise] = useState(false);

  // 创建表单
  const [cName, setCName] = useState("");
  const [cDesc, setCDesc] = useState("");
  const [cAuthor, setCAuthor] = useState("web-ui");
  const [cSkill, setCSkill] = useState("");
  const [cTest, setCTest] = useState("");
  const [creating, setCreating] = useState(false);

  // 审核表单
  const [reviewComment, setReviewComment] = useState("");

  // 修订表单
  const [reviseSkill, setReviseSkill] = useState("");
  const [reviseTest, setReviseTest] = useState("");
  const [reviseComment, setReviseComment] = useState("");

  const loadAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [s, td, ps] = await Promise.all([
        api.stats().catch((err) => { console.error("[API] request failed:", err); return null; }),
        api.today().catch((err) => { console.error("[API] request failed:", err); return null; }),
        api.list().catch((err) => { console.error("[API] request failed:", err); return null; }),
      ]);
      if (!s && !td && !ps) {
        setError("无法连接服务器，请检查服务是否运行");
      } else {
        if (s) setStats(s.stats);
        if (td) setToday({ pendingReview: td.pendingReview || [], recentlyApproved: td.recentlyApproved || [], recentlyRejected: td.recentlyRejected || [] });
        if (ps) setProposals(ps.proposals || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const markAction = useCallback((id: string, on: boolean) => {
    setActionLoading(prev => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setSelected(null);
    setDetailLoading(true);
    try {
      const data = await api.get(id);
      setSelected(data.proposal);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    setSelected(null);
    setShowReview(false);
    setShowRevise(false);
    setReviewComment("");
    setReviseSkill("");
    setReviseTest("");
    setReviseComment("");
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const data = await api.get(id);
      setSelected(data.proposal);
    } catch { /* 静默 */ }
  }, []);

  // ─── 操作处理 ─────────────────────────────────────────────

  const handleCreate = useCallback(async () => {
    if (!cName.trim() || !cDesc.trim() || !cAuthor.trim() || !cSkill.trim()) {
      showToast(t("workshop.form.required", "请填写名称、描述、作者与技能代码"), "error");
      return;
    }
    setCreating(true);
    try {
      // 对文件名做消毒：禁止路径穿越字符（.., /, \）
      const safeName = cName.trim().replace(/[\/\\]/g, "").replace(/\.\.+/g, ".");
      if (!safeName) {
        showToast(t("workshop.form.required", "请填写名称、描述、作者与技能代码"), "error");
        return;
      }
      const files: Array<{ path: string; content: string; type: WorkshopFile["type"] }> = [
        { path: `${safeName}.skill.md`, content: cSkill, type: "skill" },
      ];
      if (cTest.trim()) files.push({ path: `test.${safeName}.js`, content: cTest, type: "script" });
      const data = await api.create({ name: cName.trim(), description: cDesc, author: cAuthor.trim(), files });
      showToast(t("workshop.create_success", "提案创建成功"), "success");
      setShowCreate(false);
      setCName(""); setCDesc(""); setCSkill(""); setCTest("");
      setProposals(prev => [data.proposal, ...prev]);
      await loadAll(true);
    } catch (err) {
      showToast(`${t("workshop.create_fail", "创建失败")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setCreating(false);
    }
  }, [cName, cDesc, cAuthor, cSkill, cTest, t, loadAll]);

  const handleSubmit = useCallback(async (id: string) => {
    markAction(id, true);
    try {
      await api.submit(id);
      showToast(t("workshop.submit_success", "已提交审核"), "success");
      await refreshDetail(id);
      await loadAll(true);
    } catch (err) {
      showToast(`${t("workshop.submit_fail", "提交失败")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      markAction(id, false);
    }
  }, [markAction, refreshDetail, loadAll]);

  const handleReview = useCallback(async (id: string, decision: "approve" | "reject") => {
    markAction(id, true);
    try {
      await api.review(id, { reviewer: "web-ui", decision, comment: reviewComment.trim() || undefined });
      showToast(decision === "approve"
        ? t("workshop.approve_success", "审核通过")
        : t("workshop.reject_success", "已拒绝"), "success");
      setShowReview(false);
      setReviewComment("");
      await refreshDetail(id);
      await loadAll(true);
    } catch (err) {
      showToast(`${t("workshop.review_fail", "审核失败")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      markAction(id, false);
    }
  }, [markAction, refreshDetail, loadAll, reviewComment, t]);

  const openRevise = useCallback(() => {
    if (!selected) return;
    // 用现有文件内容预填
    const skillFile = selected.files.find(f => f.type === "skill");
    const testFile = selected.files.find(f => f.type === "script");
    setReviseSkill(skillFile?.content || "");
    setReviseTest(testFile?.content || "");
    setShowRevise(true);
  }, [selected]);

  const handleRevise = useCallback(async (id: string) => {
    if (!reviseSkill.trim()) {
      showToast(t("workshop.form.required", "请填写技能代码"), "error");
      return;
    }
    markAction(id, true);
    try {
      const files: Array<{ path: string; content: string; type: WorkshopFile["type"] }> = [
        { path: `${selected?.name ?? "skill"}.skill.md`, content: reviseSkill, type: "skill" },
      ];
      if (reviseTest.trim()) files.push({ path: `test.${selected?.name ?? "skill"}.js`, content: reviseTest, type: "script" });
      await api.revise(id, { files, comment: reviseComment.trim() || undefined });
      showToast(t("workshop.revise_success", "已修订"), "success");
      setShowRevise(false);
      setReviseComment("");
      await refreshDetail(id);
      await loadAll(true);
    } catch (err) {
      showToast(`${t("workshop.revise_fail", "修订失败")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      markAction(id, false);
    }
  }, [markAction, refreshDetail, loadAll, reviseSkill, reviseTest, reviseComment, selected, t]);

  const handleInstall = useCallback(async (id: string) => {
    markAction(id, true);
    try {
      await api.install(id);
      showToast(t("workshop.install_success", "安装成功"), "success");
      setInstalledIds(prev => new Set(prev).add(id));
      await refreshDetail(id);
      await loadAll(true);
    } catch (err) {
      showToast(`${t("workshop.install_fail", "安装失败")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      markAction(id, false);
    }
  }, [markAction, refreshDetail, loadAll, t]);

  const handleRollback = useCallback(async (id: string) => {
    markAction(id, true);
    try {
      await api.rollback(id);
      showToast(t("workshop.rollback_success", "已回滚"), "success");
      setInstalledIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      await refreshDetail(id);
      await loadAll(true);
    } catch (err) {
      showToast(`${t("workshop.rollback_fail", "回滚失败")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      markAction(id, false);
    }
  }, [markAction, refreshDetail, loadAll, t]);

  // ─── 渲染 ─────────────────────────────────────────────────

  const pendingCount = (stats?.byStatus?.submitted || 0) + (stats?.byStatus?.under_review || 0);
  const approvedCount = stats?.byStatus?.approved || 0;
  const rejectedCount = (stats?.byStatus?.rejected || 0) + (stats?.byStatus?.quarantined || 0);
  const installedCount = installedIds.size;

  const statItems = [
    { label: t("workshop.stats.total", "总提案数"), value: stats?.total ?? "-", color: "var(--text-primary)" },
    { label: t("workshop.stats.pending", "待审核"), value: pendingCount, color: "var(--warning)" },
    { label: t("workshop.stats.approved", "已批准"), value: approvedCount, color: "var(--success)" },
    { label: t("workshop.stats.installed", "已安装"), value: installedCount, color: "var(--accent)" },
    { label: t("workshop.stats.rejected", "已拒绝"), value: rejectedCount, color: "var(--error)" },
  ];

  if (loading) {
    return <div style={styles.wrap}><Loading text={t("workshop.loading", "加载中...")} /></div>;
  }

  return (
    <div style={styles.wrap}>
      <PageHeader
        title={t("workshop.title", "技能工坊")}
        subtitle={t("workshop.subtitle", "提案驱动的技能创作与审核流程")}
        actions={
          <>
            <SecondaryButton onClick={() => loadAll()}>{t("workshop.refresh", "刷新")}</SecondaryButton>
            <PrimaryButton onClick={() => setShowCreate(true)}>+ {t("workshop.create", "创建提案")}</PrimaryButton>
          </>
        }
      />

      {error && <ErrorBanner message={error} onRetry={() => loadAll()} />}

      {/* 统计概览 */}
      <StatsGrid items={statItems} />

      {/* 今日活动 */}
      <Card title={t("workshop.today_actions", "今日活动")}>
        {!today || (today.pendingReview.length === 0 && today.recentlyApproved.length === 0 && today.recentlyRejected.length === 0) ? (
          <EmptyState title={t("workshop.no_today_actions", "今日暂无活动")} />
        ) : (
          <div style={styles.todayGrid}>
            <TodayColumn
              title={t("workshop.pending_review", "待审核提案")}
              items={today.pendingReview}
              emptyText={t("workshop.no_pending", "无待审核提案")}
              onOpen={openDetail}
              t={t}
            />
            <TodayColumn
              title={t("workshop.recently_approved", "最近批准")}
              items={today.recentlyApproved}
              emptyText={t("workshop.no_approved_today", "今日暂无批准")}
              onOpen={openDetail}
              t={t}
            />
            <TodayColumn
              title={t("workshop.recently_rejected", "最近拒绝")}
              items={today.recentlyRejected}
              emptyText={t("workshop.no_rejected_today", "今日暂无拒绝")}
              onOpen={openDetail}
              t={t}
            />
          </div>
        )}
      </Card>

      {/* 提案列表 */}
      <Card title={`${t("workshop.proposals", "提案列表")} (${proposals.length})`}>
        {proposals.length === 0 ? (
          <EmptyState title={t("workshop.no_proposals", "暂无提案")} description={t("workshop.no_proposals_desc", "点击「创建提案」开始技能工坊流程")} />
        ) : (
          <ProposalTable
            proposals={proposals}
            installedIds={installedIds}
            onOpen={openDetail}
            t={t}
          />
        )}
      </Card>

      {/* 创建提案 Modal */}
      {showCreate && (
        <Modal
          title={t("workshop.create", "创建提案")}
          width={640}
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <SecondaryButton onClick={() => setShowCreate(false)}>{t("workshop.form.cancel", "取消")}</SecondaryButton>
              <PrimaryButton onClick={handleCreate} disabled={creating}>
                {creating ? t("workshop.form.creating", "创建中...") : t("workshop.form.submit", "创建")}
              </PrimaryButton>
            </>
          }
        >
          <div style={styles.formField}>
            <label style={styles.label}>{t("workshop.form.name", "名称")} *</label>
            <input style={styles.input} value={cName} onChange={e => setCName(e.target.value)} placeholder={t("workshop.form.name_ph", "输入提案名称")} />
          </div>
          <div style={styles.formField}>
            <label style={styles.label}>{t("workshop.form.description", "描述")} *</label>
            <textarea style={{ ...styles.textarea, minHeight: "70px" }} value={cDesc} onChange={e => setCDesc(e.target.value)} placeholder={t("workshop.form.description_ph", "描述提案目的与内容")} />
          </div>
          <div style={styles.formField}>
            <label style={styles.label}>{t("workshop.form.author", "作者")} *</label>
            <input style={styles.input} value={cAuthor} onChange={e => setCAuthor(e.target.value)} placeholder={t("workshop.form.author_ph", "输入作者名")} />
          </div>
          <div style={styles.formField}>
            <label style={styles.label}>{t("workshop.form.skill_code", "技能代码")} *</label>
            <textarea style={styles.textarea} value={cSkill} onChange={e => setCSkill(e.target.value)} placeholder={t("workshop.form.skill_code_ph", "粘贴 SKILL.md 或技能源码")} />
          </div>
          <div style={styles.formField}>
            <label style={styles.label}>{t("workshop.form.test_code", "测试代码")}</label>
            <textarea style={styles.textarea} value={cTest} onChange={e => setCTest(e.target.value)} placeholder={t("workshop.form.test_code_ph", "粘贴测试代码（可选）")} />
          </div>
        </Modal>
      )}

      {/* 提案详情 Modal */}
      {selectedId && (
        <Modal
          title={t("workshop.detail", "提案详情")}
          width={720}
          onClose={closeDetail}
          footer={
            selected && (
              <DetailActions
                proposal={selected}
                installed={installedIds.has(selected.id)}
                loading={actionLoading.has(selected.id)}
                t={t}
                onSubmit={() => handleSubmit(selected.id)}
                onReview={() => { setReviewComment(selected.reviewComment || ""); setShowReview(true); }}
                onRevise={openRevise}
                onInstall={() => handleInstall(selected.id)}
                onRollback={() => handleRollback(selected.id)}
              />
            )
          }
        >
          {detailLoading ? (
            <Loading text={t("workshop.loading", "加载中...")} />
          ) : selected ? (
            <ProposalDetail proposal={selected} installed={installedIds.has(selected.id)} t={t} />
          ) : (
            <EmptyState title={t("workshop.load_failed", "加载失败")} />
          )}

          {/* 审核子表单 */}
          {selected && showReview && (
            <div style={{ marginTop: "16px", padding: "12px", background: "var(--bg-hover)", borderRadius: "8px", border: "1px solid var(--border-light)" }}>
              <div style={styles.sectionTitle}>{t("workshop.review_modal_title", "审核提案")}</div>
              <div style={styles.formField}>
                <label style={styles.label}>{t("workshop.review_comment", "审核意见")}</label>
                <textarea style={{ ...styles.textarea, minHeight: "70px" }} value={reviewComment} onChange={e => setReviewComment(e.target.value)} placeholder={t("workshop.review_comment_ph", "输入审核意见（可选）")} />
              </div>
              <div style={styles.row}>
                <PrimaryButton onClick={() => handleReview(selected.id, "approve")} disabled={actionLoading.has(selected.id)}>
                  {t("workshop.btn.approve", "通过")}
                </PrimaryButton>
                <PrimaryButton danger onClick={() => handleReview(selected.id, "reject")} disabled={actionLoading.has(selected.id)}>
                  {t("workshop.btn.reject", "拒绝")}
                </PrimaryButton>
                <SecondaryButton onClick={() => setShowReview(false)}>{t("workshop.form.cancel", "取消")}</SecondaryButton>
              </div>
            </div>
          )}

          {/* 修订子表单 */}
          {selected && showRevise && (
            <div style={{ marginTop: "16px", padding: "12px", background: "var(--bg-hover)", borderRadius: "8px", border: "1px solid var(--border-light)" }}>
              <div style={styles.sectionTitle}>{t("workshop.revise_modal_title", "修订提案")}</div>
              <div style={styles.formField}>
                <label style={styles.label}>{t("workshop.form.skill_code", "技能代码")} *</label>
                <textarea style={styles.textarea} value={reviseSkill} onChange={e => setReviseSkill(e.target.value)} placeholder={t("workshop.form.skill_code_ph", "粘贴 SKILL.md 或技能源码")} />
              </div>
              <div style={styles.formField}>
                <label style={styles.label}>{t("workshop.form.test_code", "测试代码")}</label>
                <textarea style={styles.textarea} value={reviseTest} onChange={e => setReviseTest(e.target.value)} placeholder={t("workshop.form.test_code_ph", "粘贴测试代码（可选）")} />
              </div>
              <div style={styles.formField}>
                <label style={styles.label}>{t("workshop.review_comment", "修订说明")}</label>
                <textarea style={{ ...styles.textarea, minHeight: "60px" }} value={reviseComment} onChange={e => setReviseComment(e.target.value)} placeholder={t("workshop.revise_comment_ph", "输入修订说明")} />
              </div>
              <div style={styles.row}>
                <PrimaryButton onClick={() => handleRevise(selected.id)} disabled={actionLoading.has(selected.id)}>
                  {t("workshop.btn.revise", "修订")}
                </PrimaryButton>
                <SecondaryButton onClick={() => setShowRevise(false)}>{t("workshop.form.cancel", "取消")}</SecondaryButton>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// ─── 子组件：今日活动列 ───────────────────────────────────────

function TodayColumn({ title, items, emptyText, onOpen, t }: {
  title: string;
  items: Proposal[];
  emptyText: string;
  onOpen: (id: string) => void;
  t: (k: string, fb?: string) => string;
}) {
  return (
    <div>
      <div style={{ ...styles.sectionTitle, marginBottom: "6px" }}>{title} ({items.length})</div>
      {items.length === 0 ? (
        <div style={styles.emptyInline}>{emptyText}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {items.map(p => (
            <div key={p.id} style={styles.todayItem} onClick={() => onOpen(p.id)} title={p.name}>
              <div style={styles.todayItemName}>{p.name}</div>
              <div style={styles.todayItemMeta}>{p.author} · {formatTime(p.updatedAt)}</div>
              <div style={{ marginTop: "4px" }}>
                <Badge variant={statusBadgeVariant(p.status, false)}>{statusLabel(p.status, false, t)}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 子组件：提案表格 ─────────────────────────────────────────

function ProposalTable({ proposals, installedIds, onOpen, t }: {
  proposals: Proposal[];
  installedIds: Set<string>;
  onOpen: (id: string) => void;
  t: (k: string, fb?: string) => string;
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
      <thead>
        <tr>
          {[
            t("workshop.col.id", "ID"),
            t("workshop.col.name", "名称"),
            t("workshop.col.status", "状态"),
            t("workshop.col.created", "创建时间"),
            t("workshop.col.updated", "更新时间"),
            t("workshop.col.actions", "操作"),
          ].map((h, i) => (
            <th key={i} style={{
              textAlign: "left", padding: "10px 12px", color: "var(--text-muted)",
              fontWeight: 600, fontSize: "11px", textTransform: "uppercase",
              letterSpacing: "0.3px", borderBottom: "1px solid var(--border)",
            }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {proposals.map(p => {
          const installed = installedIds.has(p.id);
          return (
            <tr key={p.id} style={{ borderBottom: "1px solid var(--border-light)" }}>
              <td style={{ padding: "10px 12px", color: "var(--text-muted)", fontFamily: "monospace", fontSize: "11px" }}>{p.id.slice(0, 8)}</td>
              <td style={{ padding: "10px 12px", color: "var(--text-primary)", fontWeight: 600 }}>{p.name}</td>
              <td style={{ padding: "10px 12px" }}>
                <Badge variant={statusBadgeVariant(p.status, installed)}>{statusLabel(p.status, installed, t)}</Badge>
              </td>
              <td style={{ padding: "10px 12px", color: "var(--text-secondary)", fontSize: "12px" }}>{formatTime(p.createdAt)}</td>
              <td style={{ padding: "10px 12px", color: "var(--text-secondary)", fontSize: "12px" }}>{formatTime(p.updatedAt)}</td>
              <td style={{ padding: "10px 12px" }}>
                <GhostButton small onClick={() => onOpen(p.id)}>{t("workshop.btn.view_detail", "查看详情")}</GhostButton>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── 子组件：提案详情内容 ─────────────────────────────────────

function ProposalDetail({ proposal, installed, t }: {
  proposal: Proposal;
  installed: boolean;
  t: (k: string, fb?: string) => string;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "18px", fontWeight: 700, color: "var(--text-primary)" }}>{proposal.name}</span>
        <Badge variant={statusBadgeVariant(proposal.status, installed)}>{statusLabel(proposal.status, installed, t)}</Badge>
        <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>v{proposal.version}</span>
      </div>

      {proposal.description && (
        <div style={{
          padding: "10px 12px", background: "var(--bg-hover)", borderRadius: "6px",
          border: "1px solid var(--border-light)", fontSize: "13px", color: "var(--text-secondary)",
          marginBottom: "12px", lineHeight: 1.5,
        }}>
          {proposal.description}
        </div>
      )}

      <div style={styles.infoRow}>
        <span style={styles.infoLabel}>{t("workshop.col.id", "ID")}</span>
        <span style={{ ...styles.infoValue, fontFamily: "monospace", fontSize: "11px" }}>{proposal.id}</span>
      </div>
      <div style={styles.infoRow}>
        <span style={styles.infoLabel}>{t("workshop.author", "作者")}</span>
        <span style={styles.infoValue}>{proposal.author}</span>
      </div>
      <div style={styles.infoRow}>
        <span style={styles.infoLabel}>{t("workshop.col.created", "创建时间")}</span>
        <span style={styles.infoValue}>{formatTime(proposal.createdAt)}</span>
      </div>
      <div style={styles.infoRow}>
        <span style={styles.infoLabel}>{t("workshop.col.updated", "更新时间")}</span>
        <span style={styles.infoValue}>{formatTime(proposal.updatedAt)}</span>
      </div>

      {/* 审核信息 */}
      <div style={styles.sectionTitle}>{t("workshop.review_info", "审核信息")}</div>
      {proposal.reviewedBy ? (
        <>
          <div style={styles.infoRow}>
            <span style={styles.infoLabel}>{t("workshop.reviewed_by", "审核人")}</span>
            <span style={styles.infoValue}>{proposal.reviewedBy}</span>
          </div>
          {proposal.frontmatter.reviewedAt && (
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>{t("workshop.reviewed_at", "审核时间")}</span>
              <span style={styles.infoValue}>{formatTime(new Date(proposal.frontmatter.reviewedAt).getTime())}</span>
            </div>
          )}
          {proposal.reviewComment && (
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>{t("workshop.review_comment", "审核意见")}</span>
              <span style={styles.infoValue}>{proposal.reviewComment}</span>
            </div>
          )}
        </>
      ) : (
        <div style={styles.emptyInline}>{t("workshop.not_reviewed", "尚未审核")}</div>
      )}

      {/* 提案文件（代码/测试） */}
      <div style={styles.sectionTitle}>{t("workshop.files", "文件")} ({proposal.files.length})</div>
      {proposal.files.length === 0 ? (
        <div style={styles.emptyInline}>{t("workshop.no_files", "无文件")}</div>
      ) : (
        proposal.files.map((f, i) => (
          <div key={i} style={styles.fileBlock}>
            <div style={styles.filePath}>
              {f.path} · <Badge variant="default">{f.type}</Badge>
              <span style={{ marginLeft: "6px", color: "var(--text-muted)" }}>hash: {f.hash.slice(0, 12)}</span>
            </div>
            <pre style={styles.codeBlock}>{f.content}</pre>
          </div>
        ))
      )}
    </div>
  );
}

// ─── 子组件：详情操作按钮 ─────────────────────────────────────

function DetailActions({ proposal, installed, loading, t, onSubmit, onReview, onRevise, onInstall, onRollback }: {
  proposal: Proposal;
  installed: boolean;
  loading: boolean;
  t: (k: string, fb?: string) => string;
  onSubmit: () => void;
  onReview: () => void;
  onRevise: () => void;
  onInstall: () => void;
  onRollback: () => void;
}) {
  const s = proposal.status;
  const btn = (label: string, onClick: () => void, opts?: { danger?: boolean; secondary?: boolean }) =>
    opts?.secondary
      ? <SecondaryButton small onClick={onClick} disabled={loading}>{label}</SecondaryButton>
      : <PrimaryButton small danger={opts?.danger} onClick={onClick} disabled={loading}>{label}</PrimaryButton>;

  // draft → 提交审核
  if (s === "draft") {
    return <>{btn(t("workshop.btn.submit", "提交审核"), onSubmit)}</>;
  }
  // submitted / under_review → 通过/拒绝/修订（under_review 后端不允许 revise，仅 submitted 可修订）
  if (s === "submitted" || s === "under_review") {
    return (
      <>
        {btn(t("workshop.btn.approve", "通过"), onReview)}
        {btn(t("workshop.btn.reject", "拒绝"), () => onReview(), { danger: true })}
        {s === "submitted" && btn(t("workshop.btn.revise", "修订"), onRevise, { secondary: true })}
      </>
    );
  }
  // rejected → 修订
  if (s === "rejected") {
    return <>{btn(t("workshop.btn.revise", "修订"), onRevise)}</>;
  }
  // approved → 安装 / 已安装 → 回滚
  if (s === "approved") {
    return installed
      ? <>{btn(t("workshop.btn.rollback", "回滚"), onRollback, { danger: true })}</>
      : <>{btn(t("workshop.btn.install", "安装"), onInstall)}</>;
  }
  // quarantined → 终态，无操作
  return null;
}
