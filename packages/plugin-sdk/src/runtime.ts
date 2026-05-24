/**
 * Runtime SDK — runtime services available to plugins.
 */

import type { PluginLogger, ServiceLocator } from "./types.js";

// ── File System ──────────────────────────────────────────
export interface FileAccessRuntime {
  /** Read a file as UTF-8 text */
  read(path: string): Promise<string>;
  /** Write a file */
  write(path: string, content: string): Promise<void>;
  /** Check if a file exists */
  exists(path: string): Promise<boolean>;
  /** Delete a file */
  delete(path: string): Promise<void>;
  /** List files in a directory */
  list(dir: string): Promise<string[]>;
}

// ── HTTP Client ──────────────────────────────────────────
export interface HttpClientRuntime {
  /** Make an HTTP GET request */
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
  /** Make an HTTP POST request */
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<HttpResponse>;
  /** Make an arbitrary HTTP request */
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
export interface EnvRuntime {
  /** Get an environment variable */
  get(key: string): string | undefined;
  /** Get with default */
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