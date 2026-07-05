/**
 * EnhancementHubPage — 增强能力中心
 *
 * 集中展示 EvoClaw v0.56.0 / v0.57.0 从任务完成能力维度补齐的
 * 12 大核心能力，体现近期多次修改的成果。
 */
import React, { useEffect, useState, useCallback } from "react";
import { PageHeader, Card, Badge, Loading, ErrorBanner } from "./shared";
import { useTranslation } from "./i18n";

interface CapabilityStatus {
  active: boolean;
  metrics?: Record<string, unknown>;
  lastUpdated?: string;
}

interface CapabilityDef {
  id: string;
  name: string;
  nameEn: string;
  version: string;
  icon: string;
  description: string;
  module: string;
  tags: string[];
  apiPath?: string;
  statusKey?: string;
}

const CAPABILITIES: CapabilityDef[] = [
  {
    id: "filesystem-checkpoint",
    name: "文件系统检查点",
    nameEn: "FileSystem Checkpoint",
    version: "v0.56",
    icon: "💾",
    description: "基于 Git 影子存储的文件快照与回滚，支持 per-project 隔离、每轮去重、三层清理与 pre-rollback 快照。",
    module: "@evoclaw/infrastructure",
    tags: ["可靠性", "状态回滚"],
    apiPath: "/api/execution/checkpoints",
    statusKey: "executionCheckpointStore",
  },
  {
    id: "tool-output-pruner",
    name: "工具输出 3-pass 裁剪",
    nameEn: "Tool Output Pruner",
    version: "v0.56",
    icon: "✂️",
    description: "MD5 去重 → 工具特定摘要 → args JSON 安全截断，保持上下文简洁与 JSON 有效性。",
    module: "@evoclaw/agent",
    tags: ["上下文管理", "压缩"],
    apiPath: "/api/agent/pruner-stats",
    statusKey: "toolOutputPruner",
  },
  {
    id: "error-recovery-executor",
    name: "错误恢复执行分支",
    nameEn: "Error Recovery Executor",
    version: "v0.56",
    icon: "🛡️",
    description: "20+ FailoverReason 对应的实际恢复动作，含 TurnRetryState 一次性守卫防止无限循环。",
    module: "@evoclaw/agent",
    tags: ["容错", "恢复"],
    apiPath: "/api/agent/error-recovery-stats",
    statusKey: "errorRecoveryExecutor",
  },
  {
    id: "concurrent-tool-executor",
    name: "并发工具执行池",
    nameEn: "Concurrent Tool Executor",
    version: "v0.56",
    icon: "⚡",
    description: "8 worker + 3 类安全分类（never-parallel / path-scoped / safe-parallel）+ 心跳监控 + 中断扇出。",
    module: "@evoclaw/agent",
    tags: ["性能", "并发"],
    apiPath: "/api/agent/concurrent-stats",
    statusKey: "concurrentToolExecutor",
  },
  {
    id: "iteration-budget",
    name: "迭代预算退款机制",
    nameEn: "Iteration Budget",
    version: "v0.56",
    icon: "💰",
    description: "execute_code / runtime_error / compaction 三种退款，让预算真正反映决策次数。",
    module: "@evoclaw/agent",
    tags: ["成本控制", "预算"],
    apiPath: "/api/agent/iteration-budget",
    statusKey: "iterationBudget",
  },
  {
    id: "process-tree-killer",
    name: "跨平台进程树终止",
    nameEn: "Process Tree Killer",
    version: "v0.56",
    icon: "🌳",
    description: "POSIX /proc/children + ps --ppid / Windows taskkill /T /F，受保护 PID + 两阶段终止。",
    module: "@evoclaw/infrastructure",
    tags: ["安全", "清理"],
    statusKey: "processManager",
  },
  {
    id: "tool-result-persistence",
    name: "工具结果持久化",
    nameEn: "Tool Result Persistence",
    version: "v0.57",
    icon: "📦",
    description: "三层防御：per-tool cap → per-result persistence → per-turn aggregate budget，防止大输出撑爆上下文。",
    module: "@evoclaw/agent",
    tags: ["上下文管理", "持久化"],
    apiPath: "/api/agent/persistence-stats",
    statusKey: "toolResultPersistence",
  },
  {
    id: "schema-sanitizer",
    name: "JSON Schema 多后端清洗",
    nameEn: "Schema Sanitizer",
    version: "v0.57",
    icon: "🧹",
    description: "Anthropic / OpenAI Codex / Fireworks / xAI / llama.cpp 五类后端兼容性清洗，响应式策略选择。",
    module: "@evoclaw/agent",
    tags: ["兼容性", "多后端"],
    apiPath: "/api/agent/schema-sanitizer-stats",
    statusKey: "schemaSanitizer",
  },
  {
    id: "tool-argument-coercer",
    name: "工具参数类型强制转换",
    nameEn: "Tool Argument Coercer",
    version: "v0.57",
    icon: "🔧",
    description: "运行时校正 LLM 返回的参数类型：string→int/number/boolean、JSON string→object/array、bare value→[value]。",
    module: "@evoclaw/agent",
    tags: ["可靠性", "类型安全"],
    apiPath: "/api/agent/coercer-stats",
    statusKey: "toolArgumentCoercer",
  },
  {
    id: "cross-session-rate-guard",
    name: "跨会话速率限制守卫",
    nameEn: "Cross-Session Rate Guard",
    version: "v0.57",
    icon: "⏱️",
    description: "CLI/gateway/cron/auxiliary 跨会话共享 429 状态，防止 retry amplification，区分配额耗尽与瞬时容量不足。",
    module: "@evoclaw/agent",
    tags: ["速率限制", "成本控制"],
    apiPath: "/api/agent/rate-guard-stats",
    statusKey: "crossSessionRateGuard",
  },
  {
    id: "streaming-recovery",
    name: "流式响应中断恢复",
    nameEn: "Streaming Recovery",
    version: "v0.57",
    icon: "🔄",
    description: "6 种恢复策略：partial_stream_recovery / truncated_tool_call_retries / length_continue / thinking_prefill / post_tool_empty / housekeeping。",
    module: "@evoclaw/agent",
    tags: ["流式传输", "容错"],
    apiPath: "/api/agent/streaming-recovery-stats",
    statusKey: "streamingRecovery",
  },
  {
    id: "tool-result-middleware",
    name: "工具结果中间件",
    nameEn: "Tool Result Middleware",
    version: "v0.57",
    icon: "🎛️",
    description: "3 类中间件（修改参数 / 包装执行 / 后处理结果），内置脱敏、大小限制、JSON 格式化 Transform。",
    module: "@evoclaw/agent",
    tags: ["可扩展性", "安全"],
    apiPath: "/api/agent/middleware-stats",
    statusKey: "toolResultMiddleware",
  },
  // ── v0.68+ 新增：借鉴 TencentDB-Agent-Memory + 主流 AI Agent ──
  {
    id: "layered-memory",
    name: "分层记忆金字塔",
    nameEn: "Layered Memory Pyramid",
    version: "v0.68",
    icon: "🧠",
    description: "L0 对话 → L1 原子记忆 → L2 情境块 → L3 人格画像，借鉴 TencentDB-Agent-Memory 的语义金字塔设计。",
    module: "@evoclaw/memory",
    tags: ["记忆", "借鉴"],
    apiPath: "/api/memory/layered-stats",
    statusKey: "memoryHub",
  },
  {
    id: "symbolic-canvas",
    name: "符号记忆画布",
    nameEn: "Symbolic Memory Canvas",
    version: "v0.68",
    icon: "🗺️",
    description: "Agent 执行过程累积的任务节点图，支持视口剔除、rAF 合并、Undo/Redo、小地图（借鉴 Infinite-Canvas）。",
    module: "@evoclaw/memory",
    tags: ["可视化", "借鉴"],
    apiPath: "/api/canvas-graph/snapshot",
    statusKey: "symbolicMemoryCanvas",
  },
  {
    id: "tool-result-cache",
    name: "工具结果缓存",
    nameEn: "Tool Result Cache",
    version: "v0.69",
    icon: "⚡",
    description: "LRU + TTL + 黑白名单的工具结果缓存，减少重复 API 调用成本（借鉴 Cursor / Continue / Aider）。",
    module: "@evoclaw/agent",
    tags: ["性能", "成本控制"],
    apiPath: "/api/agent/tool-cache-stats",
    statusKey: "toolResultCacheV2",
  },
  {
    id: "tool-retry-backoff",
    name: "工具重试退避",
    nameEn: "Tool Retry & Backoff",
    version: "v0.69",
    icon: "🔁",
    description: "指数退避 + 抖动 + 可重试错误判定，自动处理瞬时错误（借鉴 LangChain / AutoGPT / OpenAI SDK）。",
    module: "@evoclaw/agent",
    tags: ["容错", "可靠性"],
    statusKey: "toolRetryBackoff",
  },
  {
    id: "token-budget-optimizer",
    name: "Token 预算优化",
    nameEn: "Token Budget Optimizer",
    version: "v0.69",
    icon: "💰",
    description: "按优先级为 system/memory/history/tool/user 分配 context window 预算，动态截断（借鉴 Claude Code / Cursor）。",
    module: "@evoclaw/agent",
    tags: ["上下文管理", "成本控制"],
    apiPath: "/api/agent/token-budget-report",
    statusKey: "tokenBudgetOptimizer",
  },
  {
    id: "recall-budget",
    name: "召回预算控制",
    nameEn: "Recall Budget",
    version: "v0.68",
    icon: "📐",
    description: "限制召回记忆总 token 数，超长单条记忆自动截断并暴露 _truncatedText，避免撑爆 prompt。",
    module: "@evoclaw/memory",
    tags: ["上下文管理", "记忆"],
    statusKey: "recallBudget",
  },
  // ── v0.70 新增：借鉴 OpenSpace 闭环演化引擎 ──
  {
    id: "tool-quality-manager",
    name: "工具质量跟踪",
    nameEn: "Tool Quality Manager",
    version: "v0.70",
    icon: "📊",
    description: "工具质量跟踪 + 惩罚式排序（成功率<0.4 触发惩罚，连续失败自动禁用），LLM 反馈语义失败（借鉴 OpenSpace ToolQualityManager）。",
    module: "@evoclaw/agent",
    tags: ["可靠性", "借鉴"],
    apiPath: "/api/agent/tool-quality-stats",
    statusKey: "toolQualityManager",
  },
  {
    id: "recording-manager",
    name: "任务执行录制",
    nameEn: "Recording Manager",
    version: "v0.70",
    icon: "🎬",
    description: "任务执行三件套录制（conversations.jsonl + traj.jsonl + metadata.json），完整记录 LLM 对话与工具调用轨迹，用于演化分析（借鉴 OpenSpace RecordingManager）。",
    module: "@evoclaw/agent",
    tags: ["可观测性", "借鉴"],
    apiPath: "/api/agent/recording-stats",
    statusKey: "recordingManager",
  },
  {
    id: "evolution-triggers",
    name: "三触发器演化",
    nameEn: "Evolution Triggers",
    version: "v0.70",
    icon: "🔄",
    description: "post-analysis / tool-degradation / metric-monitor 三触发器闭环演化，强制 LLM 二次确认，防循环机制（借鉴 OpenSpace SkillEvolver）。",
    module: "@evoclaw/evolution",
    tags: ["自演化", "借鉴"],
    apiPath: "/api/agent/evolution-trigger-stats",
    statusKey: "evolutionTriggers",
  },
  {
    id: "lineage-dag",
    name: "版本血缘 DAG",
    nameEn: "Version Lineage DAG",
    version: "v0.70",
    icon: "🌳",
    description: "三态演化模型（FIX/DERIVED/CAPTURED）+ 多父 DAG + .skill_id sidecar，支持技能版本溯源与多父合并派生（借鉴 OpenSpace skill_engine）。",
    module: "@evoclaw/skills",
    tags: ["可追溯", "借鉴"],
    apiPath: "/api/skills/lineage-stats",
    statusKey: "lineageDag",
  },
  {
    id: "iteration-context-policy",
    name: "迭代渐进裁剪",
    nameEn: "Iteration Context Policy",
    version: "v0.70",
    icon: "✂️",
    description: "基于迭代轮次的渐进式上下文裁剪：第 2 轮起 cap 单条消息，第 5 轮起 truncate 历史，首轮后剥离技能上下文（借鉴 OpenSpace grounding_agent）。",
    module: "@evoclaw/agent",
    tags: ["上下文管理", "成本控制"],
    statusKey: "iterationContextPolicy",
  },
];

