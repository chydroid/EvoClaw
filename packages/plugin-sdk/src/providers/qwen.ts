/**
 * Qwen (通义千问) Provider 扩展样板。
 *
 * 对标 OpenClaw extensions/qwen。
 * 阿里云 DashScope 兼容模式 API，OpenAI 兼容。
 *
 * 环境变量: DASHSCOPE_API_KEY (或 QWEN_API_KEY)
 * baseURL: https://dashscope.aliyuncs.com/compatible-mode
 * 默认模型: qwen-plus
 */
import { defineProvider } from "../provider-runtime.js";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleProviderSpec,
} from "../openai-compatible-provider.js";

const QWEN_SPEC: OpenAICompatibleProviderSpec = {
  providerId: "qwen",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
  envVar: "DASHSCOPE_API_KEY",
  defaultModel: "qwen-plus",
  models: [
    {
      id: "qwen-plus",
      name: "Qwen Plus",
      provider: "qwen",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 131_072,
      maxOutputTokens: 8_192,
      costInputPerMillion: 0.40,
      costOutputPerMillion: 1.20,
    },
    {
      id: "qwen-max",
      name: "Qwen Max",
      provider: "qwen",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 32_768,
      maxOutputTokens: 8_192,
      costInputPerMillion: 2.50,
      costOutputPerMillion: 10.00,
    },
    {
      id: "qwen-turbo",
      name: "Qwen Turbo",
      provider: "qwen",
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 8_192,
      costInputPerMillion: 0.05,
      costOutputPerMillion: 0.20,
    },
    {
      id: "qwen-vl-max",
      name: "Qwen VL Max (Vision)",
      provider: "qwen",
      supportsVision: true,
      supportsStreaming: true,
      supportsTools: false,
      maxContextTokens: 32_768,
      maxOutputTokens: 8_192,
      costInputPerMillion: 2.50,
      costOutputPerMillion: 10.00,
    },
  ],
};

export default defineProvider({
  providerId: "qwen",
  create: createOpenAICompatibleProvider(QWEN_SPEC),
});

export const QWEN_SPEC_EXPORT = QWEN_SPEC;
