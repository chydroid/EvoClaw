/**
 * EvolutionTypes — 三态演化模型 + 版本血缘 DAG
 *
 * 借鉴 OpenSpace skill_engine/types.py + store.py：
 *   - EvolutionType: FIX / DERIVED / CAPTURED 三态语义化演化分类
 *   - SkillLineage: 多父 DAG（取代线性单链 previousVersion）
 *   - .skill_id sidecar: 技能目录可移植身份
 *
 * EvoClaw 落地点：
 *   - skill-curator.ts 的 SkillVersion.trigger 扩展为联合类型
 *   - skill-manager.ts 写入技能时同步写 .skill_id
 *   - data/skill-curator/lineages.json 持久化 DAG
 */

// ── 三态演化类型 ──────────────────────────────────────────────

/**
 * 演化类型（借鉴 OpenSpace EvolutionType）。
 *
 * - FIX: 原地修复父技能（deactivate 父版本）
 *   - 场景：技能有 bug，修复后替换原版本
 *   - 父版本：is_active = false
 *   - 版本链：父子 1:1（单父）
 *
 * - DERIVED: 派生新版本（保留父版本 active，可合并多父）
 *   - 场景：基于现有技能扩展新能力，或合并多个技能的优势
 *   - 父版本：is_active = true（保留）
 *   - 版本链：父子 1:N 或 N:1（多父合并）
 *
 * - CAPTURED: 从无到有捕获新模式（无父）
 *   - 场景：从任务执行中发现新的可复用模式
 *   - 父版本：无
 *   - 版本链：根节点
 *
 * - EXTRACTION: 从对话中提取（旧 trigger，保留兼容）
 * - IMPROVEMENT: 改进（旧 trigger，保留兼容）
 * - DEPRECATION: 弃用（旧 trigger，保留兼容）
 * - MANUAL: 手动创建（旧 trigger，保留兼容）
 */
export type EvolutionType = "fix" | "derived" | "captured" | "extraction" | "improvement" | "deprecation" | "manual";

/**
 * 技能来源（借鉴 OpenSpace SkillOrigin）。
 */
export type SkillOrigin = "imported" | "captured" | "derived" | "fixed";

// ── 版本血缘 DAG ──────────────────────────────────────────────

/**
 * 技能血缘记录（借鉴 OpenSpace SkillLineage）。
 *
 * 取代旧的 previousVersion: string | null，支持多父 DAG。
 */
export interface SkillLineage {
  /** 技能 ID（.skill_id sidecar 中的 uuid8） */
  skillId: string;
  /** 父技能 ID 列表（DAG，可多父） */
  parentIds: string[];
  /** 演化类型 */
  evolutionType: EvolutionType;
  /** 内容 diff（与父版本的 unified diff） */
  contentDiff?: string;
  /** 内容快照（演化时的完整内容） */
  contentSnapshot?: string;
  /** 演化时间 */
  evolvedAt: number;
  /** 演化原因 */
  reason: string;
  /** 是否激活（FIX 演化会 deactivate 父版本） */
  isActive: boolean;
}

/**
 * 血缘树节点（用于 UI 可视化）。
 */
export interface LineageTreeNode {
  skillId: string;
  skillName: string;
  evolutionType: EvolutionType;
  isActive: boolean;
  evolvedAt: number;
  reason: string;
  /** 子节点（派生自此技能的版本） */
  children: LineageTreeNode[];
  /** 深度（根节点 = 0） */
  depth: number;
}

/**
 * 血缘查询结果。
 */
export interface LineageQueryResult {
  /** 目标技能 ID */
  skillId: string;
  /** 所有祖先（从直接父到根） */
  ancestors: SkillLineage[];
  /** 所有后代 */
  descendants: SkillLineage[];
  /** 完整树（如果目标是根节点） */
  tree: LineageTreeNode | null;
}

// ── 演化建议 ──────────────────────────────────────────────────

