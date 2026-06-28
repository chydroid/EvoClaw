/**
 * Hook 策略系统（对齐 openclaw-main 的 src/hooks/policy.ts）。
 *
 * 设计要点：
 * - 4 源策略：bundled(10) < plugin(20) < managed(30) < workspace(40)
 * - 双向校验：canOverride 与 canBeOverriddenBy 必须同时满足才能替换
 * - default-on vs explicit-opt-in：workspace 源默认不启用，需显式 opt-in
 * - 碰撞解析：同名的 hook 按源优先级合并，无法替换的候选发出 onCollisionIgnored
 *
 * 这套策略防止低信任来源（如 workspace）覆盖高信任来源（如 bundled）的 hook，
 * 同时允许 managed（用户主动安装）覆盖 bundled 与 plugin。
 */

/**
 * Hook 来源标签，决定信任等级与默认启用模式。
 * - bundled：随产品发布，最高信任
 * - plugin：第三方插件，受签名校验后信任
 * - managed：用户主动安装（如 marketplace 安装），中等信任
 * - workspace：工作区本地脚本，最低信任，默认不启用
 */
export type HookSource = "bundled" | "plugin" | "managed" | "workspace";

/** 单条 Hook 的元数据（不含脚本内容，仅描述与来源）。 */
export interface HookEntry {
  name: string;
  source: HookSource;
  /** 显式启用/禁用（来自配置文件） */
  enabled?: boolean;
  /** 来源描述，用于审计日志 */
  description?: string;
  /** 来源文件路径，用于错误定位 */
  sourceFile?: string;
}

/** Hook 启用状态的判定结果。 */
export type HookEnableStateReason =
  | "disabled in config"
  | "workspace hook (disabled by default)"
  | "enabled by config"
  | "enabled by default";

export interface HookEnableState {
  enabled: boolean;
  reason: HookEnableStateReason;
}

/** 单个来源的 Hook 策略。 */
export interface HookSourcePolicy {
  /** 数值越大优先级越高（碰撞时胜出） */
  precedence: number;
  /** 是否视为可信本地代码 */
  trustedLocalCode: boolean;
  /** 默认启用模式：default-on 自动启用；explicit-opt-in 需用户显式启用 */
  defaultEnableMode: "default-on" | "explicit-opt-in";
  /** 该来源可以覆盖哪些来源 */
  canOverride: HookSource[];
  /** 该来源可以被哪些来源覆盖 */
  canBeOverriddenBy: HookSource[];
}

/** 碰撞解析记录：同名的 hook 冲突时保留哪个、忽略哪个。 */
export interface HookResolutionCollision {
  name: string;
  kept: HookEntry;
  ignored: HookEntry;
}

/**
 * 4 源策略矩阵。注意 canOverride 与 canBeOverriddenBy 是非对称的——
 * 两者必须互相认可才能完成覆盖。
 */
const HOOK_SOURCE_POLICIES: Record<HookSource, HookSourcePolicy> = {
  bundled: {
    precedence: 10,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["bundled"],
    canBeOverriddenBy: ["managed", "plugin"],
  },
  plugin: {
    precedence: 20,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["bundled", "plugin"],
    canBeOverriddenBy: ["managed"],
  },
  managed: {
    precedence: 30,
    trustedLocalCode: true,
    defaultEnableMode: "default-on",
    canOverride: ["bundled", "managed", "plugin"],
    canBeOverriddenBy: ["managed"],
  },
  workspace: {
    precedence: 40,
    trustedLocalCode: false,
    defaultEnableMode: "explicit-opt-in",
    canOverride: ["workspace"],
    canBeOverriddenBy: ["workspace"],
  },
};

/** 获取指定来源的策略。 */
export function getHookSourcePolicy(source: HookSource): HookSourcePolicy {
  return HOOK_SOURCE_POLICIES[source];
}

/**
 * 判定候选 hook 是否可以覆盖已存在的 hook。
 * 必须同时满足：
 * 1. 候选策略的 canOverride 包含已有 hook 的来源
 * 2. 已有策略的 canBeOverriddenBy 包含候选 hook 的来源
 *
 * 这种双向校验防止任何来源单方面声称可以覆盖其他来源。
 */
