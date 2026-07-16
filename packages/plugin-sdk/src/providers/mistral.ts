/**
 * Mistral AI Provider 扩展样板。
 *
 * 对标 OpenClaw extensions/mistral。
 * Mistral 的 La Plateforme API 兼容 OpenAI Chat Completions。
 *
 * 环境变量: MISTRAL_API_KEY
 * baseURL: https://api.mistral.ai
 * 默认模型: mistral-large-latest
 */
import { defineProvider } from "../provider-runtime.js";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleProviderSpec,
} from "../openai-compatible-provider.js";

const MISTRAL_SPEC: OpenAICompatibleProviderSpec = {
  providerId: "mistral",
  baseUrl: "https://api.mistral.ai",
  envVar: "MISTRAL_API_KEY",
  defaultModel: "mistral-large-latest",
  models: [
    {
      id: "mistral-large-latest",
      name: "Mistral Large",
      provider: "mistral",
      supportsVision: true,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
      costInputPerMillion: 2.00,
      costOutputPerMillion: 6.00,
    },
    {
      id: "mistral-small-latest",
      name: "Mistral Small",
      provider: "mistral",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 32_768,
      maxOutputTokens: 8_192,
      costInputPerMillion: 0.20,
      costOutputPerMillion: 0.60,
    },
    {
      id: "codestral-latest",
      name: "Codestral",
      provider: "mistral",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: false,
      maxContextTokens: 32_768,
      maxOutputTokens: 8_192,
      costInputPerMillion: 0.30,
      costOutputPerMillion: 0.90,
    },
    {
      id: "open-mistral-nemo",
      name: "Mistral Nemo",
      provider: "mistral",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
      costInputPerMillion: 0.15,
      costOutputPerMillion: 0.15,
    },
  ],
};

export default defineProvider({
  providerId: "mistral",
  create: createOpenAICompatibleProvider(MISTRAL_SPEC),
});

export const MISTRAL_SPEC_EXPORT = MISTRAL_SPEC;
