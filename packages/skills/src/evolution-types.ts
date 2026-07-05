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
