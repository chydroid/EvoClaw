/**
 * EvoClaw Plugin SDK — Type-safe extension framework
 *
 * The Plugin SDK provides standardized interfaces for extending EvoClaw with:
 * - Channels (WhatsApp, Telegram, Discord, etc.)
 * - Providers (OpenAI, Anthropic, custom LLM backends)
 * - Tools (custom tool implementations)
 * - Config extensions (custom config sections with validation)
 * - Runtime services (logging, file access, health checks)
 *
 * 细分运行时子路径（对标 OpenClaw plugin-sdk 的细分 exports）：
 *   - `@evoclaw/plugin-sdk/channel-runtime`  频道插件运行时与 defineChannel()
 *   - `@evoclaw/plugin-sdk/provider-runtime` provider 插件运行时与 defineProvider()
 *   - `@evoclaw/plugin-sdk/tool-runtime`     工具插件运行时与 defineTool()
 *   - `@evoclaw/plugin-sdk/approval-runtime` 审批流程运行时与策略工厂
 *   - `@evoclaw/plugin-sdk/plugin-entry`    插件包入口契约与 definePlugin()
 */

// ── Core Types ───────────────────────────────────────────
export * from "./types.js";

// ── Plugin Interface ─────────────────────────────────────
export * from "./plugin.js";

// ── Plugin Host ──────────────────────────────────────────
export * from "./plugin-host.js";

// ── Channel SDK ──────────────────────────────────────────
export * from "./channel.js";

// ── Provider SDK ─────────────────────────────────────────
export * from "./provider.js";

// ── Tool SDK ─────────────────────────────────────────────
export * from "./tool.js";

// ── Config SDK ───────────────────────────────────────────
export * from "./config.js";

// ── Runtime SDK ──────────────────────────────────────────
export * from "./runtime.js";

// ── Health SDK ───────────────────────────────────────────
export * from "./health.js";

// ── Runtime sub-modules（也通过 package.json exports 子路径暴露） ──
export * as ChannelRuntime from "./channel-runtime.js";
export * as ProviderRuntime from "./provider-runtime.js";
export * as ToolRuntime from "./tool-runtime.js";
export * as ApprovalRuntime from "./approval-runtime.js";
export * as PluginEntry from "./plugin-entry.js";