const s = {
  container: { padding: "20px", overflow: "auto", height: "100%" } as React.CSSProperties,
  intro: {
    background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "10px",
    padding: "16px 18px", marginBottom: "18px", fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.6,
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: "16px" } as React.CSSProperties,
  card: {
    background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "10px",
    padding: "16px", display: "flex", flexDirection: "column" as const, gap: "10px",
  },
  cardHeader: { display: "flex", alignItems: "flex-start", gap: "12px" } as React.CSSProperties,
  icon: { fontSize: "28px", lineHeight: 1 } as React.CSSProperties,
  titleWrap: { flex: 1, minWidth: 0 } as React.CSSProperties,
  title: { fontSize: "14px", fontWeight: "bold", color: "var(--text-primary)", marginBottom: "2px" } as React.CSSProperties,
  subtitle: { fontSize: "11px", color: "var(--text-muted)" } as React.CSSProperties,
  desc: { fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.55 } as React.CSSProperties,
  tags: { display: "flex", gap: "6px", flexWrap: "wrap" as const, marginTop: "4px" } as React.CSSProperties,
  tag: {
    fontSize: "10px", padding: "2px 7px", borderRadius: "10px",
    background: "var(--accent-bg)", color: "var(--accent)", border: "1px solid var(--accent)",
  } as React.CSSProperties,
  footer: { marginTop: "auto", paddingTop: "8px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" } as React.CSSProperties,
  status: (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: "5px", fontSize: "12px", fontWeight: 600,
    color: active ? "var(--success)" : "var(--text-muted)",
  }),
  dot: (active: boolean): React.CSSProperties => ({
    width: "7px", height: "7px", borderRadius: "50%", background: active ? "var(--success)" : "var(--text-muted)",
  }),
  metrics: { fontSize: "11px", color: "var(--text-muted)", textAlign: "right" as const } as React.CSSProperties,
  summary: {
    display: "flex", gap: "12px", marginBottom: "18px", flexWrap: "wrap" as const,
  },
  summaryBox: {
    background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "10px",
    padding: "14px 18px", minWidth: "140px", flex: "1 1 140px",
  },
  summaryNum: { fontSize: "24px", fontWeight: "bold", color: "var(--accent)" } as React.CSSProperties,
  summaryLabel: { fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" } as React.CSSProperties,
};

