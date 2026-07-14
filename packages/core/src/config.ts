import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { ConfigWatcher, type SchemaConfigChange } from "./config-schema.js";
import { atomicWriteFileSync } from "./atomic-write";

export interface PersonaConfig {
  name: string;
  title: string;
  masterTerm: string;
  tone: "warm" | "professional" | "casual" | "humorous";
  introduction: string;
}

export interface AppConfig {
  server: {
    port: number;
    host: string;
    corsOrigins: string[];
  };
  auth: {
    jwtSecret: string;
    tokenExpiry: string;
    refreshExpiry: string;
  };
  gateway: {
    port: number;
    host: string;
    jwtSecret: string;
    enableMCP: boolean;
    enableREST: boolean;
    rateLimitWindow: number;
    rateLimitMax: number;
  };
  persona: PersonaConfig;
  agent: {
    minAgents: number;
    maxAgents: number;
    maxRetries: number;
    defaultTimeout: number;
    scaleThreshold: number;
    pollDelayMs: number;
  };
  sandbox: {
    defaultMaxExecutionTime: number;
    defaultMaxMemoryMB: number;
    allowNetwork: boolean;
    allowFileSystem: boolean;
    allowSubprocess: boolean;
  };
  memory: {
    shortTermDefaultTTL: number;
    vectorDimension: number;
    similarityThreshold: number;
    maxHistoryEntries: number;
  };
  security: {
    auditRetention: number;
    rateLimitDefault: number;
    rateLimitWindow: number;
    anomalyCheckInterval: number;
  };
  evolution: {
    enabled: boolean;
    autoEvolution: boolean;
    minConfidence: number;
    maxCandidatesPerCycle: number;
    learningJournal: {
      path: string;
      enabled: boolean;
      autoPersist: boolean;
      persistIntervalMs: number;
      maxEntries: number;
    };
  };
}

export const defaultConfig: AppConfig = {
  server: {
    port: 27788,
    host: "127.0.0.1",
    corsOrigins: ["http://localhost:5173"],
  },
  auth: {
    jwtSecret: "evoclaw-dev-secret-change-in-production",
    tokenExpiry: "24h",
    refreshExpiry: "7d",
  },
  gateway: {
    port: 27788,
    host: "0.0.0.0",
    jwtSecret: "evoclaw-dev-secret-change-in-production",
    enableMCP: true,
    enableREST: true,
    rateLimitWindow: 60000,
    rateLimitMax: 100,
  },
  persona: {
    name: "EvoClaw小助手",
    title: "您的专属EvoClaw智能助理",
    masterTerm: "主人",
    tone: "warm",
    introduction: `您好主人！我是 EvoClaw小助手，您的专属EvoClaw智能助理 🧬

很高兴为您服务！以下是我能帮您做的事情：

✨ 日常对话与问答
  - 回答知识类问题，提供建议和建议
  - 辅助您进行学习、写作和思考

🛠️ 技能执行
  - 运行已安装的 Skills（技能），自动化处理各类任务
  - 支持从 ClawHub 安装新的 Skills

🚀 任务编排
  - 将复杂任务自动拆解为 DAG 执行计划
  - 动态匹配最优 Skills 组合完成目标

🔬 自我进化
  - 根据执行反馈不断优化策略
  - 学习您的偏好，越来越"懂"你

📡 多平台对接
  - 飞书、企业微信、个人微信等 Channel
  - MCP 协议标准化接口

🌐 技能市场
  - 访问 clawhub.ai 发现海量 Skills
  - 国内用户可使用 cn.clawhub-mirror.com 加速

有什么需要，随时吩咐我！`,
  },
  agent: {
    minAgents: 2,
    maxAgents: 10,
    maxRetries: 3,
    defaultTimeout: 300000,
    scaleThreshold: 0.7,
    pollDelayMs: 100,
  },
  sandbox: {
    defaultMaxExecutionTime: 30000,
    defaultMaxMemoryMB: 128,
    allowNetwork: false,
    allowFileSystem: true,
    allowSubprocess: false,
  },
  memory: {
    shortTermDefaultTTL: 3600000,
    vectorDimension: 1536,
    similarityThreshold: 0.75,
    maxHistoryEntries: 1000,
  },
  security: {
    auditRetention: 10000,
    rateLimitDefault: 100,
    rateLimitWindow: 60000,
    anomalyCheckInterval: 30000,
  },
  evolution: {
    enabled: true,
    autoEvolution: false,
    minConfidence: 0.5,
    maxCandidatesPerCycle: 5,
    learningJournal: {
      path: "LEARNINGS.md",
      enabled: true,
      autoPersist: true,
      persistIntervalMs: 5000,
      maxEntries: 10000,
    },
  },
};

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Record<string, unknown> ? DeepPartial<T[P]> : T[P];
};

