/**
 * Groq Provider 扩展样板。
 *
 * 对标 OpenClaw extensions/groq。
 * Groq 以超低延迟推理著称，API 兼容 OpenAI Chat Completions。
 *
 * 环境变量: GROQ_API_KEY
 * baseURL: https://api.groq.com/openai
 * 默认模型: llama-3.3-70b-versatile
 */
import { defineProvider } from "../provider-runtime.js";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleProviderSpec,
} from "../openai-compatible-provider.js";

const GROQ_SPEC: OpenAICompatibleProviderSpec = {
  providerId: "groq",
  baseUrl: "https://api.groq.com/openai",
  envVar: "GROQ_API_KEY",
  defaultModel: "llama-3.3-70b-versatile",
  models: [
    {
      id: "llama-3.3-70b-versatile",
      name: "Llama 3.3 70B Versatile",
      provider: "groq",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 32_768,
      costInputPerMillion: 0.59,
      costOutputPerMillion: 0.79,
    },
    {
      id: "llama-3.1-8b-instant",
      name: "Llama 3.1 8B Instant",
      provider: "groq",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
      costInputPerMillion: 0.05,
      costOutputPerMillion: 0.08,
    },
    {
      id: "mixtral-8x7b-32768",
      name: "Mixtral 8x7B",
      provider: "groq",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 32_768,
      maxOutputTokens: 32_768,
      costInputPerMillion: 0.24,
      costOutputPerMillion: 0.24,
    },
  ],
};

export default defineProvider({
  providerId: "groq",
  create: createOpenAICompatibleProvider(GROQ_SPEC),
});

export const GROQ_SPEC_EXPORT = GROQ_SPEC;
