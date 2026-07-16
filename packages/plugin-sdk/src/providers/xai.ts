/**
 * xAI (Grok) Provider 扩展样板。
 *
 * 对标 OpenClaw extensions/xai。
 * xAI 的 Grok API 兼容 OpenAI Chat Completions。
 *
 * 环境变量: XAI_API_KEY
 * baseURL: https://api.x.ai
 * 默认模型: grok-3
 */
import { defineProvider } from "../provider-runtime.js";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleProviderSpec,
} from "../openai-compatible-provider.js";

const XAI_SPEC: OpenAICompatibleProviderSpec = {
  providerId: "xai",
  baseUrl: "https://api.x.ai",
  envVar: "XAI_API_KEY",
  defaultModel: "grok-3",
  models: [
    {
      id: "grok-3",
      name: "Grok 3",
      provider: "xai",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 8_192,
      costInputPerMillion: 5.00,
      costOutputPerMillion: 15.00,
    },
    {
      id: "grok-3-mini",
      name: "Grok 3 Mini",
      provider: "xai",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 8_192,
      costInputPerMillion: 0.30,
      costOutputPerMillion: 0.50,
    },
    {
      id: "grok-2-vision",
      name: "Grok 2 Vision",
      provider: "xai",
      supportsVision: true,
      supportsStreaming: true,
      supportsTools: false,
      maxContextTokens: 32_768,
      maxOutputTokens: 4_096,
      costInputPerMillion: 2.00,
      costOutputPerMillion: 10.00,
    },
  ],
};

export default defineProvider({
  providerId: "xai",
  create: createOpenAICompatibleProvider(XAI_SPEC),
});

export const XAI_SPEC_EXPORT = XAI_SPEC;