async function fetchServiceStatus(): Promise<Record<string, boolean>> {
  try {
    const res = await fetch("/api/system/services");
    if (!res.ok) return {};
    const data = await res.json();
    const services = Array.isArray(data) ? data : data?.services || [];
    const map: Record<string, boolean> = {};
    for (const svc of services) {
      if (svc?.name) map[svc.name] = svc.status === "ok" || svc.status === "healthy" || svc.status === "online";
    }
    return map;
  } catch {
    return {};
  }
}

async function fetchCapabilityMetrics(path?: string): Promise<Record<string, unknown> | null> {
  if (!path) return null;
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function EnhancementHubPage(): React.ReactElement {
  const { t } = useTranslation();
  const [serviceMap, setServiceMap] = useState<Record<string, boolean>>({});
  const [metricsMap, setMetricsMap] = useState<Record<string, Record<string, unknown> | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const svcMap = await fetchServiceStatus();
      setServiceMap(svcMap);

      const metrics: Record<string, Record<string, unknown> | null> = {};
      await Promise.all(
        CAPABILITIES.map(async (cap) => {
          metrics[cap.id] = await fetchCapabilityMetrics(cap.apiPath);
        })
      );
      setMetricsMap(metrics);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const activeCount = CAPABILITIES.filter((cap) => {
    const key = cap.statusKey || cap.id;
    if (serviceMap[key] !== undefined) return serviceMap[key];
    return true; // 默认展示为可用，等待后端暴露服务状态
  }).length;

  return (
    <div style={s.container}>
      <PageHeader
        title={t("enhancement.title", "增强能力中心")}
        actions={
          <button
            style={{
              padding: "5px 12px", borderRadius: "6px", border: "1px solid var(--accent)",
              background: "transparent", color: "var(--accent)", cursor: loading ? "not-allowed" : "pointer",
              fontSize: "11px", opacity: loading ? 0.6 : 1,
            }}
            onClick={load}
            disabled={loading}
          >
            {t("common.refresh", "刷新")}
          </button>
        }
      />

      <div style={s.intro}>
        {t("enhancement.intro", "本页面集中展示 EvoClaw 近期从任务完成能力维度补齐的核心能力，覆盖可靠性、上下文管理、多后端兼容、并发执行与成本控制等方面。")}
      </div>

      <div style={s.summary}>
        <div style={s.summaryBox}>
          <div style={s.summaryNum}>{CAPABILITIES.length}</div>
          <div style={s.summaryLabel}>{t("enhancement.total_capabilities", "新增核心能力")}</div>
        </div>
        <div style={s.summaryBox}>
          <div style={s.summaryNum}>{activeCount}</div>
          <div style={s.summaryLabel}>{t("enhancement.active_capabilities", "已激活能力")}</div>
        </div>
        <div style={s.summaryBox}>
          <div style={s.summaryNum}>2</div>
          <div style={s.summaryLabel}>{t("enhancement.release_rounds", "发布轮次")}</div>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {loading && <Loading />}

      <div style={s.grid}>
        {CAPABILITIES.map((cap) => {
          const key = cap.statusKey || cap.id;
          const active = serviceMap[key] !== undefined ? serviceMap[key] : true;
          const metrics = metricsMap[cap.id];
          const metricCount = metrics ? Object.keys(metrics).length : 0;

          return (
            <div key={cap.id} style={s.card}>
              <div style={s.cardHeader}>
                <div style={s.icon}>{cap.icon}</div>
                <div style={s.titleWrap}>
                  <div style={s.title}>{cap.name}</div>
                  <div style={s.subtitle}>{cap.nameEn} · {cap.version} · {cap.module}</div>
                </div>
              </div>
              <div style={s.desc}>{cap.description}</div>
              <div style={s.tags}>
                {cap.tags.map((tag) => (
                  <span key={tag} style={s.tag}>{tag}</span>
                ))}
              </div>
              <div style={s.footer}>
                <div style={s.status(active)}>
                  <span style={s.dot(active)} />
                  {active ? t("enhancement.status.active", "已激活") : t("enhancement.status.inactive", "未就绪")}
                </div>
                <div style={s.metrics}>
                  {metrics && metricCount > 0
                    ? t("enhancement.metrics_count", "{0} 项指标").replace("{0}", String(metricCount))
                    : t("enhancement.no_metrics", "无实时指标")}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default EnhancementHubPage;
