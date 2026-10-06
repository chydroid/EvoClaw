/**
 * 模型上下文窗口解析（Context Window Resolution）
 *
 * 解决的问题：聊天输入框下方的上下文用量显示，分母曾被硬编码成 128k，
 * 导致「实际 1M 窗口的模型也显示 128k」，用户完全看不到真实余量。
 *
 * 旧实现在 `packages/gateway/src/protocol-adapter.ts` 里有三重缺陷：
 *   1. `let contextLimit = 128000` 硬编码兜底；
 *   2. `MODEL_CONTEXT` 表只认识 gpt-4o / claude-3 等老模型，且匹配方式是
 *      `pattern.replace("-4-turbo","").replace("-4o","")` —— "gpt-4o" 被削成
 *      "gpt"，于是**任何**含 "gpt" 的模型（含 gpt-3.5-turbo）都命中第一条；
 *   3. 最致命：`contextEngine.getConfig().maxContextTokens`（内部默认 128000）
 *      在最后**无条件覆盖**前面所有模型判断 —— 整段模型探测其实是死代码，
 *      所以无论用哪个模型，分母永远是 128000。
 *
 * 本模块确立单一事实来源：优先复用 `packages/agent/src/model-catalog.ts`
 * 中已维护的 `maxContextTokens`（含 1M 窗口条目），并提供：
 *   - 最长前缀匹配（而非脆弱的字符串 replace）
 *   - provider 维度兜底
 *   - 用户显式覆盖（最高优先级）
 *   - 解析来源可追溯（UI 可标注"估算"）
 */

import { getCatalog, type ModelEntry } from "./model-catalog";

/** 解析来源，用于 UI 标注可信度 */
export type ContextWindowSource = "user" | "provider" | "catalog" | "fallback";

export interface ResolveContextWindowInput {
  /** 当前启用的模型 ID（可能带日期后缀，如 "gpt-4o-2024-11-20"） */
  model?: string | null;
  /** 模型所属 provider（用于 catalog 未命中时按 provider 兜底） */
  provider?: string | null;
  /** 用户在配置中显式设置的上限（最高优先级）；未设置传 undefined/null */
  userOverride?: number | null;
  /** 上游/provider 报告的真实窗口（次高优先级） */
  reported?: number | null;
  /** 全部未命中时的兜底值 */
  fallback?: number;
}

export interface ResolvedContextWindow {
  /** 最终生效的上下文窗口（tokens） */
  limit: number;
  source: ContextWindowSource;
  /** 命中的 catalog 条目 id（若有），便于诊断 */
  matchedModel?: string;
  /** 实际用于匹配的模型名 */
  model?: string;
}

/** 兜底值：与历史默认保持一致，避免行为突变 */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/** provider 维度兜底：catalog 未命中具体型号时使用 */
const PROVIDER_DEFAULTS: Record<string, number> = {
  openai: 128_000,
  anthropic: 200_000,
  google: 1_000_000,
  deepseek: 128_000,
  qwen: 131_072,
  dashscope: 131_072,
  meta: 128_000,
  mistral: 128_000,
};

/** 归一化：小写、去空白，便于前缀匹配 */
function normalize(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * 在 catalog 中为给定模型名找最佳匹配。
 *
 * 策略：先找「catalog id 是模型名的前缀」（处理 gpt-4o-2024-11-20 → gpt-4o），
 * 找不到再反向找「模型名是 catalog id 的前缀」（处理用户填 gpt-4o → gpt-4o-mini
 * 这类简写）。两者都取**最长**匹配，避免短模型名抢先命中。
 */
export function matchModelEntry(model: string, catalog: ReadonlyArray<ModelEntry> = getCatalog()): ModelEntry | undefined {
  const target = normalize(model);
  if (!target) return undefined;

  let bestForward: ModelEntry | undefined;
  let bestForwardLen = 0;
  let bestReverse: ModelEntry | undefined;
  let bestReverseLen = 0;

  for (const entry of catalog) {
    const id = normalize(entry.id);
    if (!id) continue;

    if (target.startsWith(id) && id.length > bestForwardLen) {
      bestForward = entry;
      bestForwardLen = id.length;
    }
    if (id.startsWith(target) && target.length > bestReverseLen) {
      bestReverse = entry;
      bestReverseLen = target.length;
    }
  }

  return bestForward ?? bestReverse;
}

/** 从 provider 名推断兜底窗口（兼容 "anthropic" / "claude-3-5-sonnet" 这类写法） */
function providerFallback(provider?: string | null): number | undefined {
  if (!provider) return undefined;
  const p = normalize(provider);
  if (PROVIDER_DEFAULTS[p] !== undefined) return PROVIDER_DEFAULTS[p];
  // 退化：provider 字符串里常直接带厂商名
  for (const [key, limit] of Object.entries(PROVIDER_DEFAULTS)) {
    if (p.includes(key)) return limit;
  }
  if (p.includes("claude") || p.includes("anthropic")) return 200_000;
  if (p.includes("gemini") || p.includes("google")) return 1_000_000;
  if (p.includes("qwen")) return 131_072;
  return undefined;
}

/** 合法上限过滤：非正数/非有限数一律视为未设置 */
function sanitize(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * 解析当前模型真实的上下文窗口。
 *
 * 优先级：用户显式设置 > provider 报告值 > 内置 catalog 匹配 > provider 维度兜底 > 兜底常量。
 */
export function resolveContextWindow(input: ResolveContextWindowInput = {}): ResolvedContextWindow {
  const model = input.model ?? undefined;

  // 1. 用户显式设置 —— 永远最高优先级，满足"做不到也要让用户来设置"的要求
  const userLimit = sanitize(input.userOverride);
  if (userLimit) {
    return { limit: userLimit, source: "user", model };
  }

  // 2. 上游/provider 直接报告的真实窗口
  const reportedLimit = sanitize(input.reported);
  if (reportedLimit) {
    return { limit: reportedLimit, source: "provider", model };
  }

  // 3. 内置 catalog 精确/前缀匹配
  if (model) {
    const entry = matchModelEntry(model);
    const catalogLimit = sanitize(entry?.maxContextTokens);
    if (entry && catalogLimit) {
      return { limit: catalogLimit, source: "catalog", matchedModel: entry.id, model };
    }
  }

  // 4. provider 维度兜底
  const providerLimit = providerFallback(input.provider);
  if (providerLimit) {
    return { limit: providerLimit, source: "fallback", model };
  }

  // 5. 最终兜底
  return { limit: sanitize(input.fallback) ?? FALLBACK_CONTEXT_WINDOW, source: "fallback", model };
}

/**
 * 人类可读的来源说明，供 UI 直接展示，避免用户误把估算值当成精确值。
 */
export function describeContextWindowSource(resolved: ResolvedContextWindow): string {
  switch (resolved.source) {
    case "user":
      return "用户设置";
    case "provider":
      return "provider 报告";
    case "catalog":
      return `内置模型库（${resolved.matchedModel}）`;
    case "fallback":
    default:
      return "估算值（未匹配到该模型）";
  }
}
