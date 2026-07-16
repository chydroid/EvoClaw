/**
 * DeepSeek Provider 扩展样板。
 *
 * 对标 OpenClaw extensions/deepseek。
 * DeepSeek API 完全兼容 OpenAI Chat Completions，仅 baseURL 不同。
 *
 * 环境变量: DEEPSEEK_API_KEY
 * baseURL: https://api.deepseek.com
 * 默认模型: deepseek-chat
 */
import { defineProvider } from "../provider-runtime.js";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleProviderSpec,
} from "../openai-compatible-provider.js";

const DEEPSEEK_SPEC: OpenAICompatibleProviderSpec = {
  providerId: "deepseek",
  baseUrl: "https://api.deepseek.com",
  envVar: "DEEPSEEK_API_KEY",
  defaultModel: "deepseek-chat",
  models: [
    {
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      provider: "deepseek",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 64_000,
      maxOutputTokens: 8_192,
      costInputPerMillion: 0.14,
      costOutputPerMillion: 0.28,
    },
    {
      id: "deepseek-reasoner",
      name: "DeepSeek Reasoner (R1)",
      provider: "deepseek",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: false,
      maxContextTokens: 64_000,
      maxOutputTokens: 32_768,
      costInputPerMillion: 0.55,
      costOutputPerMillion: 2.19,
    },
  ],
};

export default defineProvider({
  providerId: "deepseek",
  create: createOpenAICompatibleProvider(DEEPSEEK_SPEC),
});

export const DEEPSEEK_SPEC_EXPORT = DEEPSEEK_SPEC;
