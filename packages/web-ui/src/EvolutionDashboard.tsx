import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "./i18n";
import { learningApi, compactionsApi } from "./api-client";

interface EvolutionData {
  cycles: EvolutionCycleInfo[];
  feedback: FeedbackInfo[];
  patterns: PatternInfo[];
  learning: LearningStats | null;
  summary: {
    totalCycles: number;
    successRate: number;
    avgEvaluationScore: number;
    totalCandidates: number;
  };
}

interface EvolutionCycleInfo {
  id: string;
  source: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  duration: number;
  candidatesGenerated: number;
  candidatesPassed: number;
  evaluationScore: number;
}

interface FeedbackInfo {
  cycleId: string;
  skillId: string;
  successRate: number;
  userAdoptionRate: number;
  tokenConsumption: number;
  errorRate: number;
  collectedAt: string;
}

interface PatternInfo {
  name: string;
  count: number;
  confidence: number;
}

interface LearningStats {
  totalEntries: number;
  resolvedEntries: number;
  unresolvedEntries: number;
  entriesByCategory: Record<string, number>;
  entriesByTrigger: Record<string, number>;
  entriesBySeverity: Record<string, number>;
  recentEntries: LearningEntry[];
  topTags: Array<{ tag: string; count: number }>;
  resolutionRate: number;
  averageResolutionTimeMs: number;
  newThisWeek: number;
  resolvedThisWeek: number;
}

interface LearningEntry {
  id: string;
  timestamp: string;
  trigger: string;
  category: string;
  title: string;
  context: string;
  error: string | null;
  rootCause: string | null;
  correction: string | null;
  solution: string | null;
  source: string;
  severity: string;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedApproach: string | null;
  tags: string[];
}

interface LearningSession {
  id: string;
  taskId: string;
  taskDescription: string;
  entries: LearningEntry[];
  startedAt: string;
  completedAt: string | null;
  status: string;
  summary: string | null;
}

interface CompactionSummary {
  id: string;
  parentSessionId: string;
  successorSessionId: string;
  summary: string;
  keyFacts: string[];
  decisions: string[];
  pendingItems: string[];
  compactedTurnCount: number;
  timestamp: string;
}

interface ProgressReport {
  id: string;
  sessionId: string;
  taskId: string;
  phase: string;
  step: number;
  totalSteps: number;
  progress: number;
  message: string;
  details: string | null;
  status: string;
  startedAt: string;
}

const DEFAULT_DATA: EvolutionData = {
  cycles: [],
  feedback: [],
  patterns: [
    { name: "missing_dependency", count: 0, confidence: 0 },
    { name: "execution_timeout", count: 0, confidence: 0 },
    { name: "memory_exhaustion", count: 0, confidence: 0 },
    { name: "insufficient_permissions", count: 0, confidence: 0 },
    { name: "low_success_rate", count: 0, confidence: 0 },
  ],
  learning: null,
  summary: {
    totalCycles: 0,
    successRate: 0,
    avgEvaluationScore: 0,
    totalCandidates: 0,
  },
};

