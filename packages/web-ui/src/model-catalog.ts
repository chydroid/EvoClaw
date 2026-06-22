// model-catalog.ts — 对话大模型目录（价格/上下文/baseURL/模型ID）
// 数据来源：各厂商官方 API 文档 / 定价页（2026-06）
// 价格单位统一为每 1M tokens；标注 free 表示有免费额度

export interface ModelInfo {
  id: string;
  name: string;
  contextTokens?: number;
  inputPrice?: number; // 每 1M tokens
  outputPrice?: number; // 每 1M tokens
  currency: string; // "USD" | "CNY"
  isFree?: boolean;
  description?: string;
}

export interface ProviderCatalog {
  id: string;
  name: string;
  baseURL: string;
  protocol: "openai" | "anthropic" | "google";
  homepage: string;
  docs: string;
  pricingUrl: string;
  models: ModelInfo[];
  defaultModel: string;
  order: number;
}

export const CHAT_PROVIDER_CATALOG: ProviderCatalog[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    protocol: "openai",
    homepage: "https://openai.com",
    docs: "https://platform.openai.com/docs",
    pricingUrl: "https://openai.com/api/pricing",
    defaultModel: "gpt-5.5",
    order: 1,
    models: [
      { id: "gpt-5.5", name: "GPT-5.5", contextTokens: 1050000, inputPrice: 5.0, outputPrice: 30.0, currency: "USD", description: "旗舰通用模型" },
      { id: "gpt-5.5-pro", name: "GPT-5.5 Pro", contextTokens: 1050000, inputPrice: 30.0, outputPrice: 180.0, currency: "USD", description: "最高精度推理" },
      { id: "gpt-5.4", name: "GPT-5.4", contextTokens: 270000, inputPrice: 2.5, outputPrice: 15.0, currency: "USD", description: "高性价比旗舰" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini", contextTokens: 270000, inputPrice: 0.75, outputPrice: 4.5, currency: "USD", description: "轻量旗舰" },
      { id: "gpt-5.4-nano", name: "GPT-5.4 nano", contextTokens: 270000, inputPrice: 0.2, outputPrice: 1.25, currency: "USD", description: "廉价后端任务" },
      { id: "gpt-4.1", name: "GPT-4.1", contextTokens: 1000000, inputPrice: 2.0, outputPrice: 8.0, currency: "USD", description: "长上下文文档" },
      { id: "gpt-4.1-mini", name: "GPT-4.1 mini", contextTokens: 1000000, inputPrice: 0.4, outputPrice: 1.6, currency: "USD", description: "长上下文性价比" },
      { id: "gpt-4.1-nano", name: "GPT-4.1 nano", contextTokens: 1000000, inputPrice: 0.1, outputPrice: 0.4, currency: "USD", description: " cheapest" },
      { id: "o4-mini", name: "o4-mini", contextTokens: 200000, inputPrice: 1.1, outputPrice: 4.4, currency: "USD", description: "经济推理" },
      { id: "o3", name: "o3", contextTokens: 200000, inputPrice: 2.0, outputPrice: 8.0, currency: "USD", description: "深度推理" },
      { id: "o3-pro", name: "o3-pro", contextTokens: 200000, inputPrice: 20.0, outputPrice: 80.0, currency: "USD", description: "专业推理" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    baseURL: "https://api.anthropic.com/v1",
    protocol: "anthropic",
    homepage: "https://www.anthropic.com",
    docs: "https://docs.anthropic.com",
    pricingUrl: "https://www.anthropic.com/pricing",
    defaultModel: "claude-sonnet-4-6-20250217",
    order: 2,
    models: [
      { id: "claude-opus-4-8-20260528", name: "Claude Opus 4.8", contextTokens: 1000000, inputPrice: 5.0, outputPrice: 25.0, currency: "USD", description: "旗舰自适应推理" },
      { id: "claude-opus-4-6-20250205", name: "Claude Opus 4.6", contextTokens: 1000000, inputPrice: 5.0, outputPrice: 25.0, currency: "USD", description: "前旗舰" },
      { id: "claude-sonnet-4-6-20250217", name: "Claude Sonnet 4.6", contextTokens: 1000000, inputPrice: 3.0, outputPrice: 15.0, currency: "USD", description: "生产默认" },
      { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", contextTokens: 200000, inputPrice: 3.0, outputPrice: 15.0, currency: "USD", description: "上一代 Sonnet" },
      { id: "claude-haiku-4-5-20250301", name: "Claude Haiku 4.5", contextTokens: 200000, inputPrice: 1.0, outputPrice: 5.0, currency: "USD", description: "高并发轻量" },
    ],
  },
  {
    id: "google",
    name: "Google (Gemini)",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "openai",
    homepage: "https://ai.google.dev",
    docs: "https://ai.google.dev/gemini-api/docs",
    pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    defaultModel: "gemini-2.5-flash",
    order: 3,
    models: [
      { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", contextTokens: 200000, inputPrice: 2.0, outputPrice: 12.0, currency: "USD", description: "旗舰推理（>200K 2x）" },
      { id: "gemini-3.1-flash", name: "Gemini 3.1 Flash", contextTokens: 1000000, inputPrice: 0.5, outputPrice: 3.0, currency: "USD", description: "性能均衡" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextTokens: 1000000, inputPrice: 1.25, outputPrice: 10.0, currency: "USD", description: "成熟稳定" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextTokens: 1000000, inputPrice: 0.3, outputPrice: 1.5, currency: "USD", description: "高性价比" },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", contextTokens: 1000000, inputPrice: 0.1, outputPrice: 0.4, currency: "USD", description: "最便宜 Gemini" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    protocol: "openai",
    homepage: "https://www.deepseek.com",
    docs: "https://api-docs.deepseek.com",
    pricingUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    defaultModel: "deepseek-v4-flash",
    order: 4,
    models: [
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextTokens: 1000000, inputPrice: 3.0, outputPrice: 6.0, currency: "CNY", description: "旗舰 MoE" },
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", contextTokens: 1000000, inputPrice: 1.0, outputPrice: 2.0, currency: "CNY", description: "生产默认" },
      { id: "deepseek-v3.2", name: "DeepSeek-V3.2", contextTokens: 128000, inputPrice: 2.0, outputPrice: 3.0, currency: "CNY", description: "前代旗舰" },
      { id: "deepseek-r1", name: "DeepSeek-R1", contextTokens: 64000, inputPrice: 4.0, outputPrice: 16.0, currency: "CNY", description: "纯推理模型" },
    ],
  },
  {
    id: "qwen",
    name: "通义千问 (Qwen / 阿里云百炼)",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai",
    homepage: "https://bailian.aliyun.com",
    docs: "https://help.aliyun.com/document_detail/611472.html",
    pricingUrl: "https://bailian.aliyun.com/pricing",
    defaultModel: "qwen3.5-plus",
    order: 5,
    models: [
      { id: "qwen3.5-max", name: "Qwen3.5 Max", contextTokens: 1000000, inputPrice: 20.0, outputPrice: 60.0, currency: "CNY", description: "旗舰推理" },
      { id: "qwen3.5-plus", name: "Qwen3.5 Plus", contextTokens: 1000000, inputPrice: 4.0, outputPrice: 16.0, currency: "CNY", description: "多模态全能" },
      { id: "qwen3.5-flash", name: "Qwen3.5 Flash", contextTokens: 1000000, inputPrice: 0.8, outputPrice: 2.0, currency: "CNY", description: "高速轻量" },
      { id: "qwen-max", name: "Qwen-Max", contextTokens: 131000, inputPrice: 20.0, outputPrice: 60.0, currency: "CNY", description: "上一代旗舰" },
      { id: "qwen-plus", name: "Qwen-Plus", contextTokens: 131000, inputPrice: 0.8, outputPrice: 2.0, currency: "CNY", description: "上一代均衡" },
      { id: "qwen-turbo", name: "Qwen-Turbo", contextTokens: 1000000, inputPrice: 0.6, outputPrice: 0.6, currency: "CNY", description: "极简高并发" },
      { id: "qwen-long", name: "Qwen-Long", contextTokens: 10000000, inputPrice: 0.5, outputPrice: 2.0, currency: "CNY", description: "10M 超长文本" },
    ],
  },
  {
    id: "zhipu",
    name: "智谱AI (GLM)",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai",
    homepage: "https://www.zhipuai.cn",
    docs: "https://open.bigmodel.cn/dev/api",
    pricingUrl: "https://open.bigmodel.cn/pricing",
    defaultModel: "glm-5.1",
    order: 6,
    models: [
      { id: "glm-5.1", name: "GLM-5.1", contextTokens: 1049000, inputPrice: 10.0, outputPrice: 30.0, currency: "CNY", description: "旗舰" },
      { id: "glm-4-plus", name: "GLM-4 Plus", contextTokens: 128000, inputPrice: 0.05, outputPrice: 0.05, currency: "CNY", description: "均衡" },
      { id: "glm-4-air", name: "GLM-4 Air", contextTokens: 128000, inputPrice: 0.001, outputPrice: 0.001, currency: "CNY", description: "轻量" },
      { id: "glm-4-flash", name: "GLM-4 Flash", contextTokens: 128000, inputPrice: 0.0, outputPrice: 0.0, currency: "CNY", isFree: true, description: "免费" },
    ],
  },
  {
    id: "moonshot",
    name: "月之暗面 (Kimi)",
    baseURL: "https://api.moonshot.cn/v1",
    protocol: "openai",
    homepage: "https://www.moonshot.cn",
    docs: "https://platform.moonshot.cn/docs",
    pricingUrl: "https://platform.moonshot.cn/docs/pricing",
    defaultModel: "kimi-k2.6",
    order: 7,
    models: [
      { id: "kimi-k2.6", name: "Kimi K2.6", contextTokens: 262000, inputPrice: 3.0, outputPrice: 12.0, currency: "CNY", description: "Kimi 最新旗舰" },
      { id: "kimi-k2.5", name: "Kimi K2.5", contextTokens: 262000, inputPrice: 2.0, outputPrice: 8.0, currency: "CNY", description: "长上下文通用" },
      { id: "moonshot-v1-128k", name: "Moonshot v1 128k", contextTokens: 128000, inputPrice: 0.6, outputPrice: 0.6, currency: "CNY", description: "上一代长文" },
      { id: "moonshot-v1-32k", name: "Moonshot v1 32k", contextTokens: 32000, inputPrice: 0.24, outputPrice: 0.24, currency: "CNY", description: "上一代通用" },
    ],
  },
  {
    id: "wenxin",
    name: "百度文心 (ERNIE / 千帆)",
    baseURL: "https://qianfan.baidubce.com/v2",
    protocol: "openai",
    homepage: "https://qianfan.cloud.baidu.com",
    docs: "https://cloud.baidu.com/doc/WENXINWORKSHOP/s/flfmc9do2",
    pricingUrl: "https://cloud.baidu.com/doc/WENXINWORKSHOP/s/hlrk4akp7",
    defaultModel: "ernie-4.5-8k",
    order: 8,
    models: [
      { id: "ernie-4.5-8k", name: "ERNIE 4.5 8K", contextTokens: 8000, inputPrice: 0.03, outputPrice: 0.09, currency: "CNY", description: "旗舰" },
      { id: "ernie-4.0-8k-latest", name: "ERNIE 4.0 8K", contextTokens: 8000, inputPrice: 0.02, outputPrice: 0.06, currency: "CNY", description: "上一代" },
      { id: "ernie-speed-128k", name: "ERNIE Speed 128K", contextTokens: 128000, inputPrice: 0.0, outputPrice: 0.0, currency: "CNY", isFree: true, description: "免费轻量" },
      { id: "ernie-lite-8k", name: "ERNIE Lite 8K", contextTokens: 8000, inputPrice: 0.0, outputPrice: 0.0, currency: "CNY", isFree: true, description: "免费" },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseURL: "https://api.minimax.chat/v1",
    protocol: "openai",
    homepage: "https://www.minimaxi.com",
    docs: "https://platform.minimaxi.com/document/Guideline",
    pricingUrl: "https://platform.minimaxi.com/document/Price",
    defaultModel: "MiniMax-M3",
    order: 9,
    models: [
      { id: "MiniMax-M3", name: "MiniMax-M3", contextTokens: 1000000, inputPrice: 2.1, outputPrice: 8.4, currency: "CNY", description: "多模态 coding/agent" },
      { id: "MiniMax-Text-01", name: "MiniMax-Text-01", contextTokens: 1000000, inputPrice: 1.0, outputPrice: 4.0, currency: "CNY", description: "长上下文" },
      { id: "abab6.5s-chat", name: "abab6.5s", contextTokens: 8000, inputPrice: 0.005, outputPrice: 0.005, currency: "CNY", description: "轻量" },
    ],
  },
  {
    id: "doubao",
    name: "豆包 (Doubao / 火山方舟)",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    protocol: "openai",
    homepage: "https://www.volcengine.com/product/ark",
    docs: "https://www.volcengine.com/docs/82379",
    pricingUrl: "https://www.volcengine.com/docs/82379/1330310",
    defaultModel: "doubao-pro-1-6-256k",
    order: 10,
    models: [
      { id: "doubao-pro-1-6-256k", name: "Doubao Pro 1.6 256K", contextTokens: 256000, inputPrice: 5.0, outputPrice: 15.0, currency: "CNY", description: "旗舰" },
      { id: "doubao-pro-1-6-128k", name: "Doubao Pro 1.6 128K", contextTokens: 128000, inputPrice: 5.0, outputPrice: 15.0, currency: "CNY", description: "旗舰" },
      { id: "doubao-pro-1-5-128k", name: "Doubao Pro 1.5 128K", contextTokens: 128000, inputPrice: 5.0, outputPrice: 15.0, currency: "CNY", description: "前代旗舰" },
      { id: "doubao-lite-1-5-128k", name: "Doubao Lite 1.5 128K", contextTokens: 128000, inputPrice: 0.8, outputPrice: 1.0, currency: "CNY", description: "轻量" },
      { id: "doubao-vision-pro-32k", name: "Doubao Vision Pro 32K", contextTokens: 32000, inputPrice: 2.0, outputPrice: 6.0, currency: "CNY", description: "视觉" },
    ],
  },
  {
    id: "spark",
    name: "讯飞星火 (Spark)",
    baseURL: "https://spark-api-open.xf-yun.com/v1",
    protocol: "openai",
    homepage: "https://xinghuo.xfyun.cn",
    docs: "https://www.xfyun.cn/doc/spark/Web.html",
    pricingUrl: "https://www.xfyun.cn/solutions/xinghuoAPI",
    defaultModel: "spark-4.5",
    order: 11,
    models: [
      { id: "spark-4.5", name: "Spark 4.5", contextTokens: 128000, inputPrice: 30.0, outputPrice: 30.0, currency: "CNY", description: "旗舰" },
      { id: "4.0Ultra", name: "Spark 4.0 Ultra", contextTokens: 128000, inputPrice: 15.0, outputPrice: 15.0, currency: "CNY", description: "上一代" },
      { id: "pro-128k", name: "Spark Pro 128K", contextTokens: 128000, inputPrice: 10.0, outputPrice: 10.0, currency: "CNY", description: "专业" },
      { id: "max-32k", name: "Spark Max 32K", contextTokens: 32000, inputPrice: 5.0, outputPrice: 5.0, currency: "CNY", description: "标准" },
      { id: "lite", name: "Spark Lite", contextTokens: 8000, inputPrice: 0.0, outputPrice: 0.0, currency: "CNY", isFree: true, description: "免费" },
    ],
  },
  {
    id: "sensenova",
    name: "商汤日日新 (SenseNova)",
    baseURL: "https://api.sensenova.cn/v1",
    protocol: "openai",
    homepage: "https://www.sensenova.com",
    docs: "https://www.sensenova.com/api/document",
    pricingUrl: "https://www.sensenova.com/price",
    defaultModel: "SenseChat-6",
    order: 12,
    models: [
      { id: "SenseChat-6", name: "SenseChat 6", contextTokens: 200000, inputPrice: 5.0, outputPrice: 15.0, currency: "CNY", description: "旗舰" },
      { id: "SenseChat-5.5", name: "SenseChat 5.5", contextTokens: 128000, inputPrice: 2.0, outputPrice: 6.0, currency: "CNY", description: "均衡" },
      { id: "SenseChat-5", name: "SenseChat 5", contextTokens: 128000, inputPrice: 2.0, outputPrice: 6.0, currency: "CNY", description: "上一代" },
      { id: "SenseChat-Turbo", name: "SenseChat Turbo", contextTokens: 128000, inputPrice: 0.5, outputPrice: 1.5, currency: "CNY", description: "轻量" },
    ],
  },
  {
    id: "yi",
    name: "零一万物 (Yi)",
    baseURL: "https://api.lingyiwanwu.com/v1",
    protocol: "openai",
    homepage: "https://www.lingyiwanwu.com",
    docs: "https://platform.lingyiwanwu.com/docs",
    pricingUrl: "https://platform.lingyiwanwu.com/docs/pricing",
    defaultModel: "yi-large",
    order: 13,
    models: [
      { id: "yi-large", name: "Yi-Large", contextTokens: 32000, inputPrice: 20.0, outputPrice: 20.0, currency: "CNY", description: "旗舰" },
      { id: "yi-medium", name: "Yi-Medium", contextTokens: 16000, inputPrice: 2.5, outputPrice: 2.5, currency: "CNY", description: "标准" },
      { id: "yi-vision", name: "Yi-Vision", contextTokens: 16000, inputPrice: 6.0, outputPrice: 6.0, currency: "CNY", description: "视觉" },
      { id: "yi-spark", name: "Yi-Spark", contextTokens: 16000, inputPrice: 1.0, outputPrice: 1.0, currency: "CNY", description: "轻量" },
    ],
  },
  {
    id: "stepfun",
    name: "阶跃星辰 (StepFun)",
    baseURL: "https://api.stepfun.com/v1",
    protocol: "openai",
    homepage: "https://www.stepfun.com",
    docs: "https://platform.stepfun.com/docs",
    pricingUrl: "https://platform.stepfun.com/docs/pricing",
    defaultModel: "step-2-16k",
    order: 14,
    models: [
      { id: "step-3", name: "Step-3", contextTokens: 1000000, inputPrice: 10.0, outputPrice: 30.0, currency: "CNY", description: "旗舰" },
      { id: "step-2-16k", name: "Step-2 16K", contextTokens: 16000, inputPrice: 15.0, outputPrice: 60.0, currency: "CNY", description: "强推理" },
      { id: "step-1.5v-mini", name: "Step-1.5V Mini", contextTokens: 32000, inputPrice: 4.0, outputPrice: 12.0, currency: "CNY", description: "多模态" },
      { id: "step-1-128k", name: "Step-1 128K", contextTokens: 128000, inputPrice: 2.0, outputPrice: 8.0, currency: "CNY", description: "长文" },
    ],
  },
  {
    id: "baichuan",
    name: "百川智能 (Baichuan)",
    baseURL: "https://api.baichuan-ai.com/v1",
    protocol: "openai",
    homepage: "https://www.baichuan-ai.com",
    docs: "https://platform.baichuan-ai.com/docs",
    pricingUrl: "https://platform.baichuan-ai.com/pricing",
    defaultModel: "Baichuan4",
    order: 15,
    models: [
      { id: "Baichuan4", name: "Baichuan4", contextTokens: 32000, inputPrice: 10.0, outputPrice: 30.0, currency: "CNY", description: "旗舰" },
      { id: "Baichuan3-Turbo", name: "Baichuan3-Turbo", contextTokens: 32000, inputPrice: 1.0, outputPrice: 2.0, currency: "CNY", description: "均衡" },
      { id: "Baichuan3-Turbo-128k", name: "Baichuan3-Turbo-128K", contextTokens: 128000, inputPrice: 2.0, outputPrice: 4.0, currency: "CNY", description: "长文" },
      { id: "Baichuan2-Turbo", name: "Baichuan2-Turbo", contextTokens: 32000, inputPrice: 0.5, outputPrice: 1.0, currency: "CNY", description: "轻量" },
    ],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    baseURL: "https://api.x.ai/v1",
    protocol: "openai",
    homepage: "https://x.ai",
    docs: "https://docs.x.ai",
    pricingUrl: "https://x.ai/api/pricing",
    defaultModel: "grok-4",
    order: 16,
    models: [
      { id: "grok-4", name: "Grok 4", contextTokens: 256000, inputPrice: 3.0, outputPrice: 15.0, currency: "USD", description: "旗舰" },
      { id: "grok-4-mini", name: "Grok 4 mini", contextTokens: 128000, inputPrice: 0.6, outputPrice: 2.0, currency: "USD", description: "轻量" },
      { id: "grok-3", name: "Grok 3", contextTokens: 128000, inputPrice: 3.0, outputPrice: 15.0, currency: "USD", description: "上一代" },
    ],
  },
  {
    id: "cohere",
    name: "Cohere",
    baseURL: "https://api.cohere.com/v2",
    protocol: "openai",
    homepage: "https://cohere.com",
    docs: "https://docs.cohere.com",
    pricingUrl: "https://cohere.com/pricing",
    defaultModel: "command-a",
    order: 17,
    models: [
      { id: "command-a", name: "Command A", contextTokens: 256000, inputPrice: 2.5, outputPrice: 10.0, currency: "USD", description: "企业级" },
      { id: "command-r-plus-08-2024", name: "Command R+", contextTokens: 128000, inputPrice: 3.0, outputPrice: 15.0, currency: "USD", description: "长上下文" },
      { id: "command-r-08-2024", name: "Command R", contextTokens: 128000, inputPrice: 0.15, outputPrice: 0.6, currency: "USD", description: "性价比" },
    ],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    baseURL: "https://api.mistral.ai/v1",
    protocol: "openai",
    homepage: "https://mistral.ai",
    docs: "https://docs.mistral.ai",
    pricingUrl: "https://mistral.ai/technology",
    defaultModel: "mistral-large-2",
    order: 18,
    models: [
      { id: "mistral-large-2", name: "Mistral Large 2", contextTokens: 128000, inputPrice: 2.0, outputPrice: 6.0, currency: "USD", description: "旗舰" },
      { id: "codestral-2501", name: "Codestral 25.01", contextTokens: 256000, inputPrice: 0.3, outputPrice: 0.9, currency: "USD", description: "代码" },
      { id: "mistral-saba-25.02", name: "Mistral Saba", contextTokens: 32000, inputPrice: 0.2, outputPrice: 0.4, currency: "USD", description: "区域特化" },
      { id: "ministral-8b-2410", name: "Ministral 8B", contextTokens: 128000, inputPrice: 0.1, outputPrice: 0.1, currency: "USD", description: "轻量" },
    ],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    baseURL: "https://api.perplexity.ai",
    protocol: "openai",
    homepage: "https://www.perplexity.ai",
    docs: "https://docs.perplexity.ai",
    pricingUrl: "https://www.perplexity.ai/pricing",
    defaultModel: "sonar-pro",
    order: 19,
    models: [
      { id: "sonar-pro", name: "Sonar Pro", contextTokens: 200000, inputPrice: 3.0, outputPrice: 15.0, currency: "USD", description: "联网搜索" },
      { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro", contextTokens: 128000, inputPrice: 2.0, outputPrice: 8.0, currency: "USD", description: "推理搜索" },
      { id: "sonar", name: "Sonar", contextTokens: 128000, inputPrice: 1.0, outputPrice: 1.0, currency: "USD", description: "轻量搜索" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    protocol: "openai",
    homepage: "https://groq.com",
    docs: "https://console.groq.com/docs",
    pricingUrl: "https://groq.com/pricing",
    defaultModel: "llama-4-maverick",
    order: 20,
    models: [
      { id: "llama-4-maverick", name: "Llama 4 Maverick", contextTokens: 128000, inputPrice: 0.2, outputPrice: 0.6, currency: "USD", description: "高速" },
      { id: "llama-4-scout", name: "Llama 4 Scout", contextTokens: 128000, inputPrice: 0.11, outputPrice: 0.34, currency: "USD", description: "超高速" },
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", contextTokens: 128000, inputPrice: 0.59, outputPrice: 0.79, currency: "USD", description: "通用" },
      { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B", contextTokens: 32768, inputPrice: 0.24, outputPrice: 0.24, currency: "USD", description: "MoE" },
    ],
  },
  {
    id: "siliconflow",
    name: "硅基流动 (SiliconFlow)",
    baseURL: "https://api.siliconflow.cn/v1",
    protocol: "openai",
    homepage: "https://siliconflow.cn",
    docs: "https://docs.siliconflow.cn",
    pricingUrl: "https://siliconflow.cn/zh-cn/pricing",
    defaultModel: "deepseek-ai/DeepSeek-V4-Pro",
    order: 21,
    models: [
      { id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek-V4-Pro", contextTokens: 1000000, inputPrice: 1.6, outputPrice: 3.48, currency: "CNY", description: "旗舰" },
      { id: "deepseek-ai/DeepSeek-V4-Flash", name: "DeepSeek-V4-Flash", contextTokens: 1000000, inputPrice: 0.14, outputPrice: 0.28, currency: "CNY", description: "高性价比" },
      { id: "Qwen/Qwen3.5-72B", name: "Qwen3.5 72B", contextTokens: 131000, inputPrice: 0.0, outputPrice: 0.0, currency: "CNY", isFree: true, description: "免费" },
      { id: "THUDM/GLM-4-Flash-9B", name: "GLM-4-Flash-9B", contextTokens: 128000, inputPrice: 0.0, outputPrice: 0.0, currency: "CNY", isFree: true, description: "免费" },
      { id: "meta-llama/Llama-4-Scout-17B-16E-Instruct", name: "Llama 4 Scout", contextTokens: 1000000, inputPrice: 0.0, outputPrice: 0.0, currency: "CNY", isFree: true, description: "免费" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    protocol: "openai",
    homepage: "https://openrouter.ai",
    docs: "https://openrouter.ai/docs",
    pricingUrl: "https://openrouter.ai/models",
    defaultModel: "openai/gpt-5.5",
    order: 22,
    models: [
      { id: "openai/gpt-5.5", name: "GPT-5.5 (via OR)", contextTokens: 1050000, inputPrice: 5.0, outputPrice: 30.0, currency: "USD", description: "聚合路由" },
      { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8 (via OR)", contextTokens: 1000000, inputPrice: 5.0, outputPrice: 25.0, currency: "USD", description: "聚合路由" },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (via OR)", contextTokens: 1000000, inputPrice: 3.0, outputPrice: 6.0, currency: "CNY", description: "聚合路由" },
      { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash (via OR)", contextTokens: 1000000, inputPrice: 0.3, outputPrice: 1.5, currency: "USD", description: "聚合路由" },
    ],
  },
  {
    id: "novita",
    name: "Novita AI",
    baseURL: "https://api.novita.ai/v3/openai",
    protocol: "openai",
    homepage: "https://novita.ai",
    docs: "https://novita.ai/docs",
    pricingUrl: "https://novita.ai/pricing",
    defaultModel: "deepseek/deepseek-v4-pro",
    order: 23,
    models: [
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextTokens: 1000000, inputPrice: 1.74, outputPrice: 3.48, currency: "USD", description: "低价 DeepSeek" },
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", contextTokens: 128000, inputPrice: 0.15, outputPrice: 0.45, currency: "USD", description: "低价 Llama" },
      { id: "qwen/qwen3.5-72b", name: "Qwen3.5 72B", contextTokens: 131000, inputPrice: 0.08, outputPrice: 0.28, currency: "USD", description: "低价 Qwen" },
    ],
  },
  {
    id: "tencent",
    name: "腾讯混元 (Tencent Hunyuan)",
    baseURL: "https://hunyuan.tencentcloudapi.com/v2",
    protocol: "openai",
    homepage: "https://cloud.tencent.com/product/hunyuan",
    docs: "https://cloud.tencent.com/document/product/1729",
    pricingUrl: "https://cloud.tencent.com/document/product/1729/104753",
    defaultModel: "hunyuan-turbo-latest",
    order: 24,
    models: [
      { id: "hunyuan-turbo-latest", name: "Hunyuan Turbo", contextTokens: 32000, inputPrice: 15.0, outputPrice: 50.0, currency: "CNY", description: "旗舰" },
      { id: "hunyuan-pro", name: "Hunyuan Pro", contextTokens: 32000, inputPrice: 30.0, outputPrice: 100.0, currency: "CNY", description: "专业" },
      { id: "hunyuan-standard", name: "Hunyuan Standard", contextTokens: 32000, inputPrice: 4.5, outputPrice: 5.0, currency: "CNY", description: "标准" },
      { id: "hunyuan-lite", name: "Hunyuan Lite", contextTokens: 8000, inputPrice: 0.0, outputPrice: 0.0, currency: "CNY", isFree: true, description: "免费" },
    ],
  },
  {
    id: "huawei",
    name: "华为盘古 (Pangu)",
    baseURL: "https://pangu.huaweicloud.com/api/v1",
    protocol: "openai",
    homepage: "https://www.huaweicloud.com/product/pangu.html",
    docs: "https://support.huaweicloud.com/productdesc-pangu/pangu_01_0001.html",
    pricingUrl: "https://www.huaweicloud.com/pricing.html",
    defaultModel: "pangu-ultra",
    order: 25,
    models: [
      { id: "pangu-ultra", name: "Pangu Ultra", contextTokens: 128000, inputPrice: 10.0, outputPrice: 30.0, currency: "CNY", description: "旗舰" },
      { id: "pangu-pro", name: "Pangu Pro", contextTokens: 128000, inputPrice: 5.0, outputPrice: 15.0, currency: "CNY", description: "标准" },
      { id: "pangu-lite", name: "Pangu Lite", contextTokens: 32000, inputPrice: 1.0, outputPrice: 2.0, currency: "CNY", description: "轻量" },
    ],
  },
  {
    id: "local",
    name: "Local Model (Ollama / vLLM)",
    baseURL: "http://localhost:11434/v1",
    protocol: "openai",
    homepage: "https://ollama.com",
    docs: "https://github.com/ollama/ollama/blob/main/docs/api.md",
    pricingUrl: "",
    defaultModel: "llama3",
    order: 26,
    models: [
      { id: "llama3", name: "Llama 3", contextTokens: 128000, currency: "USD", isFree: true, description: "本地运行" },
      { id: "qwen2.5", name: "Qwen 2.5", contextTokens: 128000, currency: "CNY", isFree: true, description: "本地运行" },
      { id: "deepseek-r1", name: "DeepSeek-R1", contextTokens: 128000, currency: "CNY", isFree: true, description: "本地运行" },
      { id: "custom", name: "Custom local model", contextTokens: 128000, currency: "USD", isFree: true, description: "自定义" },
    ],
  },
  {
    id: "xiaomi-mimo",
    name: "小米 MiMo",
    baseURL: "https://api.xiaomimimo.com/v1",
    protocol: "openai",
    homepage: "https://mimo.mi.com",
    docs: "https://platform.xiaomimimo.com/docs/zh-CN",
    pricingUrl: "https://mimo.mi.com/#/docs/pricing",
    defaultModel: "mimo-v2.5-pro",
    order: 28,
    models: [
      { id: "mimo-v2.5-pro", name: "MiMo-V2.5 Pro", contextTokens: 1000000, inputPrice: 3.0, outputPrice: 6.0, currency: "CNY", description: "旗舰推理（1M 上下文）" },
      { id: "mimo-v2.5", name: "MiMo-V2.5", contextTokens: 1000000, inputPrice: 1.0, outputPrice: 2.0, currency: "CNY", description: "全模态全能（1M 上下文）" },
      { id: "mimo-v2-omni", name: "MiMo-V2 Omni", contextTokens: 256000, inputPrice: 1.0, outputPrice: 2.0, currency: "CNY", description: "全模态理解" },
      { id: "mimo-v2-flash", name: "MiMo-V2 Flash", contextTokens: 256000, inputPrice: 0.7, outputPrice: 2.1, currency: "CNY", description: "轻量高速" },
    ],
  },
  {
    id: "custom",
    name: "Custom Provider",
    baseURL: "",
    protocol: "openai",
    homepage: "",
    docs: "",
    pricingUrl: "",
    defaultModel: "",
    order: 29,
    models: [],
  },
];

export function buildDefaultProviders(): Array<{
  id: string;
  name: string;
  apiKey: string;
  baseURL: string;
  models: string[];
  selectedModel: string;
  enabled: boolean;
  order: number;
  config: { temperature: number; maxTokens: number; timeout: number; topP: number };
  catalog: ProviderCatalog;
}> {
  return CHAT_PROVIDER_CATALOG.map((p) => ({
    id: p.id,
    name: p.name,
    apiKey: "",
    baseURL: p.baseURL,
    models: p.models.map((m) => m.id),
    selectedModel: p.defaultModel,
    enabled: p.id === "local",
    order: p.order,
    config: { temperature: 0.7, maxTokens: 40960, timeout: 60000, topP: 1 },
    catalog: p,
  }));
}

export function formatPrice(m?: ModelInfo): string {
  if (!m) return "";
  if (m.isFree) return "免费";
  if (m.inputPrice == null || m.outputPrice == null) return "";
  const unit = m.currency === "CNY" ? "¥" : "$";
  return `${unit}${m.inputPrice}/${unit}${m.outputPrice} /1M tokens`;
}
