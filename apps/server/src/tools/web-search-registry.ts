/**
 * WebSearchRegistry — web 搜索后端注册表（对标 Hermes agent/web_search_registry.py）。
 *
 * 只移植「选择不变量」，不搬 Hermes 的插件选择器体系：
 *   - 显式配置键优先于 legacy 顺序（web search_backend → web backend）
 *   - 能力过滤（supports_search）在每一步保留
 *   - 显式配置即使不可用也优先返回，让调用方报精确错误而非静默切换
 *   - fall-through 依次为：单一可用能力 provider → legacy 偏好 → None
 *
 * EvoClaw 的 web_search 是单工具级联（skill-first + Baidu/Tavily/Bing/Google/DDG），
 * 无搜索/提取拆分。此处把「选哪个后端」抽象出来，级联顺序作为 legacy 偏好保留，
 * 默认行为不变；配置键可把单一后端钉到最前。
 */

/** 后端能力：搜索 / 提取。EvoClaw 现仅有搜索，但保留枚举以对齐 Hermes 契约。 */
export type WebCapability = "search" | "extract";

/** 搜索结果行（与 web-tools 现有返回形状一致）。 */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 注册表条目的提供方契约（模型无关、cheap、无网络副作用）。 */
export interface WebSearchBackend {
  name: string;
  /** 能力标注：是否可服务于 search / extract。 */
  supportsSearch(): boolean;
  supportsExtract(): boolean;
  /** cheap 可用性检查（如是否有 API key），禁止网络。 */
  isAvailable(): boolean;
}

/** 纯选择输入：配置键 + 已注册后端的快照。 */
export interface WebResolveInput {
  /** 显式配置的后端名（web.search_backend / web.backend 解析结果）。空 = 未配置。 */
  configured?: string | null;
  /** 能力需求。 */
  capability: WebCapability;
  /** 已注册后端按注册顺序的快照。 */
  backends: WebSearchBackend[];
}

/** Legacy 偏好顺序（对标 _LEGACY_PREFERENCE）。EvoClaw 实际级联以接收到的顺序为准。 */
export const LEGACY_WEB_PREFERENCE = [
  "tavily",
  "baidu",
  "bing",
  "google",
  "duckduckgo",
] as const;

const NORMALIZE = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

function nameOf(b: WebSearchBackend): string {
  return NORMALIZE(b.name);
}

function isCapable(b: WebSearchBackend, capability: WebCapability): boolean {
  if (capability === "search") return b.supportsSearch();
  return b.supportsExtract();
}

/**
 * 解析当前活跃后端。规则（对标 hermes _resolve，去掉 keyless 层）：
 *   1. 显式配置：即使不可用也返回（宁可让调用方报「X 不可用」也不静默切换）；
 *      未注册或不具备能力则日志 + fall-through。
 *   2. 能力合格且可用的唯一 provider。
 *   3. legacy 偏好遍历（能力 + 可用过滤）。
 *   4. 无 → null。
 */
export function resolveWebBackend(input: WebResolveInput): WebSearchBackend | null {
  const { configured, capability, backends } = input;

  if (configured) {
    const want = NORMALIZE(configured);
    const pinned = backends.find((b) => nameOf(b) === want);
    if (pinned) {
      if (isCapable(pinned, capability)) return pinned;
      // 已注册但不具备此能力 → 落到 legacy（预留给未来 extract 拆分）
    }
  }

  const eligible = backends.filter((b) => isCapable(b, capability) && b.isAvailable());
  if (eligible.length === 1) return eligible[0];

  for (const pref of LEGACY_WEB_PREFERENCE) {
    const found = backends.find((b) => nameOf(b) === pref && eligible.includes(b));
    if (found) return found;
  }

  return null;
}

/** 解析环境配置键：EVOCLAW_WEB_SEARCH_BACKEND（对标 web.search_backend）。 */
export function resolveSearchBackendConfig(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = String(env.EVOCLAW_WEB_SEARCH_BACKEND ?? "").trim();
  return v.length > 0 ? v : null;
}

/** 轻量注册集合，供 web-tools 组装后端快照。 */
export class WebSearchRegistry {
  private readonly backends: WebSearchBackend[] = [];

  register(b: WebSearchBackend): this {
    if (!this.backends.some((x) => nameOf(x) === nameOf(b))) {
      this.backends.push(b);
    }
    return this;
  }

  snapshot(): WebSearchBackend[] {
    return [...this.backends];
  }

  resolveSearch(configured?: string | null): WebSearchBackend | null {
    return resolveWebBackend({
      configured,
      capability: "search",
      backends: this.backends,
    });
  }

  size(): number {
    return this.backends.length;
  }
}