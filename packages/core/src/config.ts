import { EventEmitter } from "events";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ConfigWatcher, type SchemaConfigChange } from "./config-schema.js";
import { ConfigDoctor, type DoctorReport } from "./config-doctor.js";
import { LastKnownGoodConfig } from "./config-lkg.js";
import { atomicWriteFileSync } from "./atomic-write";

/**
 * 配置加载状态（P8 降级标记）。
 *
 * 读失败 fail-open（继续用默认值/上一份）但必须「响亮」：状态可查询、
 * 健康检查可见、且禁止把默认值写回覆盖用户文件。
 */
export interface ConfigStatus {
  /** 是否成功完成过至少一次加载（或确认文件不存在、使用默认值） */
  loaded: boolean;
  /** 是否处于降级状态（读失败 / 热重载非法） */
  degraded: boolean;
  /** 降级原因（人类可读） */
  reason?: string;
  /** 配置来源文件 */
  sourcePath?: string;
  /** 文件内容签名（sha256 前 16 位），用于确认当前内存配置对应的磁盘版本 */
  fileSignature?: string;
  /** 最近一次读失败错误 */
  lastError?: string;
  /** 最近一次成功加载时间（ISO） */
  lastLoadedAt?: string;
  /** ConfigDoctor 诊断摘要 */
  doctor?: Pick<DoctorReport, "healthy" | "errorCount" | "warningCount" | "summary">;
}

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
  /** P8：降级/加载状态（只观测，不改变既有安全等级回落策略） */
  private status: ConfigStatus = { loaded: false, degraded: false };

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

  /** 当前绑定的配置文件路径（loadFromFile/saveToFile 之后才有值） */
  getFilePath(): string | undefined {
    return this.filePath ?? undefined;
  }

  /** P8：配置加载/降级状态（只读快照） */
  getStatus(): ConfigStatus {
    return { ...this.status, doctor: this.status.doctor ? { ...this.status.doctor } : undefined };
  }

  /** 标记一次成功加载，并快照 LastKnownGood + 跑 ConfigDoctor（best-effort） */
  private markLoaded(filePath: string, raw: string | null): void {
    this.status = {
      loaded: true,
      degraded: false,
      sourcePath: filePath,
      fileSignature: raw === null ? undefined : crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16),
      lastLoadedAt: new Date().toISOString(),
    };
    this.status.doctor = this.runDoctor();
    this.snapshotLastKnownGood(filePath);
  }

  /** 标记降级：fail-open（保留当前内存配置），但状态与日志必须响亮 */
  private markDegraded(reason: string, error?: string): void {
    this.status = {
      ...this.status,
      // 首次加载就失败时 status.sourcePath 还是空的，用当前绑定路径补上，
      // 否则 saveToFile 的「降级时拒绝写回」判断会漏掉同一文件。
      sourcePath: this.status.sourcePath ?? this.filePath ?? undefined,
      degraded: true,
      reason,
      lastError: error ?? this.status.lastError,
    };
    process.stderr.write(`[Config] DEGRADED: ${reason}${error ? ` (${error})` : ""}\n`);
  }

  private runDoctor(): ConfigStatus["doctor"] {
    try {
      const report = new ConfigDoctor({ configPath: this.filePath ?? undefined })
        .diagnose(this.config as unknown as Record<string, unknown>);
      return {
        healthy: report.healthy,
        errorCount: report.errorCount,
        warningCount: report.warningCount,
        summary: report.summary,
      };
    } catch {
      return undefined;
    }
  }

  private snapshotLastKnownGood(filePath: string): void {
    try {
      const lkg = new LastKnownGoodConfig({
        // 快照放在配置文件同目录，避免污染进程 cwd
        snapshotsDir: path.join(path.dirname(filePath), ".lkg-config"),
        configPath: filePath,
      });
      lkg.snapshot(this.config as unknown as Record<string, unknown>, "auto: successful load");
    } catch {
      // 快照失败不影响加载
    }
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
    // P8：读失败后拒绝写回 —— 否则会把「默认值 + 运行时值」覆盖到用户文件上，
    // 用户原本的配置将不可恢复。修复文件后由热重载清掉 degraded 再写。
    if (this.status.degraded && this.status.sourcePath === target) {
      throw new Error(
        `Refusing to overwrite config file after a load failure: ${target} ` +
        `(${this.status.reason ?? "degraded"})`,
      );
    }
    await this.withLock(async () => {
      const raw = JSON.stringify(this.config, null, 2);
      atomicWriteFileSync(target, raw);
      // 写入成功等价于一次成功加载：清降级并更新签名
      this.filePath = target;
      this.markLoaded(target, raw);
    });
    return target;
  }

  /**
   * Load configuration from a JSON file and merge it on top of defaults.
   * The file path is remembered for subsequent saveToFile() calls.
   */
  /**
   * 把**单个路径**写回配置文件，只改动该键，保留文件里其余内容。
   *
   * 为什么不用 `saveToFile()`：那会把整份 `this.config`（默认值 + 运行时值）
   * 全量写进磁盘——包括 `auth.jwtSecret` 这类本不该落盘的运行时值，
   * 还会把当前版本的全部默认值固化下来，导致后续版本升级时旧默认值反过来
   * 覆盖新默认值。用户只想改一个安全等级，不该被动接受这些副作用。
   *
   * @param filePath 配置文件路径（不存在则创建）
   * @param configPath 点分路径，如 "security.securityLevel"
   */
  async persistPath(filePath: string, configPath: string, value: unknown): Promise<void> {
    await this.withLock(async () => {
      let root: Record<string, unknown> = {};
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            root = parsed as Record<string, unknown>;
          }
        } catch (err) {
          throw new Error(
            `Failed to parse config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const segments = configPath.split(".").filter(Boolean);
      if (segments.length === 0) throw new Error("configPath must not be empty");
      let cursor = root;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        const next = cursor[seg];
        if (!next || typeof next !== "object" || Array.isArray(next)) {
          cursor[seg] = {};
        }
        cursor = cursor[seg] as Record<string, unknown>;
      }
      cursor[segments[segments.length - 1]] = value;
      atomicWriteFileSync(filePath, `${JSON.stringify(root, null, 2)}\n`);
    });
  }

  async loadFromFile(filePath: string): Promise<void> {
    await this.withLock(async () => {
      if (!fs.existsSync(filePath)) {
        this.filePath = filePath;
        // 文件不存在不是错误：使用默认值，但记录来源以便诊断
        this.markLoaded(filePath, null);
        return;
      }
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.filePath = filePath;
        this.markDegraded(`failed to read config file ${filePath}`, message);
        throw new Error(`Failed to read config file ${filePath}: ${message}`);
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.filePath = filePath;
        // fail-open：保留当前配置（默认值），置 degraded，并保持既有 throw 语义
        this.markDegraded(`failed to parse config file ${filePath}`, message);
        throw new Error(`Failed to parse config file ${filePath}: ${message}`);
      }
      const oldConfig = this.deepClone(this.config as unknown as Record<string, unknown>);
      this.config = this.deepMerge(
        defaultConfig as unknown as Record<string, unknown>,
        parsed
      ) as unknown as AppConfig;
      this.filePath = filePath;
      this.markLoaded(filePath, raw);

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

    // P8：热重载被拒（JSON 损坏 / schema 非法）时保留上一份并置 degraded
    this.watcher.onInvalid((invalidPath, errors) => {
      if (invalidPath === filePath) {
        this.markDegraded(`hot reload rejected for ${invalidPath}`, errors.join("; "));
      }
    });

    if (!fs.existsSync(filePath)) {
      this.markDegraded(`hot-reload target does not exist: ${filePath}`);
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

      // 成功热重载 → 清除降级标记并刷新状态（含签名/Doctor）
      this.status = {
        loaded: true,
        degraded: false,
        sourcePath: filePath,
        fileSignature: crypto.createHash("sha256").update(JSON.stringify(newConfig)).digest("hex").slice(0, 16),
        lastLoadedAt: new Date().toISOString(),
      };
      this.status.doctor = this.runDoctor();
      this.snapshotLastKnownGood(filePath);

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
    // 深拷贝 base：override 未覆盖的分支不能与调用方（通常是共享的 defaultConfig）
    // 共用对象引用，否则一次 set() 会静默改写 defaultConfig，污染后续所有实例。
    const result = this.deepClone(base) as Record<string, unknown>;
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
