/**
 * EvoClaw Plugin SDK — Type-safe extension framework
 *
 * The Plugin SDK provides standardized interfaces for extending EvoClaw with:
 * - Channels (WhatsApp, Telegram, Discord, etc.)
 * - Providers (OpenAI, Anthropic, custom LLM backends)
 * - Tools (custom tool implementations)
 * - Config extensions (custom config sections with validation)
 * - Runtime services (logging, file access, health checks)
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