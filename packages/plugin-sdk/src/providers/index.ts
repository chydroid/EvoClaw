/**
 * Provider 扩展样板 barrel。
 *
 * 对标 OpenClaw extensions/ 目录下的 provider 插件。
 *
 * 每个文件都是一个独立的 provider 扩展样板，遵循 OpenAI 兼容协议：
 *   - deepseek: DeepSeek API
 *   - groq: Groq 超低延迟推理
 *   - qwen: 阿里云通义千问 (DashScope)
 *   - mistral: Mistral AI
 *   - xai: xAI Grok
 *
 * 使用方式（任选其一）：
 *   1. 直接导入：`import deepseek from "@evoclaw/plugin-sdk/providers/deepseek"`
 *   2. 通过扩展发现：在 package.json 中声明 "evoclaw.extensions"
 */
export { default as deepseekProvider } from "./deepseek.js";
export { default as groqProvider } from "./groq.js";
export { default as qwenProvider } from "./qwen.js";
export { default as mistralProvider } from "./mistral.js";
export { default as xaiProvider } from "./xai.js";
