/**
 * Runtime SDK — runtime services available to plugins.
 */

import type { PluginLogger, ServiceLocator } from "./types.js";

// ── File System ──────────────────────────────────────────
// 安全：文件操作必须沙箱化到插件自己的 dataDir（见 PluginRuntime.dataDir），
// 仅接受相对路径，拒绝绝对路径、UNC 路径（\\）和 ".." 遍历。
// 实现方不得直接暴露 node:fs，必须在调用底层 fs 前校验路径边界。
export interface FileAccessRuntime {
  /** Read a file as UTF-8 text (path 相对于插件 dataDir，禁止绝对路径/UNC/遍历) */
  read(path: string): Promise<string>;
  /** Write a file (path 相对于插件 dataDir，禁止绝对路径/UNC/遍历) */
  write(path: string, content: string): Promise<void>;
  /** Check if a file exists (path 相对于插件 dataDir) */
  exists(path: string): Promise<boolean>;
  /** Delete a file (path 相对于插件 dataDir) */
  delete(path: string): Promise<void>;
  /** List files in a directory (dir 相对于插件 dataDir) */
  list(dir: string): Promise<string[]>;
}

// ── HTTP Client ──────────────────────────────────────────
// 安全：HTTP 请求必须经过 SSRF 校验，拒绝私网/回环/链路本地地址
// （127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16、localhost）。
// 实现方不得直接暴露 node:http/node:https，必须在校验 URL 后再发起请求。
export interface HttpClientRuntime {
  /** Make an HTTP GET request (URL 须通过 SSRF 校验) */
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
  /** Make an HTTP POST request (URL 须通过 SSRF 校验) */
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<HttpResponse>;
  /** Make an arbitrary HTTP request (URL 须通过 SSRF 校验) */
  request(opts: HttpRequestOptions): Promise<HttpResponse>;
}

export interface HttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}

// ── Environment ──────────────────────────────────────────
// 安全：环境变量访问必须屏蔽敏感 key（密钥/令牌/密码/凭证等），
// 命中以下模式的 key 一律返回 undefined，敏感值应通过 SecretsRuntime 获取。
// 实现方不得直接暴露 process.env，必须基于此黑名单过滤后再返回。
export const SENSITIVE_ENV_KEY_PATTERNS: readonly RegExp[] = [
  /key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /private/i,
  /api[-_]?key/i,
  /auth/i,
];
export interface EnvRuntime {
  /** Get an environment variable (敏感 key 会被屏蔽，返回 undefined) */
  get(key: string): string | undefined;
  /** Get with default (敏感 key 会抛错，须改用 SecretsRuntime) */
  getRequired(key: string): string;
}

// ── Secrets ──────────────────────────────────────────────
export interface SecretsRuntime {
  /** Get a secret value (masked in logs) */
  get(key: string): Promise<string | undefined>;
  /** Set a secret value */
  set(key: string, value: string): Promise<void>;
  /** Delete a secret */
  delete(key: string): Promise<void>;
}

// ── Cron Scheduler ───────────────────────────────────────
export interface CronRuntime {
  /** Register a cron job */
  register(
    name: string,
    schedule: string,
    handler: () => Promise<void>,
    options?: { timezone?: string; enabled?: boolean }
  ): void;
  /** Unregister a cron job */
  unregister(name: string): void;
}

// ── Deduplication ────────────────────────────────────────
export interface DedupeRuntime {
  /** Check if an idempotency key has already been processed */
  check(key: string): Promise<boolean>;
  /** Mark an idempotency key as processed */
  mark(key: string, result: unknown, ttlMs?: number): Promise<void>;
}

// ── Combined Runtime ─────────────────────────────────────
export interface PluginRuntime {
  /** Logger instance */
  logger: PluginLogger;
  /** File system access */
  fs: FileAccessRuntime;
  /** HTTP client */
  http: HttpClientRuntime;
  /** Environment variables */
  env: EnvRuntime;
  /** Secrets manager */
  secrets: SecretsRuntime;
  /** Cron scheduler */
  cron: CronRuntime;
  /** Deduplication */
  dedupe: DedupeRuntime;
  /** Service locator */
  services: ServiceLocator;
  /** Plugin data directory */
  dataDir: string;
}