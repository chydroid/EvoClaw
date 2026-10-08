/**
 * 模型配置分组与排序（2026-10-08）。
 *
 * 用户诉求（原话）：「修改大模型配置页面，将模型分成两个分组，
 * 将配置好的模型默认排在最上方的分组中，最新配置的或者修改的会自动排到
 * 最上方的位置，而且只有配置好的模型参与排序，
 * 其它的未配置的模型分组不参与排序。」
 *
 * 拆解成三条可验证的规则：
 * 1. **两个分组**：已配置 / 未配置
 * 2. **已配置的排上面**，组内按order 升序
 * 3. **最新配置或修改的自动置顶** → 需要一个「最近变动」时间戳，
 *    存进 provider 配置（`updatedAt`），保存时打点
 * 4. **未配置组不参与排序**：组内保持目录原始顺序（catalog order），
 *    不被用户上移/下移影响，也不因为"最近动过"而重排
 */

/** 判断一个 provider 是否"已配置好" */
export interface ProviderLike {
  id: string;
  name?: string;
  baseURL?: string;
  apiKey?: string;
  hasApiKey?: boolean;
  models?: string[];
  selectedModel?: string;
  enabled?: boolean;
  order?: number;
  /** 最近一次配置/修改的时间戳（ms）。缺省视为从未配置过 */
  updatedAt?: number;
}

/**
 * 「配置好」的判定：填了 baseURL、填了 key（或声明有 key）、选了模型。
 * 三者齐备才算配置完成 —— 只填了一格的仍属于未配置组。
 */
export function isConfigured(p: ProviderLike): boolean {
  const hasUrl = typeof p.baseURL === "string" && p.baseURL.trim().length > 0;
  const hasKey =
    (typeof p.apiKey === "string" && p.apiKey.trim().length > 0) ||
    p.hasApiKey === true;
  const hasModel =
    (typeof p.selectedModel === "string" && p.selectedModel.trim().length > 0) ||
    (Array.isArray(p.models) && p.models.length > 0);
  return hasUrl && hasKey && hasModel;
}

export interface GroupedProviders<T extends ProviderLike> {
  /** 已配置（组内：最近改动/配置的在最上） */
  configured: T[];
  /** 未配置（组内：保持目录原始顺序，不参与排序） */
  unconfigured: T[];
}

/**
 * 把 provider 分成两组并各自排序。
 *
 * 已配置组排序规则（优先级从高到低）：
 *  1. `updatedAt` 降序 —— **最新配置/修改的排最上**（用户明确要求）
 *  2. `order` 升序 —— 同一天/同一批次内保持用户手动排的顺序
 *
 * 未配置组：**不参与排序**，保持传入顺序（即 catalog 原始顺序）。
 */
export function groupProviders<T extends ProviderLike>(list: T[]): GroupedProviders<T> {
  const configured: T[] = [];
  const unconfigured: T[] = [];

  for (const p of list) (isConfigured(p) ? configured : unconfigured).push(p);

  configured.sort((a, b) => {
    const ta = typeof a.updatedAt === "number" ? a.updatedAt : 0;
    const tb = typeof b.updatedAt === "number" ? b.updatedAt : 0;
    if (ta !== tb) return tb - ta; // 最近改动的在前
    return (a.order ?? 0) - (b.order ?? 0); // 同批次按手动顺序
  });

  // unconfigured 保持原顺序，不排序
  return { configured, unconfigured };
}

/** 给 provider 打上「刚刚修改过」的时间戳（保存配置时调用） */
export function markUpdated<T extends ProviderLike>(p: T, now = Date.now()): T {
  return { ...p, updatedAt: now };
}

/** 展平成「先已配置、后未配置」的单列表，供 map 渲染 */
export function flattenGrouped<T extends ProviderLike>(g: GroupedProviders<T>): T[] {
  return [...g.configured, ...g.unconfigured];
}