export interface ConfigChange {
  /** Top-level section affected */
  section: string;
  /** Dot-path inside the section (empty if the whole section changed) */
  path: string;
  /** Previous value */
  oldValue: unknown;
  /** New value */
  newValue: unknown;
  /** Change source */
  source: string;
  /** Change timestamp */
  timestamp: number;
}

export type ConfigChangeHandler = (change: ConfigChange) => void | Promise<void>;

export interface ConfigManagerStats {
  filePath: string | null;
  watching: boolean;
  totalChanges: number;
  lastChangeAt: Date | null;
}

export class ConfigManager {
  private config: AppConfig;
  private emitter = new EventEmitter();
  private filePath: string | null = null;
  private watcher: ConfigWatcher | null = null;
  private pending: Promise<void> = Promise.resolve();
  private changeCount = 0;
  private lastChangeAt: Date | null = null;
  private history: ConfigChange[] = [];
  private maxHistory = 100;

  constructor(initial?: DeepPartial<AppConfig>) {
    this.config = this.deepMerge(
      defaultConfig as unknown as Record<string, unknown>,
      (initial || {}) as Record<string, unknown>
    ) as unknown as AppConfig;
  }

  get<K extends keyof AppConfig>(section: K): AppConfig[K] {
    return this.config[section];
  }

  getAll(): AppConfig {
    return this.config;
  }

  /**
   * Update a whole section. Broadcasts granular change events for every leaf
   * that actually changed so subscribers can react precisely.
   */
  async updateSection<K extends keyof AppConfig>(
    section: K,
    partial: DeepPartial<AppConfig[K]>,
    options: { source?: string } = {}
  ): Promise<void> {
    const source = options.source ?? "api";
    await this.withLock(async () => {
      const oldSection = this.deepClone(this.config[section] as unknown as Record<string, unknown>);
      const newSection = this.deepMerge(
        this.config[section] as unknown as Record<string, unknown>,
        partial as unknown as Record<string, unknown>
      );
      (this.config as unknown as Record<string, unknown>)[section as string] = newSection;

      const changes = this.diffLeaves(oldSection, newSection, String(section), source);
      for (const change of changes) {
        this.recordAndEmit(change);
      }
      if (changes.length > 0) {
        this.emitter.emit(`change:${String(section)}`, changes);
      }
    });
  }

  /**
   * Set a single value by dot-path (e.g. "server.port").
   * Supports both top-level sections and nested fields.
   */
  async set(path: string, value: unknown, options: { source?: string } = {}): Promise<void> {
    const source = options.source ?? "api";
    await this.withLock(async () => {
      const oldValue = this.getPath(path);
      if (JSON.stringify(oldValue) === JSON.stringify(value)) return;

      this.setPath(path, value);
      const section = path.split(".")[0];
      const change: ConfigChange = {
        section,
        path,
        oldValue,
        newValue: value,
        source,
        timestamp: Date.now(),
      };
      this.recordAndEmit(change);
      this.emitter.emit(`change:${section}`, [change]);
    });
  }

  async update(partial: DeepPartial<AppConfig>, options: { source?: string } = {}): Promise<void> {
    const source = options.source ?? "api";
    await this.withLock(async () => {
      const oldConfig = this.deepClone(this.config as unknown as Record<string, unknown>);
      this.config = this.deepMerge(
        this.config as unknown as Record<string, unknown>,
        partial as unknown as Record<string, unknown>
      ) as unknown as AppConfig;

      const changes = this.diffLeaves(oldConfig, this.config as unknown as Record<string, unknown>, "", source);
      for (const change of changes) {
        this.recordAndEmit(change);
      }
      for (const section of new Set(changes.map((c) => c.section))) {
        this.emitter.emit(`change:${section}`, changes.filter((c) => c.section === section));
      }
    });
  }

