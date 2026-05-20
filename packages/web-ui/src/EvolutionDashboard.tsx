import React, { useState, useEffect } from "react";

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
  const [data, setData] = useState<EvolutionData>(DEFAULT_DATA);
  const [learningEntries, setLearningEntries] = useState<LearningEntry[]>([]);
  const [learningSessions, setLearningSessions] = useState<LearningSession[]>([]);
  const [progressReports, setProgressReports] = useState<ProgressReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<"overview" | "cycles" | "feedback" | "patterns" | "learning" | "progress">("overview");

  useEffect(() => {
    loadEvolutionData();
    const interval = setInterval(loadEvolutionData, 15000);
    return () => clearInterval(interval);
  }, []);

  async function loadEvolutionData() {
    try {
      const res = await fetch("/api/evolution/dashboard");
      if (res.ok) {
        const json = await res.json();
        setData(json);
        setError(null);
      } else {
        setData(DEFAULT_DATA);
      }
    } catch {
      setData(DEFAULT_DATA);
      if (loading) setError("Server not available - showing empty dashboard");
    } finally {
      setLoading(false);
    }
  }

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

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
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
      command_failed: "命令失败",
      user_correction: "用户纠正",
      capability_gap: "能力缺口",
      api_failure: "外部失败",
      knowledge_outdated: "知识过时",
      pattern_improvement: "模式改进",
      task_failure: "任务失败",
      user_feedback: "用户反馈",
    };
    return labels[trigger] || trigger;
  };

  const getCategoryLabel = (category: string) => {
    const labels: Record<string, string> = {
      error_fix: "错误修复",
      correction: "纠正",
      new_capability_needed: "新能力需求",
      better_approach: "更优方法",
      external_dependency: "外部依赖",
      knowledge_update: "知识更新",
      process_improvement: "流程改进",
    };
    return labels[category] || category;
  };

  if (loading) {
    return <div style={s.placeholder}>Loading evolution data...</div>;
  }

  const learning = data.learning;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <h2 style={s.title}>🦞 Evolution Dashboard</h2>
        {error && <div style={s.errorBanner}>{error}</div>}
      </div>

      <div style={s.summaryRow}>
        <div style={s.summaryCard}>
          <div style={s.summaryValue}>{data.summary.totalCycles}</div>
          <div style={s.summaryLabel}>进化周期</div>
        </div>
        <div style={s.summaryCard}>
          <div style={s.summaryValue}>{Math.round(data.summary.successRate * 100)}%</div>
          <div style={s.summaryLabel}>成功率</div>
        </div>
        <div style={s.summaryCard}>
          <div style={s.summaryValue}>{learning?.totalEntries ?? 0}</div>
          <div style={s.summaryLabel}>学习条目</div>
        </div>
        <div style={s.summaryCard}>
          <div style={s.summaryValue}>{learning?.resolvedEntries ?? 0}</div>
          <div style={s.summaryLabel}>已解决</div>
        </div>
      </div>

      <div style={s.subTabs}>
        <button style={subTabStyle(activeSubTab === "overview")} onClick={() => setActiveSubTab("overview")}>概览</button>
        <button style={subTabStyle(activeSubTab === "cycles")} onClick={() => setActiveSubTab("cycles")}>周期 ({data.cycles.length})</button>
        <button style={subTabStyle(activeSubTab === "feedback")} onClick={() => setActiveSubTab("feedback")}>反馈 ({data.feedback.length})</button>
        <button style={subTabStyle(activeSubTab === "learning")} onClick={() => setActiveSubTab("learning")}>📝 学习</button>
        <button style={subTabStyle(activeSubTab === "progress")} onClick={() => setActiveSubTab("progress")}>📊 进度</button>
        <button style={subTabStyle(activeSubTab === "patterns")} onClick={() => setActiveSubTab("patterns")}>模式</button>
      </div>

      <div style={s.content}>
        {activeSubTab === "overview" && renderOverview()}
        {activeSubTab === "cycles" && renderCycles()}
        {activeSubTab === "feedback" && renderFeedback()}
        {activeSubTab === "learning" && renderLearning()}
        {activeSubTab === "progress" && renderProgress()}
        {activeSubTab === "patterns" && renderPatterns()}
      </div>
    </div>
  );

  function renderOverview() {
    return (
      <div style={s.overview}>
        {data.cycles.length === 0 && (!learning || learning.totalEntries === 0) ? (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>🧬</div>
            <div>暂无进化数据</div>
            <div style={s.emptyHint}>
              当系统从任务失败、用户反馈、外部错误和学习中触发进化周期时，数据将在此显示
            </div>
          </div>
        ) : (
          <>
            <div style={s.chartSection}>
              <h3 style={s.sectionTitle}>近期进化周期</h3>
              <div style={s.timeline}>
                {data.cycles.slice(-10).reverse().map((cycle) => (
                  <div key={cycle.id} style={s.timelineItem}>
                    <div style={{ ...s.timelineDot, background: getStatusColor(cycle.status) }} />
                    <div style={s.timelineContent}>
                      <div style={s.timelineHeader}>
                        <span style={s.timelineSource}>{cycle.source}</span>
                        <span style={{ ...s.timelineStatus, color: getStatusColor(cycle.status) }}>
                          {cycle.status}
                        </span>
                      </div>
                      <div style={s.timelineMeta}>
                        {cycle.candidatesGenerated} candidates · {formatDuration(cycle.duration)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={s.chartSection}>
              <h3 style={s.sectionTitle}>成功率趋势</h3>
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
                {data.feedback.length === 0 && <div style={s.emptySmall}>暂无反馈数据</div>}
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
              <th>ID</th>
              <th>来源</th>
              <th>状态</th>
              <th>候选方案</th>
              <th>用时</th>
              <th>开始时间</th>
            </tr>
          </thead>
          <tbody>
            {data.cycles.length === 0 ? (
              <tr><td colSpan={6} style={s.emptyCell}>暂无进化周期记录</td></tr>
            ) : (
              data.cycles.map((cycle) => (
                <tr key={cycle.id}>
                  <td style={s.monoCell}>{cycle.id.slice(0, 8)}...</td>
                  <td>{cycle.source}</td>
                  <td>
                    <span style={{ ...s.statusBadge, background: getStatusColor(cycle.status) + "22", color: getStatusColor(cycle.status) }}>
                      {cycle.status}
                    </span>
                  </td>
                  <td>{cycle.candidatesGenerated} / {cycle.candidatesPassed} 通过</td>
                  <td>{formatDuration(cycle.duration)}</td>
                  <td style={s.monoCell}>{new Date(cycle.startedAt).toLocaleString("zh-CN")}</td>
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
              <th>周期</th>
              <th>技能</th>
              <th>成功率</th>
              <th>采纳率</th>
              <th>错误率</th>
              <th>Token</th>
              <th>收集时间</th>
            </tr>
          </thead>
          <tbody>
            {data.feedback.length === 0 ? (
              <tr><td colSpan={7} style={s.emptyCell}>暂无反馈数据</td></tr>
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
                  <td style={s.monoCell}>{new Date(fb.collectedAt).toLocaleString("zh-CN")}</td>
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
              <div style={s.statLabel}>总条目</div>
            </div>
            <div style={s.statCard}>
              <div style={{ ...s.statValue, color: "var(--success)" }}>{Math.round(ls.resolutionRate * 100)}%</div>
              <div style={s.statLabel}>解决率</div>
            </div>
            <div style={s.statCard}>
              <div style={{ ...s.statValue, color: "#f97316" }}>{ls.unresolvedEntries}</div>
              <div style={s.statLabel}>待解决</div>
            </div>
            <div style={s.statCard}>
              <div style={{ ...s.statValue, color: "var(--accent)" }}>{ls.newThisWeek}</div>
              <div style={s.statLabel}>本周新增</div>
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
                <th>标题</th>
                <th>触发</th>
                <th>分类</th>
                <th>来源</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {learningEntries.length === 0 ? (
                <tr><td colSpan={6} style={s.emptyCell}>
                  {ls && ls.totalEntries > 0 ? "加载中..." : "🦞 暂无学习记录。当系统遇到错误、用户纠正或发现改进机会时，会自动记录。"}
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
                      {entry.solution && <div style={{ fontSize: "11px", color: "var(--success)", marginTop: "2px" }}>解决: {entry.solution.slice(0, 80)}{entry.solution.length > 80 ? "..." : ""}</div>}
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
                      {new Date(entry.timestamp).toLocaleString("zh-CN", {
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
            <h3 style={s.sectionTitle}>学习会话 ({learningSessions.length})</h3>
            {learningSessions.slice(0, 10).map((session) => (
              <div key={session.id} style={s.sessionCard}>
                <div style={s.sessionHeader}>
                  <span style={s.sessionTask}>{session.taskDescription}</span>
                  <span style={{
                    ...s.statusBadge,
                    background: getStatusColor(session.status) + "22",
                    color: getStatusColor(session.status),
                  }}>
                    {session.status}
                  </span>
                </div>
                {session.summary && <div style={s.sessionSummary}>{session.summary}</div>}
                <div style={s.sessionMeta}>
                  {session.entries.length} 条学习 · {session.completedAt
                    ? formatDuration(new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime())
                    : "进行中"}
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
          <h3 style={s.sectionTitle}>活跃进度 ({progressReports.length})</h3>
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
            🔄 刷新
          </button>
        </div>

        {progressReports.length === 0 ? (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>📊</div>
            <div>暂无活跃的进度报告</div>
            <div style={s.emptyHint}>当任务执行时，实时进度反馈将在此显示</div>
          </div>
        ) : (
          progressReports.map((report) => (
            <div key={report.id} style={s.progressCard}>
              <div style={s.progressHeader}>
                <span style={{ color: "var(--section-title-color)", fontWeight: 600, fontSize: "14px" }}>
                  {report.phase}
                </span>
                <span style={{
                  padding: "2px 8px",
                  borderRadius: "10px",
                  fontSize: "11px",
                  background: getStatusColor(report.status) + "22",
                  color: getStatusColor(report.status),
                }}>
                  {report.status}
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
                步骤 {report.step}/{report.totalSteps} · {new Date(report.startedAt).toLocaleTimeString("zh-CN")}
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
                {pattern.count} 次
              </div>
            </div>
            <div style={s.patternConfidence}>
              <div style={s.confidenceLabel}>置信度: {Math.round(pattern.confidence * 100)}%</div>
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
        <div style={s.emptyState}>
          <div style={s.emptyIcon}>📊</div>
          <div>暂无检测到的模式</div>
          <div style={s.emptyHint}>失败模式将在进化周期运行后自动检测</div>
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