export default function EvolutionDashboard() {
  const { t, lang } = useTranslation();
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const [data, setData] = useState<EvolutionData>(DEFAULT_DATA);
  const [learningEntries, setLearningEntries] = useState<LearningEntry[]>([]);
  const [learningSessions, setLearningSessions] = useState<LearningSession[]>([]);
  const [progressReports, setProgressReports] = useState<ProgressReport[]>([]);
  const [compactions, setCompactions] = useState<CompactionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(true);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  const abortRef = useRef<AbortController | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<"overview" | "cycles" | "feedback" | "patterns" | "learning" | "progress" | "help" | "record">("overview");
  const [triggering, setTriggering] = useState(false);
  const [triggerDesc, setTriggerDesc] = useState("");
  const [showTrigger, setShowTrigger] = useState(false);
  const [triggeringSkill, setTriggeringSkill] = useState(false);
  const [skillIdInput, setSkillIdInput] = useState("");
  const [skillNameInput, setSkillNameInput] = useState("");
  const [showTriggerSkill, setShowTriggerSkill] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  // Learning record form state
  const [recordType, setRecordType] = useState<"correction" | "gap" | "failure" | "improvement">("correction");
  const [recordSubmitting, setRecordSubmitting] = useState(false);
  const [recordForm, setRecordForm] = useState<Record<string, string>>({});
  const [recordTriggerEvo, setRecordTriggerEvo] = useState(false);
  // Compaction chain by sessionId viewer state
  const [compactionSessionInput, setCompactionSessionInput] = useState("");
  const [customCompactions, setCustomCompactions] = useState<CompactionSummary[]>([]);
  const [compactionLoading, setCompactionLoading] = useState(false);
  const [compactionError, setCompactionError] = useState<string | null>(null);

  const loadEvolutionData = useCallback(async () => {
    // 中止前一次请求，防止组件卸载或新请求时旧请求覆盖状态
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const [res, compactionsRes] = await Promise.all([
        fetch("/api/evolution/dashboard", { signal: controller.signal }),
        fetch("/api/compactions/web-ui", { signal: controller.signal }).catch((e) => {
          if (e instanceof DOMException && e.name === "AbortError") throw e;
          return null;
        }),
      ]);
      if (res.ok) {
        const json = await res.json();
        setData({
          ...DEFAULT_DATA,
          ...json,
          // Merge patterns: use API data if non-empty, otherwise keep defaults
          patterns: json.patterns && json.patterns.length > 0 ? json.patterns : DEFAULT_DATA.patterns,
        });
        setError(null);
      } else {
        setData(DEFAULT_DATA);
        if (loadingRef.current) setError(t("evo.server_unavailable", "Server not available - showing empty dashboard"));
      }
      if (compactionsRes && compactionsRes.ok) {
        const c = await compactionsRes.json();
        setCompactions(c.compactions || []);
      }
    } catch (err) {
      // AbortError 时不更新状态（组件卸载或新请求取代）
      if (err instanceof DOMException && err.name === "AbortError") return;
      setData(DEFAULT_DATA);
      if (loadingRef.current) setError(t("evo.server_unavailable", "Server not available - showing empty dashboard"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [t]);

  // 使用 ref 存最新函数，避免 setInterval 调用 stale closure
  const loadEvolutionRef = useRef(loadEvolutionData);
  loadEvolutionRef.current = loadEvolutionData;

  useEffect(() => {
    loadEvolutionData();
    const interval = setInterval(() => loadEvolutionRef.current(), 15000);
    return () => {
      clearInterval(interval);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [loadEvolutionData]);

  useEffect(() => {
    if (activeSubTab === "learning") {
      loadLearningData();
    }
  }, [activeSubTab]);

  async function loadLearningData() {
    try {
      const [entriesRes, sessionsRes] = await Promise.all([
        fetch("/api/evolution/learning/entries?limit=200"),
        fetch("/api/evolution/learning/sessions"),
      ]);
      if (entriesRes.ok) setLearningEntries(await entriesRes.json());
      if (sessionsRes.ok) setLearningSessions(await sessionsRes.json());
    } catch {
      /* silent */
    }
  }

  useEffect(() => {
    if (activeSubTab === "progress") {
      loadProgressData();
    }
  }, [activeSubTab]);

  async function loadProgressData() {
    try {
      const res = await fetch("/api/evolution/progress/active");
      if (res.ok) setProgressReports(await res.json());
    } catch {
      /* silent */
    }
  }

  async function handleTriggerEvolution() {
    if (!triggerDesc.trim()) return;
    setTriggering(true);
    try {
      const res = await fetch("/api/evolution/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: triggerDesc.trim() }),
      });
      if (res.ok) {
        setFeedbackMsg(t("evo.trigger_success"));
        setTriggerDesc("");
        setShowTrigger(false);
        loadEvolutionData();
      } else {
        const err = await res.json().catch(() => ({}));
        setFeedbackMsg(t("evo.trigger_fail").replace("{0}", (err as any).error || res.statusText));
      }
    } catch {
      setFeedbackMsg(t("evo.trigger_network_error"));
    } finally {
      setTriggering(false);
    }
  }

  async function handleSubmitFeedback(cycleId: string, adopted: boolean, comment?: string) {
    try {
      const res = await fetch("/api/evolution/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycleId, adopted, comment }),
      });
      if (res.ok) {
        setFeedbackMsg(adopted ? t("evo.adopted") : t("evo.rejected_feedback"));
        loadEvolutionData();
      } else {
        setFeedbackMsg(t("evo.feedback_submit_fail"));
      }
    } catch {
      setFeedbackMsg(t("evo.feedback_network_error"));
    }
  }

  async function handleTriggerSkillEvolution() {
    const skillId = skillIdInput.trim();
    const skillName = skillNameInput.trim() || skillId;
    if (!skillId) return;
    setTriggeringSkill(true);
    try {
      const res = await fetch("/api/evolution/trigger-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId, skillName }),
      });
      if (res.ok) {
        setFeedbackMsg(t("evo.trigger_skill_success", "技能进化已触发"));
        setSkillIdInput("");
        setSkillNameInput("");
        setShowTriggerSkill(false);
        loadEvolutionData();
      } else {
        const err = await res.json().catch(() => ({}));
        setFeedbackMsg(t("evo.trigger_fail", "触发失败").replace("{0}", (err as any).error || res.statusText));
      }
    } catch {
      setFeedbackMsg(t("evo.trigger_network_error"));
    } finally {
      setTriggeringSkill(false);
    }
  }

  async function handleRecordLearning() {
    setRecordSubmitting(true);
    try {
      const f = recordForm;
      const tags = f.tags ? f.tags.split(",").map(s => s.trim()).filter(Boolean) : [];
      const triggerEvolution = recordTriggerEvo;
      let result;
      switch (recordType) {
        case "correction":
          result = await learningApi.correction({
            title: f.title, context: f.context, originalError: f.originalError,
            correction: f.correction, preferredApproach: f.preferredApproach,
            source: f.source || "web-ui", tags, triggerEvolution,
          });
          break;
        case "gap":
          result = await learningApi.gap({
            capability: f.capability, title: f.title, context: f.context,
            suggestedSolution: f.suggestedSolution,
            source: f.source || "web-ui", tags, triggerEvolution,
          });
          break;
        case "failure":
          result = await learningApi.failure({
            service: f.service, endpoint: f.endpoint, error: f.error,
            context: f.context, rootCause: f.rootCause, fallback: f.fallback,
            fallbackCode: f.fallbackCode, source: f.source || "web-ui",
            severity: f.severity, tags, triggerEvolution,
          });
          break;
        case "improvement":
          result = await learningApi.improvement({
            title: f.title, description: f.description, context: f.context,
            isOutdated: f.isOutdated === "true", newApproach: f.newApproach,
            recommendedAction: f.recommendedAction, improvedCode: f.improvedCode,
            source: f.source || "web-ui", tags, triggerEvolution,
          });
          break;
      }
      setFeedbackMsg(t("evo.record_submitted", "学习记录已提交: {0}").replace("{0}", result?.message || ""));
      setRecordForm({});
    } catch {
      setFeedbackMsg(t("evo.record_submit_fail", "学习记录提交失败"));
    } finally {
      setRecordSubmitting(false);
    }
  }

  async function loadCustomCompactions(sessionId: string) {
    if (!sessionId.trim()) return;
    setCompactionLoading(true);
    setCompactionError(null);
    try {
      const data = await compactionsApi.get(sessionId.trim());
      setCustomCompactions((data.compactions || []) as CompactionSummary[]);
      if ((data.compactions || []).length === 0) {
        setCompactionError(t("evo.no_compactions_for_session", "该会话无压缩记录"));
      }
    } catch {
      setCustomCompactions([]);
      setCompactionError(t("evo.compaction_load_fail", "加载压缩链失败"));
    } finally {
      setCompactionLoading(false);
    }
  }

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}${t("evo.ms", "ms")}`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}${t("evo.seconds", "s")}`;
    return `${(ms / 60000).toFixed(1)}${t("evo.minutes", "m")}`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed": return "var(--success)";
      case "failed": return "var(--error)";
      case "rejected": return "var(--warning)";
      case "generating": return "var(--accent)";
      case "evaluating": return "#3b82f6";
      case "running": return "#3b82f6";
      case "active": return "#3b82f6";
      default: return "var(--text-muted)";
    }
  };

  const getStatusLabel = (status: string) => {
    return t(`evo.status.${status}`, status);
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical": return "var(--error)";
      case "high": return "#f97316";
      case "medium": return "var(--warning)";
      case "low": return "var(--success)";
      case "info": return "#3b82f6";
      default: return "var(--text-muted)";
    }
  };

  const getTriggerLabel = (trigger: string) => {
    const labels: Record<string, string> = {
      command_failed: t("evo.trigger_command_failed"),
      user_correction: t("evo.trigger_user_correction"),
      capability_gap: t("evo.trigger_capability_gap"),
      api_failure: t("evo.trigger_api_failure"),
      knowledge_outdated: t("evo.trigger_knowledge_outdated"),
      pattern_improvement: t("evo.trigger_pattern_improvement"),
      task_failure: t("evo.trigger_task_failure"),
      user_feedback: t("evo.trigger_user_feedback"),
    };
    return labels[trigger] || trigger;
  };

  const getCategoryLabel = (category: string) => {
    const labels: Record<string, string> = {
      error_fix: t("evo.cat_error_fix"),
      correction: t("evo.cat_correction"),
      new_capability_needed: t("evo.cat_new_capability"),
      better_approach: t("evo.cat_better_approach"),
      external_dependency: t("evo.cat_external_dependency"),
      knowledge_update: t("evo.cat_knowledge_update"),
      process_improvement: t("evo.cat_process_improvement"),
    };
    return labels[category] || category;
  };

  if (loading) {
    return <div style={s.placeholder}>{t("evo.loading", "Loading evolution data...")}</div>;
  }

  const learning = data.learning;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <h2 style={s.title}>{t("evo.dashboard_title")}</h2>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            onClick={() => setShowTrigger(!showTrigger)}
            style={{
              padding: "6px 14px",
              borderRadius: "6px",
              border: "1px solid var(--accent)",
              background: "var(--accent)",
              color: "#fff",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 600,
            }}
          >
            {t("evo.trigger_evolution")}
          </button>
          <button
            onClick={() => { setShowTriggerSkill(!showTriggerSkill); setShowTrigger(false); }}
            style={{
              padding: "6px 14px",
              borderRadius: "6px",
              border: "1px solid var(--success)",
              background: showTriggerSkill ? "var(--success)" : "transparent",
              color: showTriggerSkill ? "#fff" : "var(--success)",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 600,
            }}
          >
            {t("evo.trigger_skill_evolution", "触发技能进化")}
          </button>
          <button
            onClick={loadEvolutionData}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: "var(--bg-sidebar)",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "12px",
            }}
          >
            🔄
          </button>
        </div>
        {error && <div style={s.errorBanner}>{error}</div>}
      </div>

      {showTrigger && (
        <div style={{
          padding: "12px 16px",
          background: "var(--bg-sidebar)",
          border: "1px solid var(--border)",
          borderRadius: "8px",
          marginBottom: "12px",
          display: "flex",
          gap: "8px",
          alignItems: "center",
        }}>
          <input
            style={{
              flex: 1,
              padding: "8px 12px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: "var(--bg-secondary)",
              color: "var(--text-primary)",
              fontSize: "13px",
              outline: "none",
            }}
            placeholder={t("evo.trigger_placeholder")}
            value={triggerDesc}
            onChange={(e) => setTriggerDesc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleTriggerEvolution()}
          />
          <button
            onClick={handleTriggerEvolution}
            disabled={triggering || !triggerDesc.trim()}
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              border: "none",
              background: triggering ? "var(--text-muted)" : "var(--accent)",
              color: "#fff",
              cursor: triggering ? "not-allowed" : "pointer",
              fontSize: "12px",
              fontWeight: 600,
            }}
          >
            {triggering ? t("evo.executing") : t("evo.execute")}
          </button>
          <button
            onClick={() => setShowTrigger(false)}
            style={{
              padding: "8px 12px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "12px",
            }}
          >
            {t("evo.cancel")}
          </button>
        </div>
      )}

      {showTriggerSkill && (
        <div style={{
          padding: "12px 16px",
          background: "var(--bg-sidebar)",
          border: "1px solid var(--success)",
          borderRadius: "8px",
          marginBottom: "12px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            {t("evo.trigger_skill_desc", "输入技能 ID 和名称，触发该技能的自进化流程")}
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <input
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: "6px",
                border: "1px solid var(--border)",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                fontSize: "13px",
                outline: "none",
              }}
              placeholder={t("evo.skill_id_placeholder", "技能 ID（必填）")}
              value={skillIdInput}
              onChange={(e) => setSkillIdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleTriggerSkillEvolution()}
            />
            <input
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: "6px",
                border: "1px solid var(--border)",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                fontSize: "13px",
                outline: "none",
              }}
              placeholder={t("evo.skill_name_placeholder", "技能名称（可选，默认同 ID）")}
              value={skillNameInput}
              onChange={(e) => setSkillNameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleTriggerSkillEvolution()}
            />
            <button
              onClick={handleTriggerSkillEvolution}
              disabled={triggeringSkill || !skillIdInput.trim()}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "none",
                background: triggeringSkill ? "var(--text-muted)" : "var(--success)",
                color: "#fff",
                cursor: triggeringSkill ? "not-allowed" : "pointer",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              {triggeringSkill ? t("evo.executing") : t("evo.execute")}
            </button>
            <button
              onClick={() => setShowTriggerSkill(false)}
              style={{
                padding: "8px 12px",
                borderRadius: "6px",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "12px",
              }}
            >
              {t("evo.cancel")}
            </button>
          </div>
        </div>
      )}

      {feedbackMsg && (
        <div style={{
          padding: "8px 14px",
          borderRadius: "6px",
          marginBottom: "12px",
          background: "var(--success-bg)",
          color: "var(--success)",
          fontSize: "12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          {feedbackMsg}
          <button onClick={() => setFeedbackMsg(null)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>✕</button>
        </div>
      )}

      <div style={s.summaryRow}>
        <div style={s.summaryCard}>
          <div style={s.summaryValue}>{data.summary.totalCycles}</div>
          <div style={s.summaryLabel}>{t("evo.evolution_cycles")}</div>
        </div>
        <div style={s.summaryCard}>
          <div style={s.summaryValue}>{Math.round(data.summary.successRate * 100)}%</div>
          <div style={s.summaryLabel}>{t("evo.success_rate")}</div>
        </div>
        <div style={s.summaryCard}>
          <div style={s.summaryValue}>{learning?.totalEntries ?? 0}</div>
          <div style={s.summaryLabel}>{t("evo.learning_entries")}</div>
        </div>
        <div style={s.summaryCard}>
          <div style={s.summaryValue}>{learning?.resolvedEntries ?? 0}</div>
          <div style={s.summaryLabel}>{t("evo.resolved")}</div>
        </div>
      </div>

      <div style={s.subTabs}>
        <button style={subTabStyle(activeSubTab === "overview")} onClick={() => setActiveSubTab("overview")}>{t("evo.tab_overview")}</button>
        <button style={subTabStyle(activeSubTab === "cycles")} onClick={() => setActiveSubTab("cycles")}>{t("evo.tab_cycles")} ({data.cycles.length})</button>
        <button style={subTabStyle(activeSubTab === "feedback")} onClick={() => setActiveSubTab("feedback")}>{t("evo.tab_feedback")} ({data.feedback.length})</button>
        <button style={subTabStyle(activeSubTab === "learning")} onClick={() => setActiveSubTab("learning")}>{t("evo.tab_learning")}</button>
        <button style={subTabStyle(activeSubTab === "record")} onClick={() => setActiveSubTab("record")}>{t("evo.tab_record", "记录学习")}</button>
        <button style={subTabStyle(activeSubTab === "progress")} onClick={() => setActiveSubTab("progress")}>{t("evo.tab_progress")}</button>
        <button style={subTabStyle(activeSubTab === "patterns")} onClick={() => setActiveSubTab("patterns")}>{t("evo.tab_patterns")}</button>
        <button style={subTabStyle(activeSubTab === "help")} onClick={() => setActiveSubTab("help")}>{t("evo.tab_help")}</button>
      </div>

      <div style={s.content}>
        {activeSubTab === "overview" && renderOverview()}
        {activeSubTab === "cycles" && renderCycles()}
        {activeSubTab === "feedback" && renderFeedback()}
        {activeSubTab === "learning" && renderLearning()}
        {activeSubTab === "record" && renderRecord()}
        {activeSubTab === "progress" && renderProgress()}
        {activeSubTab === "patterns" && renderPatterns()}
        {activeSubTab === "help" && renderHelp()}
      </div>
    </div>
  );

  function renderRecord() {
    const recordTypes: Array<{ key: typeof recordType; label: string }> = [
      { key: "correction", label: t("evo.record_correction", "用户纠正") },
      { key: "gap", label: t("evo.record_gap", "能力缺口") },
      { key: "failure", label: t("evo.record_failure", "外部失败") },
      { key: "improvement", label: t("evo.record_improvement", "知识改进") },
    ];
    const fieldsByType: Record<typeof recordType, Array<{ key: string; label: string; placeholder?: string; area?: boolean }>> = {
      correction: [
        { key: "title", label: t("evo.field_title", "标题"), placeholder: t("evo.field_title_ph", "简要描述纠正内容") },
        { key: "context", label: t("evo.field_context", "上下文"), placeholder: t("evo.field_context_ph", "发生场景的上下文"), area: true },
        { key: "originalError", label: t("evo.field_original_error", "原始错误"), placeholder: t("evo.field_original_error_ph", "遇到的错误信息"), area: true },
        { key: "correction", label: t("evo.field_correction", "纠正内容"), placeholder: t("evo.field_correction_ph", "正确的做法/答案"), area: true },
        { key: "preferredApproach", label: t("evo.field_preferred_approach", "推荐方案"), placeholder: t("evo.field_preferred_approach_ph", "推荐的解决方案"), area: true },
      ],
      gap: [
        { key: "capability", label: t("evo.field_capability", "能力名称"), placeholder: t("evo.field_capability_ph", "缺失的能力") },
        { key: "title", label: t("evo.field_title", "标题"), placeholder: t("evo.field_title_ph", "简要描述") },
        { key: "context", label: t("evo.field_context", "上下文"), placeholder: t("evo.field_context_ph", "何时需要此能力"), area: true },
        { key: "suggestedSolution", label: t("evo.field_suggested_solution", "建议方案"), placeholder: t("evo.field_suggested_solution_ph", "建议的解决方式"), area: true },
      ],
      failure: [
        { key: "service", label: t("evo.field_service", "服务名"), placeholder: t("evo.field_service_ph", "如 openai-api") },
        { key: "endpoint", label: t("evo.field_endpoint", "端点"), placeholder: t("evo.field_endpoint_ph", "API 端点") },
        { key: "error", label: t("evo.field_error", "错误信息"), placeholder: t("evo.field_error_ph", "错误内容"), area: true },
        { key: "context", label: t("evo.field_context", "上下文"), placeholder: t("evo.field_context_ph", "调用上下文"), area: true },
        { key: "rootCause", label: t("evo.field_root_cause", "根本原因"), placeholder: t("evo.field_root_cause_ph", "失败的根本原因"), area: true },
        { key: "fallback", label: t("evo.field_fallback", "降级方案"), placeholder: t("evo.field_fallback_ph", "降级处理方式"), area: true },
        { key: "severity", label: t("evo.field_severity", "严重级别"), placeholder: t("evo.field_severity_ph", "critical/high/medium/low") },
      ],
      improvement: [
        { key: "title", label: t("evo.field_title", "标题"), placeholder: t("evo.field_title_ph", "改进标题") },
        { key: "description", label: t("evo.field_description", "描述"), placeholder: t("evo.field_description_ph", "改进描述"), area: true },
        { key: "context", label: t("evo.field_context", "上下文"), placeholder: t("evo.field_context_ph", "适用场景"), area: true },
        { key: "newApproach", label: t("evo.field_new_approach", "新方案"), placeholder: t("evo.field_new_approach_ph", "推荐的新做法"), area: true },
        { key: "recommendedAction", label: t("evo.field_recommended_action", "建议动作"), placeholder: t("evo.field_recommended_action_ph", "建议执行的动作"), area: true },
      ],
    };
    const fields = fieldsByType[recordType];
    const inputStyle: React.CSSProperties = {
      width: "100%", padding: "8px 12px", borderRadius: "6px",
      border: "1px solid var(--border)", background: "var(--bg-secondary)",
      color: "var(--text-primary)", fontSize: "13px", outline: "none",
      boxSizing: "border-box",
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={s.chartSection}>
          <h3 style={s.sectionTitle}>{t("evo.record_learning_title", "记录学习")}</h3>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "12px" }}>
            {t("evo.record_learning_desc", "手动向进化引擎写入学习记录，触发自适应改进。选择记录类型后填写对应字段。")}
          </div>
          {/* Record type selector */}
          <div style={{ display: "flex", gap: "6px", marginBottom: "12px", flexWrap: "wrap" }}>
            {recordTypes.map(rt => (
              <button
                key={rt.key}
                onClick={() => { setRecordType(rt.key); setRecordForm({}); }}
                style={{
                  padding: "6px 14px", borderRadius: "6px", border: "1px solid",
                  borderColor: recordType === rt.key ? "var(--accent)" : "var(--border)",
                  background: recordType === rt.key ? "var(--accent-bg)" : "var(--bg-hover)",
                  color: recordType === rt.key ? "var(--accent)" : "var(--text-secondary)",
                  cursor: "pointer", fontSize: "12px", fontWeight: 600,
                }}
              >
                {rt.label}
              </button>
            ))}
          </div>
          {/* Dynamic fields */}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {fields.map(field => (
              <div key={field.key}>
                <label style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px", display: "block" }}>
                  {field.label}
                </label>
                {field.area ? (
                  <textarea
                    value={recordForm[field.key] || ""}
                    onChange={(e) => setRecordForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    rows={3}
                    style={{ ...inputStyle, resize: "vertical", minHeight: "60px", fontFamily: "inherit" }}
                  />
                ) : (
                  <input
                    type="text"
                    value={recordForm[field.key] || ""}
                    onChange={(e) => setRecordForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    style={inputStyle}
                  />
                )}
              </div>
            ))}
            {/* Common: tags & source */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <div>
                <label style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px", display: "block" }}>
                  {t("evo.field_tags", "标签")}
                </label>
                <input
                  type="text"
                  value={recordForm.tags || ""}
                  onChange={(e) => setRecordForm(prev => ({ ...prev, tags: e.target.value }))}
                  placeholder={t("evo.field_tags_ph", "逗号分隔的标签")}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px", display: "block" }}>
                  {t("evo.field_source", "来源")}
                </label>
                <input
                  type="text"
                  value={recordForm.source || ""}
                  onChange={(e) => setRecordForm(prev => ({ ...prev, source: e.target.value }))}
                  placeholder={t("evo.field_source_ph", "默认 web-ui")}
                  style={inputStyle}
                />
              </div>
            </div>
            {/* Trigger evolution toggle */}
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-secondary)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={recordTriggerEvo}
                onChange={(e) => setRecordTriggerEvo(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              {t("evo.trigger_evolution_flag", "提交后触发进化流程")}
            </label>
          </div>
          {/* Submit button */}
          <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
            <button
              onClick={handleRecordLearning}
              disabled={recordSubmitting}
              style={{
                padding: "8px 20px", borderRadius: "6px", border: "none",
                background: recordSubmitting ? "var(--text-muted)" : "var(--accent)",
                color: "#fff", cursor: recordSubmitting ? "not-allowed" : "pointer",
                fontSize: "13px", fontWeight: 600, opacity: recordSubmitting ? 0.5 : 1,
              }}
            >
              {recordSubmitting ? t("evo.submitting", "提交中...") : t("evo.submit_record", "提交记录")}
            </button>
            <button
              onClick={() => setRecordForm({})}
              style={{
                padding: "8px 16px", borderRadius: "6px",
                border: "1px solid var(--border)", background: "var(--bg-hover)",
                color: "var(--text-secondary)", cursor: "pointer", fontSize: "13px",
              }}
            >
              {t("evo.clear_form", "清空")}
            </button>
          </div>
        </div>

        {/* Compaction chain viewer by sessionId */}
        <div style={s.chartSection}>
          <h3 style={s.sectionTitle}>{t("evo.compaction_viewer_title", "压缩链查看器")}</h3>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "12px" }}>
            {t("evo.compaction_viewer_desc", "输入任意会话 ID 查看其压缩链历史。")}
          </div>
          <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
            <input
              type="text"
              value={compactionSessionInput}
              onChange={(e) => setCompactionSessionInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadCustomCompactions(compactionSessionInput)}
              placeholder={t("evo.session_id_placeholder", "会话 ID（如 web-ui 或自定义会话 ID）")}
              style={inputStyle}
            />
            <button
              onClick={() => loadCustomCompactions(compactionSessionInput)}
              disabled={compactionLoading || !compactionSessionInput.trim()}
              style={{
                padding: "8px 16px", borderRadius: "6px", border: "none",
                background: compactionLoading || !compactionSessionInput.trim() ? "var(--text-muted)" : "var(--accent)",
                color: "#fff", cursor: compactionLoading || !compactionSessionInput.trim() ? "not-allowed" : "pointer",
                fontSize: "13px", fontWeight: 600, opacity: compactionLoading ? 0.5 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {compactionLoading ? t("evo.loading", "加载中...") : t("evo.view_compactions", "查看")}
            </button>
          </div>
          {compactionError && (
            <div style={{ padding: "10px 12px", borderRadius: "6px", background: "var(--warning-bg)", color: "var(--warning)", fontSize: "12px" }}>
              {compactionError}
            </div>
          )}
          {customCompactions.length > 0 && (
            <div style={s.compactionTimeline}>
              {customCompactions.map((comp, i) => (
                <div key={comp.id || i} style={s.compactionTimelineItem}>
                  <div style={s.compactionTimelineDot} />
                  <div>
                    <div style={s.compactionTimelineTitle}>
                      {t("evo.compaction_entry").replace("{0}", String(i + 1)).replace("{1}", comp.parentSessionId).replace("{2}", comp.successorSessionId)}
                    </div>
                    <div style={s.compactionTimelineDesc}>{comp.summary.slice(0, 200)}</div>
                    <div style={s.compactionTimelineTime}>
                      {new Date(comp.timestamp).toLocaleString(locale)} · {t("evo.compacted_turns").replace("{0}", String(comp.compactedTurnCount))}
                    </div>
                    {comp.keyFacts.length > 0 && (
                      <div style={{ marginTop: "6px" }}>
                        {comp.keyFacts.slice(0, 5).map((fact, fi) => (
                          <span key={fi} style={s.factTag}>{fact.slice(0, 40)}</span>
                        ))}
                      </div>
                    )}
                    {comp.decisions.length > 0 && (
                      <div style={{ marginTop: "4px" }}>
                        {comp.decisions.slice(0, 3).map((d, di) => (
                          <span key={di} style={s.decisionTag}>{d.slice(0, 40)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderOverview() {
    return (
      <div style={s.overview}>
        {data.cycles.length === 0 && (!learning || learning.totalEntries === 0) && compactions.length === 0 ? (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>🧬</div>
            <div>{t("evo.no_data")}</div>
            <div style={s.emptyHint}>
              {t("evo.no_data_hint")}
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
              <div style={s.chartSection}>
                <h3 style={s.sectionTitle}>{t("evo.evolution_stats")}</h3>
                <div style={s.overviewMetricRow}>
                  <span style={s.overviewMetricLabel}>{t("evo.evolution_cycles")}</span>
                  <span style={s.overviewMetricLarge}>{data.summary.totalCycles}</span>
                </div>
                <div style={s.progressBarTrack}>
                  <div style={{ ...s.progressBarFill, width: `${Math.round(data.summary.successRate * 100)}%`, background: "var(--success)" }} />
                </div>
                <div style={{ ...s.overviewMetricRow, marginTop: "8px" }}>
                  <span style={s.overviewMetricLabel}>{t("evo.success_rate")}</span>
                  <span style={s.overviewMetricValue}>{Math.round(data.summary.successRate * 100)}%</span>
                </div>
                <div style={s.overviewMetricRow}>
                  <span style={s.overviewMetricLabel}>{t("evo.candidates")}</span>
                  <span style={s.overviewMetricValue}>{data.summary.totalCandidates}</span>
                </div>
              </div>

              <div style={s.chartSection}>
                <h3 style={s.sectionTitle}>{t("evo.learning_stats_title")}</h3>
                <div style={s.overviewMetricRow}>
                  <span style={s.overviewMetricLabel}>{t("evo.learning_entries")}</span>
                  <span style={s.overviewMetricLarge}>{learning?.totalEntries ?? 0}</span>
                </div>
                <div style={s.progressBarTrack}>
                  <div style={{ ...s.progressBarFill, width: `${Math.round((learning?.resolutionRate ?? 0) * 100)}%`, background: "var(--accent)" }} />
                </div>
                <div style={{ ...s.overviewMetricRow, marginTop: "8px" }}>
                  <span style={s.overviewMetricLabel}>{t("evo.resolution_rate")}</span>
                  <span style={s.overviewMetricValue}>{learning ? `${Math.round(learning.resolutionRate * 100)}%` : t("common.na", "N/A")}</span>
                </div>
                <div style={s.overviewMetricRow}>
                  <span style={s.overviewMetricLabel}>{t("evo.resolved_unresolved")}</span>
                  <span style={s.overviewMetricValue}>
                    <span style={{ color: "var(--success)" }}>{learning?.resolvedEntries ?? 0}</span>
                    {t("common.slash", " / ")}
                    <span style={{ color: "var(--warning)" }}>{learning?.unresolvedEntries ?? 0}</span>
                  </span>
                </div>
              </div>
            </div>

            <div style={s.chartSection}>
              <h3 style={s.sectionTitle}>{t("evo.compaction_chain")}</h3>
              {compactions.length === 0 ? (
                <div style={s.emptySmall}>{t("evo.no_compactions")}</div>
              ) : (
                <div style={s.compactionTimeline}>
                  {compactions.map((comp, i) => (
                    <div key={comp.id} style={s.compactionTimelineItem}>
                      <div style={s.compactionTimelineDot} />
                      <div>
                        <div style={s.compactionTimelineTitle}>
                          {t("evo.compaction_entry").replace("{0}", String(i + 1)).replace("{1}", comp.parentSessionId).replace("{2}", comp.successorSessionId)}
                        </div>
                        <div style={s.compactionTimelineDesc}>{comp.summary.slice(0, 200)}</div>
                        <div style={s.compactionTimelineTime}>
                          {new Date(comp.timestamp).toLocaleString(locale)} · {t("evo.compacted_turns").replace("{0}", String(comp.compactedTurnCount))}
                        </div>
                        {comp.keyFacts.length > 0 && (
                          <div style={{ marginTop: "6px" }}>
                            {comp.keyFacts.slice(0, 5).map((fact, fi) => (
                              <span key={fi} style={s.factTag}>{fact.slice(0, 40)}</span>
                            ))}
                          </div>
                        )}
                        {comp.decisions.length > 0 && (
                          <div style={{ marginTop: "4px" }}>
                            {comp.decisions.slice(0, 3).map((d, di) => (
                              <span key={di} style={s.decisionTag}>{d.slice(0, 40)}</span>
                            ))}
                          </div>
                        )}
                        {comp.pendingItems.length > 0 && (
                          <div style={{ marginTop: "4px" }}>
                            {comp.pendingItems.slice(0, 3).map((p, pi) => (
                              <span key={pi} style={s.pendingTag}>{p.slice(0, 40)}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={s.chartSection}>
              <h3 style={s.sectionTitle}>{t("evo.recent_cycles")}</h3>
              <div style={s.timeline}>
                {data.cycles.slice(-10).reverse().map((cycle) => (
                  <div key={cycle.id} style={s.timelineItem}>
                    <div style={{ ...s.timelineDot, background: getStatusColor(cycle.status) }} />
                    <div style={s.timelineContent}>
                      <div style={s.timelineHeader}>
                        <span style={s.timelineSource}>{cycle.source}</span>
                        <span style={{ ...s.timelineStatus, color: getStatusColor(cycle.status) }}>
                          {getStatusLabel(cycle.status)}
                        </span>
                      </div>
                      <div style={s.timelineMeta}>
                        {cycle.candidatesGenerated} {t("evo.candidates", "candidates")} · {formatDuration(cycle.duration)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={s.chartSection}>
              <h3 style={s.sectionTitle}>{t("evo.success_rate_trend")}</h3>
              <div style={s.barChart}>
                {data.feedback.slice(-20).map((fb, i) => (
                  <div key={i} style={s.barContainer}>
                    <div style={s.barLabel}>#{i + 1}</div>
                    <div style={s.barTrack}>
                      <div style={{
                        ...s.bar,
                        width: `${Math.round(fb.successRate * 100)}%`,
                        background: fb.successRate > 0.8 ? "var(--success)" : fb.successRate > 0.5 ? "var(--warning)" : "var(--error)",
                      }} />
                    </div>
                    <div style={s.barPercent}>{Math.round(fb.successRate * 100)}%</div>
                  </div>
                ))}
                {data.feedback.length === 0 && <div style={s.emptySmall}>{t("evo.no_feedback_data")}</div>}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  function renderCycles() {
    return (
      <div style={s.tableContainer}>
        <table style={s.table}>
          <thead>
            <tr>
              <th>{t("evo.col_id", "ID")}</th>
              <th>{t("evo.col_source")}</th>
              <th>{t("evo.col_status")}</th>
              <th>{t("evo.col_candidates")}</th>
              <th>{t("evo.col_duration")}</th>
              <th>{t("evo.col_start_time")}</th>
              <th>{t("evo.col_actions")}</th>
            </tr>
          </thead>
          <tbody>
            {data.cycles.length === 0 ? (
              <tr><td colSpan={7} style={s.emptyCell}>{t("evo.no_cycle_records")}</td></tr>
            ) : (
              data.cycles.map((cycle) => (
                <tr key={cycle.id}>
                  <td style={s.monoCell}>{cycle.id.slice(0, 8)}...</td>
                  <td>{cycle.source}</td>
                  <td>
                    <span style={{ ...s.statusBadge, background: getStatusColor(cycle.status) + "22", color: getStatusColor(cycle.status) }}>
                      {getStatusLabel(cycle.status)}
                    </span>
                  </td>
                  <td>{t("evo.candidates_passed").replace("{0}", String(cycle.candidatesGenerated)).replace("{1}", String(cycle.candidatesPassed))}</td>
                  <td>{formatDuration(cycle.duration)}</td>
                  <td style={s.monoCell}>{new Date(cycle.startedAt).toLocaleString(locale)}</td>
                  <td>
                    {cycle.status === "completed" && (
                      <div style={{ display: "flex", gap: "4px" }}>
                        <button
                          onClick={() => handleSubmitFeedback(cycle.id, true)}
                          style={{
                            padding: "2px 8px",
                            borderRadius: "4px",
                            border: "1px solid var(--success)",
                            background: "transparent",
                            color: "var(--success)",
                            cursor: "pointer",
                            fontSize: "11px",
                          }}
                          title={t("evo.adopt_suggestion")}
                        >
                          {t("evo.adopt")}
                        </button>
                        <button
                          onClick={() => handleSubmitFeedback(cycle.id, false)}
                          style={{
                            padding: "2px 8px",
                            borderRadius: "4px",
                            border: "1px solid var(--error)",
                            background: "transparent",
                            color: "var(--error)",
                            cursor: "pointer",
                            fontSize: "11px",
                          }}
                          title={t("evo.reject_suggestion")}
                        >
                          {t("evo.reject")}
                        </button>
                      </div>
                    )}
                    {(cycle.status === "generating" || cycle.status === "evaluating" || cycle.status === "running" || cycle.status === "analyzing") && (
                      <span style={{ fontSize: "11px", color: "var(--accent)" }}>{t("evo.processing")}</span>
                    )}
                    {cycle.status === "failed" && (
                      <span style={{ fontSize: "11px", color: "var(--error)" }}>{t("evo.failed")}</span>
                    )}
                    {cycle.status === "rejected" && (
                      <span style={{ fontSize: "11px", color: "var(--warning)" }}>{t("evo.already_rejected")}</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    );
  }

  function renderFeedback() {
    return (
      <div style={s.tableContainer}>
        <table style={s.table}>
          <thead>
            <tr>
              <th>{t("evo.col_cycle")}</th>
              <th>{t("evo.col_skill")}</th>
              <th>{t("evo.col_success_rate")}</th>
              <th>{t("evo.col_adoption_rate")}</th>
              <th>{t("evo.col_error_rate")}</th>
              <th>{t("evo.col_token", "Token")}</th>
              <th>{t("evo.col_collected_at")}</th>
            </tr>
          </thead>
          <tbody>
            {data.feedback.length === 0 ? (
              <tr><td colSpan={7} style={s.emptyCell}>{t("evo.no_feedback_data")}</td></tr>
            ) : (
              data.feedback.map((fb, i) => (
                <tr key={i}>
                  <td style={s.monoCell}>{fb.cycleId.slice(0, 8)}...</td>
                  <td style={s.monoCell}>{fb.skillId.slice(0, 8)}...</td>
                  <td>
                    <span style={{ color: fb.successRate > 0.8 ? "var(--success)" : fb.successRate > 0.5 ? "var(--warning)" : "var(--error)" }}>
                      {Math.round(fb.successRate * 100)}%
                    </span>
                  </td>
                  <td>{Math.round(fb.userAdoptionRate * 100)}%</td>
                  <td style={{ color: fb.errorRate > 0.3 ? "var(--error)" : "var(--success)" }}>
                    {Math.round(fb.errorRate * 100)}%
                  </td>
                  <td>{fb.tokenConsumption.toLocaleString()}</td>
                  <td style={s.monoCell}>{new Date(fb.collectedAt).toLocaleString(locale)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    );
  }

  function renderLearning() {
    const ls = data.learning;

    return (
      <div style={s.learningContainer}>
        {ls && (
          <div style={s.learningStats}>
            <div style={s.statCard}>
              <div style={s.statValue}>{ls.totalEntries}</div>
              <div style={s.statLabel}>{t("evo.total_entries")}</div>
            </div>
            <div style={s.statCard}>
              <div style={{ ...s.statValue, color: "var(--success)" }}>{Math.round(ls.resolutionRate * 100)}%</div>
              <div style={s.statLabel}>{t("evo.resolution_rate")}</div>
            </div>
            <div style={s.statCard}>
              <div style={{ ...s.statValue, color: "#f97316" }}>{ls.unresolvedEntries}</div>
              <div style={s.statLabel}>{t("evo.pending_resolve")}</div>
            </div>
            <div style={s.statCard}>
              <div style={{ ...s.statValue, color: "var(--accent)" }}>{ls.newThisWeek}</div>
              <div style={s.statLabel}>{t("evo.new_this_week")}</div>
            </div>
          </div>
        )}

        {ls && ls.topTags.length > 0 && (
          <div style={s.tagRow}>
            {ls.topTags.slice(0, 8).map(({ tag, count }) => (
              <span key={tag} style={s.learningTag}>
                {tag} <span style={s.tagCount}>{count}</span>
              </span>
            ))}
          </div>
        )}

        <div style={s.tableContainer}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={{ width: "40px" }}></th>
                <th>{t("evo.col_title")}</th>
                <th>{t("evo.col_trigger")}</th>
                <th>{t("evo.col_category")}</th>
                <th>{t("evo.col_source")}</th>
                <th>{t("evo.col_time")}</th>
              </tr>
            </thead>
            <tbody>
              {learningEntries.length === 0 ? (
                <tr><td colSpan={6} style={s.emptyCell}>
                  {ls && ls.totalEntries > 0 ? t("evo.loading") : t("evo.no_learning_records")}
                </td></tr>
              ) : (
                learningEntries.map((entry) => (
                  <tr key={entry.id} style={{ opacity: entry.resolved ? 0.7 : 1 }}>
                    <td>
                      <span style={{ color: entry.resolved ? "var(--success)" : "var(--warning)", fontSize: "14px" }}>
                        {entry.resolved ? "✅" : "📝"}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 500, color: "var(--text-primary)" }}>{entry.title}</div>
                      {entry.solution && <div style={{ fontSize: "11px", color: "var(--success)", marginTop: "2px" }}>{t("evo.resolved_prefix")}{entry.solution.slice(0, 80)}{entry.solution.length > 80 ? "..." : ""}</div>}
                    </td>
                    <td>
                      <span style={{
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontSize: "11px",
                        background: "var(--bg-hover)",
                        color: getStatusColor(entry.resolved ? "completed" : "generating"),
                        whiteSpace: "nowrap",
                      }}>
                        {getTriggerLabel(entry.trigger)}
                      </span>
                    </td>
                    <td style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{getCategoryLabel(entry.category)}</td>
                    <td style={s.monoCell}>{entry.source.slice(0, 20)}</td>
                    <td style={s.monoCell}>
                      {new Date(entry.timestamp).toLocaleString(locale, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {learningSessions.length > 0 && (
          <div style={{ marginTop: "16px" }}>
            <h3 style={s.sectionTitle}>{t("evo.learning_sessions")} ({learningSessions.length})</h3>
            {learningSessions.slice(0, 10).map((session) => (
              <div key={session.id} style={s.sessionCard}>
                <div style={s.sessionHeader}>
                  <span style={s.sessionTask}>{session.taskDescription}</span>
                  <span style={{
                    ...s.statusBadge,
                    background: getStatusColor(session.status) + "22",
                    color: getStatusColor(session.status),
                  }}>
                    {getStatusLabel(session.status)}
                  </span>
                </div>
                {session.summary && <div style={s.sessionSummary}>{session.summary}</div>}
                <div style={s.sessionMeta}>
                  {t("evo.entries_count").replace("{0}", String(session.entries.length))} · {session.completedAt
                    ? formatDuration(new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime())
                    : t("evo.in_progress")}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderProgress() {
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={s.sectionTitle}>{t("evo.active_progress")} ({progressReports.length})</h3>
          <button
            onClick={loadProgressData}
            style={{
              padding: "4px 12px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: "var(--bg-sidebar)",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "12px",
            }}
          >
            {t("evo.refresh")}
          </button>
        </div>

        {progressReports.length === 0 ? (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>📊</div>
            <div>{t("evo.no_active_progress")}</div>
            <div style={s.emptyHint}>{t("evo.no_active_progress_hint")}</div>
          </div>
        ) : (
          progressReports.map((report) => (
            <div key={report.id} style={s.progressCard}>
              <div style={s.progressHeader}>
                <span style={{ color: "var(--section-title-color)", fontWeight: 600, fontSize: "14px" }}>
                  {t(`evo.phase.${report.phase}`, report.phase)}
                </span>
                <span style={{
                  padding: "2px 8px",
                  borderRadius: "10px",
                  fontSize: "11px",
                  background: getStatusColor(report.status) + "22",
                  color: getStatusColor(report.status),
                }}>
                  {getStatusLabel(report.status)}
                </span>
              </div>
              <div style={{ margin: "8px 0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                  <span style={{ fontSize: "13px", color: "var(--text-primary)" }}>{report.message}</span>
                  <span style={{ fontSize: "12px", color: "var(--section-title-color)", fontWeight: "bold" }}>
                    {report.progress}%
                  </span>
                </div>
                <div style={s.progressTrack}>
                  <div style={{
                    ...s.progressBar,
                    width: `${report.progress}%`,
                  }} />
                </div>
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                {t("evo.step_progress").replace("{0}", String(report.step)).replace("{1}", String(report.totalSteps))} · {new Date(report.startedAt).toLocaleTimeString(locale)}
              </div>
              {report.details && (
                <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px", fontStyle: "italic" }}>
                  {report.details}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    );
  }

  function renderPatterns() {
    return (
      <div style={s.patternsGrid}>
        {data.patterns.map((pattern) => (
          <div key={pattern.name} style={s.patternCard}>
            <div style={s.patternHeader}>
              <div style={s.patternName}>{pattern.name}</div>
              <div style={{
                ...s.patternBadge,
                background: pattern.count > 0 ? "#7c3aed22" : "#6666",
                color: pattern.count > 0 ? "var(--section-title-color)" : "var(--text-secondary)",
              }}>
                {t("evo.times_count").replace("{0}", String(pattern.count))}
              </div>
            </div>
            <div style={s.patternConfidence}>
              <div style={s.confidenceLabel}>{t("evo.confidence").replace("{0}", String(Math.round(pattern.confidence * 100)))}</div>
              <div style={s.confidenceTrack}>
                <div style={{
                  ...s.confidenceBar,
                  width: `${Math.round(pattern.confidence * 100)}%`,
                  background: pattern.confidence > 0.7 ? "var(--success)" : pattern.confidence > 0.4 ? "var(--warning)" : "var(--error)",
                }} />
              </div>
            </div>
          </div>
        ))}
        {data.patterns.length === 0 && (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>📊</div>
            <div>{t("evo.no_patterns")}</div>
            <div style={s.emptyHint}>{t("evo.no_patterns_hint")}</div>
          </div>
        )}
      </div>
    );
  }

  function renderHelp() {
    return (
      <div style={s.helpContainer}>
        <div style={s.helpSection}>
          <h3 style={s.helpTitle}>{t("evo.help_what_is")}</h3>
          <div style={s.helpText}>
            {t("evo.help_what_is_desc")}
          </div>
        </div>

        <div style={s.helpSection}>
          <h3 style={s.helpTitle}>{t("evo.help_scenarios")}</h3>
          <div style={s.helpGrid}>
            <div style={s.helpCard}>
              <div style={s.helpCardIcon}>🔧</div>
              <div style={s.helpCardTitle}>{t("evo.help_auto_fix")}</div>
              <div style={s.helpCardDesc}>{t("evo.help_auto_fix_desc")}</div>
            </div>
            <div style={s.helpCard}>
              <div style={s.helpCardIcon}>📈</div>
              <div style={s.helpCardTitle}>{t("evo.help_perf_opt")}</div>
              <div style={s.helpCardDesc}>{t("evo.help_perf_opt_desc")}</div>
            </div>
            <div style={s.helpCard}>
              <div style={s.helpCardIcon}>🆕</div>
              <div style={s.helpCardTitle}>{t("evo.help_cap_expand")}</div>
              <div style={s.helpCardDesc}>{t("evo.help_cap_expand_desc")}</div>
            </div>
            <div style={s.helpCard}>
              <div style={s.helpCardIcon}>🔄</div>
              <div style={s.helpCardTitle}>{t("evo.help_knowledge_update")}</div>
              <div style={s.helpCardDesc}>{t("evo.help_knowledge_update_desc")}</div>
            </div>
          </div>
        </div>

        <div style={s.helpSection}>
          <h3 style={s.helpTitle}>{t("evo.help_guide")}</h3>
          <div style={s.helpSteps}>
            <div style={s.helpStep}>
              <div style={s.helpStepNum}>1</div>
              <div style={s.helpStepContent}>
                <div style={s.helpStepTitle}>{t("evo.help_auto_trigger")}</div>
                <div style={s.helpStepDesc}>{t("evo.help_auto_trigger_desc")}</div>
              </div>
            </div>
            <div style={s.helpStep}>
              <div style={s.helpStepNum}>2</div>
              <div style={s.helpStepContent}>
                <div style={s.helpStepTitle}>{t("evo.help_manual_trigger")}</div>
                <div style={s.helpStepDesc}>{t("evo.help_manual_trigger_desc")}</div>
              </div>
            </div>
            <div style={s.helpStep}>
              <div style={s.helpStepNum}>3</div>
              <div style={s.helpStepContent}>
                <div style={s.helpStepTitle}>{t("evo.help_view_progress")}</div>
                <div style={s.helpStepDesc}>{t("evo.help_view_progress_desc")}</div>
              </div>
            </div>
            <div style={s.helpStep}>
              <div style={s.helpStepNum}>4</div>
              <div style={s.helpStepContent}>
                <div style={s.helpStepTitle}>{t("evo.help_feedback")}</div>
                <div style={s.helpStepDesc}>{t("evo.help_feedback_desc")}</div>
              </div>
            </div>
          </div>
        </div>

        <div style={s.helpSection}>
          <h3 style={s.helpTitle}>{t("evo.help_flow")}</h3>
          <div style={s.helpFlow}>
            <div style={s.helpFlowNode}>
              <div style={s.helpFlowLabel}>{t("evo.help_flow_discover")}</div>
              <div style={s.helpFlowDesc}>{t("evo.help_flow_discover_desc")}</div>
            </div>
            <div style={s.helpFlowArrow}>→</div>
            <div style={s.helpFlowNode}>
              <div style={s.helpFlowLabel}>{t("evo.help_flow_generate")}</div>
              <div style={s.helpFlowDesc}>{t("evo.help_flow_generate_desc")}</div>
            </div>
            <div style={s.helpFlowArrow}>→</div>
            <div style={s.helpFlowNode}>
              <div style={s.helpFlowLabel}>{t("evo.help_flow_evaluate")}</div>
              <div style={s.helpFlowDesc}>{t("evo.help_flow_evaluate_desc")}</div>
            </div>
            <div style={s.helpFlowArrow}>→</div>
            <div style={s.helpFlowNode}>
              <div style={s.helpFlowLabel}>{t("evo.help_flow_deploy")}</div>
              <div style={s.helpFlowDesc}>{t("evo.help_flow_deploy_desc")}</div>
            </div>
          </div>
        </div>

        <div style={s.helpSection}>
          <h3 style={s.helpTitle}>{t("evo.help_metrics")}</h3>
          <div style={s.helpMetrics}>
            <div style={s.helpMetric}>
              <div style={s.helpMetricValue}>{t("evo.help_metric_success_rate")}</div>
              <div style={s.helpMetricDesc}>{t("evo.help_metric_success_rate_desc")}</div>
            </div>
            <div style={s.helpMetric}>
              <div style={s.helpMetricValue}>{t("evo.help_metric_candidates")}</div>
              <div style={s.helpMetricDesc}>{t("evo.help_metric_candidates_desc")}</div>
            </div>
            <div style={s.helpMetric}>
              <div style={s.helpMetricValue}>{t("evo.help_metric_adoption")}</div>
              <div style={s.helpMetricDesc}>{t("evo.help_metric_adoption_desc")}</div>
            </div>
            <div style={s.helpMetric}>
              <div style={s.helpMetricValue}>{t("evo.help_metric_resolution")}</div>
              <div style={s.helpMetricDesc}>{t("evo.help_metric_resolution_desc")}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

const s: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  },
  header: {
    padding: "16px 20px 12px",
    borderBottom: "1px solid var(--border)",
  },
  title: {
    margin: 0,
    fontSize: "18px",
    color: "var(--section-title-color)",
    fontWeight: 600,
  },
  errorBanner: {
    marginTop: "8px",
    padding: "8px 12px",
    borderRadius: "6px",
    background: "var(--error-bg)",
    color: "var(--error)",
    fontSize: "12px",
  },
  summaryRow: {
    display: "flex",
    gap: "12px",
    padding: "16px 20px",
  },
  summaryCard: {
    flex: 1,
    padding: "12px",
    borderRadius: "10px",
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border)",
    textAlign: "center",
  },
  summaryValue: {
    fontSize: "24px",
    fontWeight: "bold",
    color: "var(--section-title-color)",
    marginBottom: "4px",
  },
  summaryLabel: {
    fontSize: "11px",
    color: "var(--text-secondary)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
  },
  subTabs: {
    display: "flex",
    gap: "4px",
    padding: "0 20px",
    borderBottom: "1px solid var(--border)",
    overflowX: "auto" as const,
    flexWrap: "nowrap" as const,
  },
  content: {
    flex: 1,
    overflow: "auto",
    padding: "16px 20px",
  },
  overview: {
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "60px 20px",
    color: "var(--text-muted)",
    fontSize: "14px",
    textAlign: "center" as const,
  },
  emptyIcon: {
    fontSize: "48px",
    marginBottom: "16px",
  },
  emptyHint: {
    marginTop: "8px",
    fontSize: "12px",
    color: "var(--text-muted)",
    maxWidth: "400px",
  },
  emptySmall: {
    padding: "20px",
    textAlign: "center" as const,
    color: "var(--text-muted)",
    fontSize: "13px",
  },
  overviewMetricRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "8px",
  },
  overviewMetricLabel: {
    color: "var(--text-muted)",
    fontSize: "12px",
  },
  overviewMetricValue: {
    color: "var(--text-primary)",
    fontSize: "14px",
    fontWeight: "bold" as const,
  },
  overviewMetricLarge: {
    color: "var(--accent)",
    fontSize: "32px",
    fontWeight: "bold" as const,
  },
  progressBarTrack: {
    height: "6px",
    borderRadius: "3px",
    background: "var(--bg-hover)",
    marginTop: "8px",
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    borderRadius: "3px",
    transition: "width 0.5s",
  },
  compactionTimeline: {
    position: "relative" as const,
    paddingLeft: "24px",
    marginTop: "8px",
  },
  compactionTimelineItem: {
    position: "relative" as const,
    paddingBottom: "16px",
    borderLeft: "2px solid var(--border)",
    paddingLeft: "16px",
  },
  compactionTimelineDot: {
    position: "absolute" as const,
    left: "-7px",
    top: "2px",
    width: "12px",
    height: "12px",
    borderRadius: "50%",
    background: "var(--accent)",
    border: "2px solid var(--bg-sidebar)",
  },
  compactionTimelineTitle: {
    color: "var(--text-primary)",
    fontSize: "13px",
    fontWeight: "bold" as const,
  },
  compactionTimelineDesc: {
    color: "var(--text-secondary)",
    fontSize: "11px",
    marginTop: "2px",
  },
  compactionTimelineTime: {
    color: "var(--text-muted)",
    fontSize: "10px",
    marginTop: "2px",
  },
  factTag: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    background: "var(--accent-bg)",
    color: "var(--accent)",
    margin: "2px 4px 2px 0",
  },
  decisionTag: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    background: "var(--success-bg)",
    color: "var(--success)",
    margin: "2px 4px 2px 0",
  },
  pendingTag: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    background: "var(--warning-bg)",
    color: "var(--warning)",
    margin: "2px 4px 2px 0",
  },
  chartSection: {
    padding: "16px",
    borderRadius: "10px",
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border)",
  },
  sectionTitle: {
    margin: "0 0 16px 0",
    fontSize: "14px",
    color: "var(--section-title-color)",
    fontWeight: 600,
  },
  timeline: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  timelineItem: {
    display: "flex",
    gap: "12px",
    alignItems: "flex-start",
  },
  timelineDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    marginTop: "4px",
    flexShrink: 0,
  },
  timelineContent: {
    flex: 1,
    padding: "4px 0",
  },
  timelineHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  timelineSource: {
    fontSize: "13px",
    color: "var(--text-primary)",
    textTransform: "capitalize" as const,
  },
  timelineStatus: {
    fontSize: "12px",
    fontWeight: "bold",
    textTransform: "uppercase" as const,
  },
  timelineMeta: {
    fontSize: "11px",
    color: "var(--text-muted)",
    marginTop: "2px",
  },
  barChart: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  barContainer: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  barLabel: {
    width: "30px",
    fontSize: "11px",
    color: "var(--text-secondary)",
    textAlign: "right" as const,
  },
  barTrack: {
    flex: 1,
    height: "12px",
    borderRadius: "6px",
    background: "var(--border)",
    overflow: "hidden",
  },
  bar: {
    height: "100%",
    borderRadius: "6px",
    transition: "width 0.3s ease",
  },
  barPercent: {
    width: "40px",
    fontSize: "11px",
    color: "var(--text-secondary)",
  },
  tableContainer: {
    overflow: "auto",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "13px",
  },
  monoCell: {
    fontFamily: "monospace",
    fontSize: "12px",
  },
  emptyCell: {
    padding: "30px",
    textAlign: "center" as const,
    color: "var(--text-muted)",
  },
  statusBadge: {
    padding: "2px 8px",
    borderRadius: "10px",
    fontSize: "11px",
    fontWeight: "bold",
    textTransform: "uppercase" as const,
  },
  patternsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "12px",
  },
  patternCard: {
    padding: "16px",
    borderRadius: "10px",
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border)",
  },
  patternHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "12px",
  },
  patternName: {
    fontSize: "14px",
    fontWeight: "bold",
    color: "var(--text-primary)",
  },
  patternBadge: {
    padding: "2px 8px",
    borderRadius: "10px",
    fontSize: "11px",
  },
  patternConfidence: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  confidenceLabel: {
    fontSize: "12px",
    color: "var(--text-secondary)",
  },
  confidenceTrack: {
    height: "6px",
    borderRadius: "3px",
    background: "var(--border)",
    overflow: "hidden",
  },
  confidenceBar: {
    height: "100%",
    borderRadius: "3px",
    transition: "width 0.5s ease",
  },
  placeholder: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "var(--text-muted)",
    fontSize: "16px",
  },
  learningContainer: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  learningStats: {
    display: "flex",
    gap: "12px",
  },
  statCard: {
    flex: 1,
    padding: "12px",
    borderRadius: "10px",
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border)",
    textAlign: "center",
  },
  statValue: {
    fontSize: "22px",
    fontWeight: "bold",
    color: "var(--section-title-color)",
    marginBottom: "4px",
  },
  statLabel: {
    fontSize: "11px",
    color: "var(--text-secondary)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
  },
  tagRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  },
  learningTag: {
    padding: "4px 10px",
    borderRadius: "12px",
    background: "var(--bg-hover)",
    fontSize: "12px",
    color: "var(--section-title-color)",
  },
  tagCount: {
    color: "var(--text-secondary)",
    fontSize: "10px",
    marginLeft: "4px",
  },
  sessionCard: {
    padding: "12px",
    borderRadius: "8px",
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border)",
    marginBottom: "8px",
  },
  sessionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "6px",
  },
  sessionTask: {
    fontSize: "13px",
    color: "var(--text-primary)",
    fontWeight: 500,
  },
  sessionSummary: {
    fontSize: "12px",
    color: "var(--text-secondary)",
    marginTop: "4px",
    whiteSpace: "pre-line" as const,
  },
  sessionMeta: {
    fontSize: "11px",
    color: "var(--text-muted)",
    marginTop: "8px",
  },
  progressCard: {
    padding: "14px",
    borderRadius: "10px",
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border)",
    marginBottom: "10px",
  },
  progressHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "8px",
  },
  progressTrack: {
    height: "8px",
    borderRadius: "4px",
    background: "var(--border)",
    overflow: "hidden",
  },
  progressBar: {
    height: "100%",
    borderRadius: "4px",
    background: "linear-gradient(90deg, var(--accent), var(--section-title-color))",
    transition: "width 0.5s ease",
  },
  helpContainer: {
    display: "flex",
    flexDirection: "column",
    gap: "24px",
  },
  helpSection: {
    padding: "16px",
    borderRadius: "10px",
    background: "var(--bg-sidebar)",
    border: "1px solid var(--border)",
  },
  helpTitle: {
    margin: "0 0 12px 0",
    fontSize: "15px",
    color: "var(--section-title-color)",
    fontWeight: 600,
  },
  helpText: {
    fontSize: "13px",
    color: "var(--text-secondary)",
    lineHeight: 1.7,
  },
  helpGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: "12px",
  },
  helpCard: {
    padding: "14px",
    borderRadius: "8px",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border)",
    textAlign: "center" as const,
  },
  helpCardIcon: {
    fontSize: "28px",
    marginBottom: "8px",
  },
  helpCardTitle: {
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--text-primary)",
    marginBottom: "6px",
  },
  helpCardDesc: {
    fontSize: "12px",
    color: "var(--text-secondary)",
    lineHeight: 1.5,
  },
  helpSteps: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  helpStep: {
    display: "flex",
    gap: "12px",
    alignItems: "flex-start",
  },
  helpStepNum: {
    width: "28px",
    height: "28px",
    borderRadius: "50%",
    background: "var(--accent)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "13px",
    fontWeight: "bold",
    flexShrink: 0,
  },
  helpStepContent: {
    flex: 1,
  },
  helpStepTitle: {
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--text-primary)",
    marginBottom: "4px",
  },
  helpStepDesc: {
    fontSize: "12px",
    color: "var(--text-secondary)",
    lineHeight: 1.5,
  },
  helpFlow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap" as const,
  },
  helpFlowNode: {
    padding: "10px 14px",
    borderRadius: "8px",
    background: "var(--bg-secondary)",
    border: "1px solid var(--accent)",
    textAlign: "center" as const,
    minWidth: "100px",
  },
  helpFlowLabel: {
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--accent)",
    marginBottom: "4px",
  },
  helpFlowDesc: {
    fontSize: "11px",
    color: "var(--text-secondary)",
  },
  helpFlowArrow: {
    fontSize: "18px",
    color: "var(--text-muted)",
  },
  helpMetrics: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: "12px",
  },
  helpMetric: {
    padding: "12px",
    borderRadius: "8px",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border)",
  },
  helpMetricValue: {
    fontSize: "14px",
    fontWeight: 600,
    color: "var(--section-title-color)",
    marginBottom: "6px",
  },
  helpMetricDesc: {
    fontSize: "12px",
    color: "var(--text-secondary)",
    lineHeight: 1.5,
  },
};

function subTabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "10px 14px",
    border: "none",
    background: "none",
    color: active ? "var(--section-title-color)" : "var(--text-muted)",
    fontSize: "13px",
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
    transition: "all 0.2s",
    whiteSpace: "nowrap" as const,
  };
}