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

/**
 * 手动上移/下移（2026-10-08 修bug）。
 *
 * **为什么不能只交换 `order`**：已配置组的显示顺序是由 `updatedAt` 主导的
 * （降序，见 {@link groupProviders}）。如果 moveProvider 只交换 `order`，
 * `updatedAt` 一个字都没变 → 重新渲染时顺序照旧 → **用户看到「点了没反应」**。
 * 这正是 0.91.0 上线后下箭头失效的原因。
 *
 * 修法：手动移动时，**按显示顺序取出目标列表 → 交换位置 → 重排 updatedAt**
 * 让新顺序与updatedAt 顺序一致。这样箭头立刻可见，且与自动排序规则统一。
 *
 * @param list 该分组当前的**显示顺序**（已排序）
 * @param id要移动的 provider
 * @param direction 移动方向
 * @returns 新的列表（未变化时返回 null）
 */
export function reorderWithinGroup<T extends ProviderLike>(
  list: T[],
  id: string,
  direction: "up" | "down",
  now = Date.now(),
): T[] | null {
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const target = direction === "up" ? idx - 1 : idx + 1;
  if (target < 0 || target >= list.length) return null;

  const next = [...list];
  const tmp = next[idx];
  next[idx] = next[target];
  next[target] = tmp;

  // ★ 关键：把新顺序同时写进 updatedAt（降序）与 order（升序），
  // 使「显示顺序」与「order」两套口径一致 —— 否则下一次
  // groupProviders 排序或落盘后又会出现顺序漂移。
  // 用一个足够小的时间基准，保证「最靠前的 updatedAt 最大」。
  const base = now - next.length * 1000;
  return next.map((p, i) => ({
    ...p,
    updatedAt: base + (next.length - i) * 1000,
    order: i + 1,
  }));
}

/** 展平成「先已配置、后未配置」的单列表，供 map 渲染 */
export function flattenGrouped<T extends ProviderLike>(g: GroupedProviders<T>): T[] {
  return [...g.configured, ...g.unconfigured];
}