/**
 * 演化建议（借鉴 OpenSpace EvolutionSuggestion）。
 *
 * 由三触发器产生，经 LLM 二次确认后执行。
 */
export interface EvolutionSuggestion {
  /** 建议的演化类型 */
  type: EvolutionType;
  /** 目标技能 ID（FIX/DERIVED 必填，CAPTURED 为空） */
  targetSkillIds: string[];
  /** 演化原因 */
  reason: string;
  /** 建议的内容变更（unified diff 或新内容） */
  proposedChange: string;
  /** 触发源 */
  triggeredBy: "post-analysis" | "tool-degradation" | "metric-monitor" | "manual";
  /** 触发时的指标快照 */
  triggerMetrics?: {
    successRate?: number;
    completionRate?: number;
    fallbackRate?: number;
    consecutiveFailures?: number;
  };
  /** LLM 二次确认状态 */
  llmConfirmed: boolean;
  /** LLM 确认理由 */
  llmConfirmationReason?: string;
  /** 创建时间 */
  createdAt: number;
}

// ── 工具函数 ──────────────────────────────────────────────────

/**
 * 判断演化类型是否需要父技能。
 */
export function requiresParent(type: EvolutionType): boolean {
  return type === "fix" || type === "derived";
}

/**
 * 判断演化类型是否支持多父。
 */
export function supportsMultipleParents(type: EvolutionType): boolean {
  return type === "derived";
}

/**
 * 判断演化类型是否应 deactivate 父版本。
 */
export function shouldDeactivateParent(type: EvolutionType): boolean {
  return type === "fix";
}

/**
 * 获取演化类型的人类可读描述。
 */
export function describeEvolutionType(type: EvolutionType): string {
  const descriptions: Record<EvolutionType, string> = {
    fix: "修复（替换父版本）",
    derived: "派生（保留父版本，可多父合并）",
    captured: "捕获（从无到有）",
    extraction: "提取（从对话中提取）",
    improvement: "改进（优化现有技能）",
    deprecation: "弃用",
    manual: "手动创建",
  };
  return descriptions[type] ?? type;
}

/**
 * 获取演化类型的英文描述。
 */
export function describeEvolutionTypeEn(type: EvolutionType): string {
  const descriptions: Record<EvolutionType, string> = {
    fix: "Fix (replace parent)",
    derived: "Derived (keep parent, multi-parent merge)",
    captured: "Captured (new from scratch)",
    extraction: "Extraction (from conversation)",
    improvement: "Improvement (optimize existing)",
    deprecation: "Deprecation",
    manual: "Manual",
  };
  return descriptions[type] ?? type;
}

// ── EvolutionType ↔ SkillOrigin 双向映射（借鉴 OpenSpace types.py line 58-66） ───

const EVOLUTION_TO_ORIGIN: Record<EvolutionType, SkillOrigin> = {
  fix: "fixed",
  derived: "derived",
  captured: "captured",
  extraction: "captured",
  improvement: "derived",
  deprecation: "imported",
  manual: "imported",
};

const ORIGIN_TO_EVOLUTION: Record<SkillOrigin, EvolutionType> = {
  imported: "manual",
  captured: "captured",
  derived: "derived",
  fixed: "fix",
};

/**
 * EvolutionType → SkillOrigin 转换。
 */
export function toSkillOrigin(type: EvolutionType): SkillOrigin {
  return EVOLUTION_TO_ORIGIN[type] ?? "imported";
}

/**
 * SkillOrigin → EvolutionType 转换。
 */
export function fromSkillOrigin(origin: SkillOrigin): EvolutionType {
  return ORIGIN_TO_EVOLUTION[origin] ?? "manual";
}

// ── 技能指标 + 派生率属性（借鉴 OpenSpace types.py line 380-398） ───

