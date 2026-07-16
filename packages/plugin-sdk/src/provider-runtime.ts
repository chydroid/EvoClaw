/**
 * Provider Runtime — LLM provider 插件运行时上下文与注册辅助。
 *
 * 对标 OpenClaw `@openclaw/plugin-sdk/provider-runtime` 与 `provider-stream-shared`。
 */
import type { PluginLogger, ServiceLocator } from "./types.js";
import type {
  ModelInfo,
  ProviderConfig,
  ModelRequest,
  ModelResponse,
  StreamChunk,
} from "./provider.js";

// ── Runtime Context ──────────────────────────────────────────────────

/** Provider 插件加载时收到的运行时上下文。 */
export interface ProviderRuntimeContext {
  /** Provider ID（如 "openai"、"anthropic"） */
  readonly providerId: string;
  /** 插件 logger */
  readonly logger: PluginLogger;
  /** 服务定位器 */
  readonly services: ServiceLocator;
  /** Provider 配置（含 API key、baseURL 等） */
  readonly config: Readonly<ProviderConfig>;
  /** HTTP 工具（fetch + AbortSignal 注入） */
  readonly http: ProviderHttp;
}

/** Provider 可用的 HTTP 接口。对标 OpenClaw `provider-http`。 */
export interface ProviderHttp {
  fetch(url: string, init?: ProviderHttpInit): Promise<Response>;
  /** 创建一个带超时的 AbortSignal */
  timeoutSignal(ms: number): AbortSignal;
}

export interface ProviderHttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

// ── Registration ─────────────────────────────────────────────────────

/** Provider 插件工厂签名。 */
export type ProviderPluginFactory = (ctx: ProviderRuntimeContext) => ProviderRuntime | Promise<ProviderRuntime>;

/** 已加载的 provider 运行时句柄。 */
export interface ProviderRuntime {
  /** 列出可用模型 */
  listModels?(): Promise<ModelInfo[]>;
  /** 非流式 chat 调用 */
  chat(req: ModelRequest): Promise<ModelResponse>;
  /** 流式 chat 调用 */
  chatStream?(req: ModelRequest): AsyncIterable<StreamChunk>;
  /** 估算 token 数（用于预算计算） */
  estimateTokens?(text: string): number;
  /** 健康检查 */
  healthCheck?(): Promise<{ healthy: boolean; detail?: string }>;
}

/**
 * Provider 插件定义工厂。对标 OpenClaw `defineProvider`。
 *
 * @example
 *   export default defineProvider({
 *     providerId: "deepseek",
 *     async create(ctx) {
 *       return {
 *         async chat(req) { /* ... * / },
 *         async *chatStream(req) { /* ... * / },
 *       };
 *     },
 *   });
 */
export function defineProvider(spec: {
  providerId: string;
  create: ProviderPluginFactory;
}): { kind: "provider"; providerId: string; create: ProviderPluginFactory } {
  return {
    kind: "provider",
    providerId: spec.providerId,
    create: spec.create,
  };
}

// ── Re-exports ──────────────────────────────────────────────────────

export type {
  ModelInfo,
  ProviderConfig,
  ModelRequest,
  ModelResponse,
  StreamChunk,
} from "./provider.js";
