/**
 * Vitest 全局测试隔离 setup（autouse）
 *
 * 借鉴 hermes-agent 的 _hermetic_environment autouse fixture：
 * - 每个测试前清理凭证相关环境变量（_API_KEY / _TOKEN / _SECRET 等）
 * - 每个测试前清理 EvoClaw 配置变量（EvoClaw_PORT / EvoClaw_DEV 等）
 * - 固定时区为 UTC，固定 LANG/LC_ALL 为 C.UTF-8，保证跨平台一致性
 * - 每个测试后恢复原始环境变量
 *
 * 这确保测试在无凭证、无外部配置的干净环境中运行，避免真实凭证泄漏
 * 到测试输出，也避免本地配置影响测试结果。
 */
import { beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CREDENTIAL_SUFFIXES = [
  "_API_KEY",
  "_TOKEN",
  "_SECRET",
  "_PASSWORD",
  "_CREDENTIALS",
  "_ACCESS_KEY",
  "_SECRET_ACCESS_KEY",
  "_PRIVATE_KEY",
  "_OAUTH_TOKEN",
  "_WEBHOOK_SECRET",
  "_ENCRYPT_KEY",
  "_APP_SECRET",
  "_CLIENT_SECRET",
  "_CORP_SECRET",
  "_AES_KEY",
];
const CREDENTIAL_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "FEISHU_APP_SECRET",
  "WECHAT_APP_SECRET",
  "JWT_SECRET",
  "WEB_UI_TOKEN",
  "DISCORD_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "MATRIX_ACCESS_TOKEN",
];
const EVOCLAW_VARS = [
  "EvoClaw_PORT",
  "EvoClaw_HOST",
  "EvoClaw_DEV",
  "EvoClaw_MCP_ENABLED",
  "EvoClaw_REST_ENABLED",
  "EvoClaw_EVOLUTION_ENABLED",
  "EVOCLAW_OTLP_ENDPOINT",
  "EVOCLAW_MARKETPLACE_REGISTRY_URL",
];

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const key of Object.keys(process.env)) {
    envSnapshot[key] = process.env[key];
  }
  // 清理凭证
  for (const key of Object.keys(process.env)) {
    if (
      CREDENTIAL_SUFFIXES.some((s) => key.endsWith(s)) ||
      CREDENTIAL_NAMES.includes(key) ||
      EVOCLAW_VARS.includes(key)
    ) {
      delete process.env[key];
    }
  }
  // 固定环境
  process.env.TZ = "UTC";
  process.env.LANG = "C.UTF-8";
  process.env.LC_ALL = "C.UTF-8";
});

afterEach(() => {
  // 恢复环境
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
});