/**
 * 技能应用指标。
 *
 * 派生率属性（applied_rate/completion_rate/effective_rate/fallback_rate）
 * 不存储，由 @property 实时计算 — 避免反序列化时漂移、写入时同步问题。
 */
export class SkillMetricsRecord {
  /** 被选中次数 */
  totalSelections: number = 0;
  /** 被应用次数 */
  totalApplied: number = 0;
  /** 完成次数（成功执行到底） */
  totalCompleted: number = 0;
  /** 回退次数（执行中切换到其他技能） */
  totalFallbacks: number = 0;
  /** 失败次数 */
  totalFailures: number = 0;
  /** 最近更新时间 */
  lastUpdated: number = 0;

  /** 应用率 = applied / selections */
  get appliedRate(): number {
    return this.totalSelections > 0 ? this.totalApplied / this.totalSelections : 0;
  }

  /** 完成率 = completed / applied */
  get completionRate(): number {
    return this.totalApplied > 0 ? this.totalCompleted / this.totalApplied : 1.0;
  }

  /** 有效率 = completed / selections */
  get effectiveRate(): number {
    return this.totalSelections > 0 ? this.totalCompleted / this.totalSelections : 0;
  }

  /** 回退率 = fallbacks / applied */
  get fallbackRate(): number {
    return this.totalApplied > 0 ? this.totalFallbacks / this.totalApplied : 0;
  }

  /** 失败率 = failures / applied */
  get failureRate(): number {
    return this.totalApplied > 0 ? this.totalFailures / this.totalApplied : 0;
  }

  toJSON(): Record<string, unknown> {
    return {
      totalSelections: this.totalSelections,
      totalApplied: this.totalApplied,
      totalCompleted: this.totalCompleted,
      totalFallbacks: this.totalFallbacks,
      totalFailures: this.totalFailures,
      lastUpdated: this.lastUpdated,
    };
  }

  static fromJSON(data: Record<string, unknown>): SkillMetricsRecord {
    const record = new SkillMetricsRecord();
    // 使用 Number() 做运行时转换，避免字符串数字导致后续算术产生 NaN 或字符串拼接
    record.totalSelections = Number(data.totalSelections) || 0;
    record.totalApplied = Number(data.totalApplied) || 0;
    record.totalCompleted = Number(data.totalCompleted) || 0;
    record.totalFallbacks = Number(data.totalFallbacks) || 0;
    record.totalFailures = Number(data.totalFailures) || 0;
    record.lastUpdated = Number(data.lastUpdated) || 0;
    return record;
  }
}

// ── ExecutionAnalysis + suggestions_by_type（借鉴 OpenSpace types.py line 291-293） ───

/**
 * 执行分析结果（借鉴 OpenSpace ExecutionAnalysis）。
 *
 * 由 LLM 分析录制数据后产出，包含：
 *   - 演化建议列表
 *   - 工具质量反馈
 *   - 任务级总结
 */
export interface ExecutionAnalysis {
  /** 任务 ID */
  taskId: string;
  /** LLM 生成的演化建议 */
  suggestions: EvolutionSuggestion[];
  /** LLM 反馈的工具问题 */
  toolIssues: Array<{
    toolKey: string;
    toolName: string;
    description: string;
  }>;
  /** 任务级总结 */
  summary?: string;
  /** 分析时间 */
  analyzedAt: number;
}

/**
 * 从 ExecutionAnalysis 中按类型过滤 suggestions（借鉴 OpenSpace suggestions_by_type）。
 */
export function suggestionsByType(
  analysis: ExecutionAnalysis,
  type: EvolutionType,
): EvolutionSuggestion[] {
  return analysis.suggestions.filter((s) => s.type === type);
}

// ── 滚动窗口常量（借鉴 OpenSpace types.py MAX_RECENT ClassVar） ───

/**
 * recent_analyses / recent_suggestions 滚动窗口上限。
 */
export const MAX_RECENT_ANALYSES = 50;
export const MAX_RECENT_SUGGESTIONS = 200;
