/**
 * EnvManager — 远程环境变量管理（对标 hermes web/src/pages/EnvPage 的 env var 子集）。
 *
 * 背景：EvoClaw 的环境变量在启动时由 env-loader 从 .env 注入 process.env，
 * 运行时无法增删改。hermes EnvPage（1109 行）提供 env var 的 CRUD + reveal。
 * EvoClaw 的 SecretsManager 管的是**凭证**（加密 API key），与 env var 是两个概念。
 *
 * 因此本模块只做 env var 的**运行时可管理子集**：持久化到 data/env.json，
 * 写入/删除时同步 process.env（其他组件读 process.env 即可见）。
 * 不承载 hermes 的 channel-managed flags 等高级语义。
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "./atomic-write";

export interface EnvEntry {
  key: string;
  value: string;
  /** 来源：envfile=来自 .env，api=经 API 设置，system=系统内置（只读） */
  source: "envfile" | "api" | "system";
  /** 是否只读（system 来源或白名单保护的 key 不允许经 API 改写） */
  readonly: boolean;
  /** 最后修改时间 ISO 字符串 */
  updatedAt: string;
}

/** 不允许经 API 修改的系统/保护 key（避免破坏运行时）。 */
const PROTECTED_KEYS = new Set([
  "NODE_ENV", "EvoClaw_PORT", "EvoClaw_HOST", "WEB_UI_TOKEN", "JWT_SECRET",
  "HOME", "PATH", "USER", "SHELL", "LANG", "TERM", "PWD", "CI",
]);

function isProtected(key: string): boolean {
  if (PROTECTED_KEYS.has(key)) return true;
  // EvoClaw_ 前缀为运行时保留环境变量，不允许经 API 改写
  return key.startsWith("EvoClaw_");
}

export class EnvManager {
  private storePath: string;
  private store: Record<string, Omit<EnvEntry, "key">>;

  constructor(storePath: string) {
    this.storePath = storePath;
    this.store = this.load();
  }

  private load(): Record<string, Omit<EnvEntry, "key">> {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, Omit<EnvEntry, "key">>;
        return parsed || {};
      }
    } catch {
      // 损坏文件回落空
    }
    return {};
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      atomicWriteFileSync(this.storePath, JSON.stringify(this.store, null, 2));
    } catch {
      // 持久化失败不阻塞内存操作
    }
  }

  /** 列出所有经 API 管理的 env var（不含 process.env 全量，避免暴露敏感系统变量）。 */
  list(): EnvEntry[] {
    return Object.entries(this.store).map(([key, v]) => ({
      key,
      value: v.value,
      source: v.source,
      readonly: v.readonly,
      updatedAt: v.updatedAt,
    }));
  }

  get(key: string): EnvEntry | null {
    const entry = this.store[key];
    if (!entry) return null;
    return { key, ...entry };
  }

  set(key: string, value: string): EnvEntry {
    const k = (key || "").trim();
    if (!k) throw new Error("Env key is required");
    if (isProtected(k)) throw new Error(`Env key "${k}" is protected and cannot be modified via API`);
    const now = new Date().toISOString();
    const existing = this.store[k];
    this.store[k] = {
      value: String(value),
      source: "api",
      readonly: false,
      updatedAt: existing ? existing.updatedAt : now,
    };
    // 同步到 process.env，使其他组件读 process.env 即可见
    process.env[k] = String(value);
    this.persist();
    return { key: k, ...this.store[k] };
  }

  delete(key: string): boolean {
    const k = (key || "").trim();
    if (!k) return false;
    if (isProtected(k)) throw new Error(`Env key "${k}" is protected and cannot be deleted via API`);
    if (!(k in this.store)) return false;
    delete this.store[k];
    delete process.env[k];
    this.persist();
    return true;
  }
}