  loadFromEnv(): void {
    const port = parseInt(process.env.EvoClaw_PORT || "", 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      this.config.server.port = port;
    }
    const host = process.env.EvoClaw_HOST;
    if (host && host.length > 0) {
      this.config.server.host = host;
    }
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret && jwtSecret.length >= 16) {
      this.config.auth.jwtSecret = jwtSecret;
      // 同步覆盖 gateway.jwtSecret，否则 auth 与 gateway 会使用不同密钥，
      // 导致 token 签发与校验不一致（认证失败难排查）。
      this.config.gateway.jwtSecret = jwtSecret;
    } else if (jwtSecret) {
      // 用户显式设置了 JWT_SECRET 但长度不足 16，这里会静默保留默认弱密钥，
      // 用户误以为已配置强密钥。生产环境拒绝启动，非生产环境显著告警。
      const msg = `[Config] WARNING: JWT_SECRET is set but too short (${jwtSecret.length} < 16 chars). Falling back to default secret. Use a strong random secret >= 16 chars.`;
      if (process.env.NODE_ENV === "production") {
        throw new Error(`[Config] FATAL: ${msg}`);
      }
      process.stderr.write(msg + "\n");
    }
    // 精确匹配已知弱默认值，而非子串匹配（避免误报含 "dev"/"secret" 子串的强密钥）
    const WEAK_SECRETS = ["dev-secret", "change-me", "changeme", "secret", "default", "dev", "test", "change"];
    if (WEAK_SECRETS.includes(this.config.auth.jwtSecret.toLowerCase())) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("[Config] FATAL: JWT secret uses default/weak value. Set JWT_SECRET env var with a strong random secret (>= 16 chars) before running in production.");
      }
      // dev 模式下不再 stderr 输出，避免与 apps/server/src/index.ts 中
      // securityMiddleware.validateJWTSecret 的 authoritative 检查重复告警。
      // 启动时由 server 主流程统一输出一次警告即可。
    }
    this.config.evolution.enabled = process.env.EvoClaw_EVOLUTION_ENABLED !== "false";
    if (process.env.EvoClaw_MCP_ENABLED !== undefined) {
      this.config.gateway.enableMCP = process.env.EvoClaw_MCP_ENABLED !== "false";
    }
    if (process.env.EvoClaw_REST_ENABLED !== undefined) {
      this.config.gateway.enableREST = process.env.EvoClaw_REST_ENABLED !== "false";
    }
  }

  /**
   * Persist current configuration to a JSON file atomically.
   * Sensitive keys are written as-is; callers are responsible for file permissions.
   */
  async saveToFile(filePath?: string): Promise<string> {
    const target = filePath ?? this.filePath;
    if (!target) {
      throw new Error("[Config] No file path configured for persistence");
    }
    await this.withLock(async () => {
      atomicWriteFileSync(target, JSON.stringify(this.config, null, 2));
    });
    return target;
  }

  /**
   * Load configuration from a JSON file and merge it on top of defaults.
   * The file path is remembered for subsequent saveToFile() calls.
   */
  async loadFromFile(filePath: string): Promise<void> {
    await this.withLock(async () => {
      if (!fs.existsSync(filePath)) {
        this.filePath = filePath;
        return;
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Failed to parse config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const oldConfig = this.deepClone(this.config as unknown as Record<string, unknown>);
      this.config = this.deepMerge(
        defaultConfig as unknown as Record<string, unknown>,
        parsed
      ) as unknown as AppConfig;
      this.filePath = filePath;

      const changes = this.diffLeaves(oldConfig, this.config as unknown as Record<string, unknown>, "");
      for (const change of changes) {
        this.recordAndEmit({ ...change, source: "file" });
      }
    });
  }

  /**
   * Watch the backing config file for changes and apply them automatically.
   * Uses the provided ConfigWatcher; creates one if omitted.
   */
  startWatching(filePath: string, watcher?: ConfigWatcher): void {
    this.stopWatching();
    this.filePath = filePath;
    this.watcher = watcher ?? new ConfigWatcher();

    if (!fs.existsSync(filePath)) {
      process.stderr.write(`[Config] Hot-reload target does not exist: ${filePath}\n`);
      return;
    }

    this.watcher.onConfigChange(async (newConfig) => {
      await this.applyReloadedConfig(newConfig, filePath);
    });
    this.watcher.watch(filePath);
    this.watcher.forceReload(filePath);
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.stopAll();
      this.watcher = null;
    }
  }

  /**
   * 统一关闭：停止文件监听并清理 EventEmitter 监听器。
   * 防止 FSWatcher 句柄和 EventEmitter 监听器在服务停止后泄漏。
   */
  shutdown(): void {
    this.stopWatching();
    this.emitter.removeAllListeners();
  }

  onChange(handler: ConfigChangeHandler): void {
    this.emitter.on("change", handler);
  }

  offChange(handler: ConfigChangeHandler): void {
    this.emitter.off("change", handler);
  }

  onSectionChange<K extends keyof AppConfig>(section: K, handler: ConfigChangeHandler): () => void {
    const wrapper = (changes: ConfigChange[]) => {
      for (const change of changes) {
        Promise.resolve(handler(change)).catch((err) => {
          process.stderr.write(`[Config] Section change handler error: ${err instanceof Error ? err.message : String(err)}\n`);
        });
      }
    };
    this.emitter.on(`change:${String(section)}`, wrapper);
    return () => this.emitter.off(`change:${String(section)}`, wrapper);
  }

  getStats(): ConfigManagerStats {
    return {
      filePath: this.filePath,
      watching: this.watcher !== null,
      totalChanges: this.changeCount,
      lastChangeAt: this.lastChangeAt,
    };
  }

  getHistory(): ConfigChange[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
  }

  private async applyReloadedConfig(newConfig: Record<string, unknown>, filePath: string): Promise<void> {
    await this.withLock(async () => {
      const oldConfig = this.deepClone(this.config as unknown as Record<string, unknown>);
      this.config = this.deepMerge(
        defaultConfig as unknown as Record<string, unknown>,
        newConfig
      ) as unknown as AppConfig;
      this.filePath = filePath;

      const changes = this.diffLeaves(oldConfig, this.config as unknown as Record<string, unknown>, "");
      for (const change of changes) {
        this.recordAndEmit({ ...change, source: "hot-reload" });
      }
    });
  }

  private recordAndEmit(change: ConfigChange): void {
    this.changeCount++;
    this.lastChangeAt = new Date(change.timestamp);
    this.history.push(change);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    const listeners = this.emitter.listeners("change") as ConfigChangeHandler[];
    for (const listener of listeners) {
      Promise.resolve(listener(change)).catch((err) => {
        process.stderr.write(`[Config] Change handler error: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  }

  // Bug P2-7 修复：原 withLock 基于链式 Promise 串行化，未设置超时。
  // 若某个被锁保护的异步操作长时间挂起（既不 resolve 也不 reject），
  // 后续所有排队操作将永久等待。改为对每个 fn 执行加超时。
  private static readonly LOCK_TIMEOUT_MS = 30_000; // 30 秒
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const execPromise = this.pending.then(fn);
    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`ConfigManager.withLock timed out after ${ConfigManager.LOCK_TIMEOUT_MS}ms`));
      }, ConfigManager.LOCK_TIMEOUT_MS);
      t.unref();
    });
    const result = Promise.race([execPromise, timeoutPromise]);
    // 链式锁：无论 exec 是否超时，pending 都要继续推进（避免永久阻塞后续操作）
    this.pending = execPromise.then(
      () => {},
      () => {}
    );
    return result;
  }

  private deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      // 防止原型污染：跳过危险键
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      const ov = override[key];
      const bv = base[key];
      if (ov && typeof ov === "object" && !Array.isArray(ov) && bv && typeof bv === "object" && !Array.isArray(bv)) {
        result[key] = this.deepMerge(bv as Record<string, unknown>, ov as Record<string, unknown>);
      } else if (ov !== undefined) {
        result[key] = ov;
      }
    }
    return result;
  }

  private deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }

  private diffLeaves(oldObj: Record<string, unknown>, newObj: Record<string, unknown>, prefix: string, source = "api"): ConfigChange[] {
    const changes: ConfigChange[] = [];
    const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

    for (const key of allKeys) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      const section = fullPath.split(".")[0];
      const oldVal = oldObj[key];
      const newVal = newObj[key];

      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        if (
          oldVal && typeof oldVal === "object" && !Array.isArray(oldVal) &&
          newVal && typeof newVal === "object" && !Array.isArray(newVal)
        ) {
          changes.push(...this.diffLeaves(oldVal as Record<string, unknown>, newVal as Record<string, unknown>, fullPath, source));
        } else {
          changes.push({ section, path: fullPath, oldValue: oldVal, newValue: newVal, source, timestamp: Date.now() });
        }
      }
    }

    return changes;
  }

  private getPath(path: string): unknown {
    const parts = path.split(".");
    let current: unknown = this.config as unknown as Record<string, unknown>;
    for (const part of parts) {
      if (current && typeof current === "object" && !Array.isArray(current)) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return current;
  }

  private setPath(path: string, value: unknown): void {
    if (!path) throw new Error("path cannot be empty");
    const parts = path.split(".");
    // 防止原型污染：拒绝危险键
    for (const part of parts) {
      if (part === "__proto__" || part === "constructor" || part === "prototype") {
        throw new Error(`Config path contains forbidden key: "${part}"`);
      }
    }
    let current = this.config as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      // 数组也是对象，可继续穿越（按索引/键访问），故不替换为数组为空对象
      if (!current[part] || typeof current[part] !== "object") {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
}