export function canOverrideHook(candidate: HookEntry, existing: HookEntry): boolean {
  const candidatePolicy = getHookSourcePolicy(candidate.source);
  const existingPolicy = getHookSourcePolicy(existing.source);
  return (
    candidatePolicy.canOverride.includes(existing.source) &&
    existingPolicy.canBeOverriddenBy.includes(candidate.source)
  );
}

/**
 * 判定单个 hook 的启用状态。
 *
 * 优先级：
 * 1. 显式配置 enabled=false → 禁用（"disabled in config"）
 * 2. workspace 源且未显式 enabled=true → 禁用（"workspace hook (disabled by default)"）
 * 3. 显式配置 enabled=true → 启用（"enabled by config"）
 * 4. 默认策略 → 启用（"enabled by default"）
 */
export function resolveHookEnableState(entry: HookEntry): HookEnableState {
  // 显式禁用优先
  if (entry.enabled === false) {
    return { enabled: false, reason: "disabled in config" };
  }
  // workspace 源默认不启用（除非显式 enabled=true）
  const sourcePolicy = getHookSourcePolicy(entry.source);
  if (sourcePolicy.defaultEnableMode === "explicit-opt-in" && entry.enabled !== true) {
    return { enabled: false, reason: "workspace hook (disabled by default)" };
  }
  // 显式启用
  if (entry.enabled === true) {
    return { enabled: true, reason: "enabled by config" };
  }
  // 默认启用（default-on 策略）
  return { enabled: true, reason: "enabled by default" };
}

/**
 * 按来源优先级合并多个同名 hook。
 *
 * 合并规则：
 * - 按优先级排序（precedence 高的先入列）
 * - 同名碰撞时，若候选可覆盖已有则替换；否则忽略候选并调用 onCollisionIgnored
 *
 * @param entries 待合并的 hook 列表
 * @param opts.onCollisionIgnored 碰撞被忽略时的回调（用于审计日志）
 * @returns 合并后的 hook 列表（每个 name 唯一）
 */
export function resolveHookEntries(
  entries: HookEntry[],
  opts?: {
    onCollisionIgnored?: (collision: HookResolutionCollision) => void;
  },
): HookEntry[] {
  // 先按优先级排序，再按入参顺序稳定排序
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const precedenceDelta =
        getHookSourcePolicy(a.entry.source).precedence -
        getHookSourcePolicy(b.entry.source).precedence;
      return precedenceDelta !== 0 ? precedenceDelta : a.index - b.index;
    });

  const merged = new Map<string, HookEntry>();
  for (const { entry } of ordered) {
    const existing = merged.get(entry.name);
    if (!existing) {
      merged.set(entry.name, entry);
      continue;
    }
    // 双向校验：候选能否覆盖已有
    if (canOverrideHook(entry, existing)) {
      merged.set(entry.name, entry);
      continue;
    }
    // 无法覆盖：忽略候选，记录碰撞
    opts?.onCollisionIgnored?.({
      name: entry.name,
      kept: existing,
      ignored: entry,
    });
  }

  return Array.from(merged.values());
}

/**
 * 批量过滤：仅保留启用状态的 hook。
 * 用于在执行前一次性过滤掉被策略禁用的 hook。
 */
export function filterEnabledHooks(entries: HookEntry[]): Array<HookEntry & HookEnableState> {
  return entries
    .map((entry) => ({ ...entry, ...resolveHookEnableState(entry) }))
    .filter((entry) => entry.enabled);
}

/**
 * 列出所有来源的策略（用于 UI 展示与审计）。
 */
export function listHookSourcePolicies(): Array<{ source: HookSource; policy: HookSourcePolicy }> {
  return (Object.keys(HOOK_SOURCE_POLICIES) as HookSource[]).map((source) => ({
    source,
    policy: HOOK_SOURCE_POLICIES[source],
  }));
}
