/**
 * CredentialPool — 多 API 凭证池管理
 *
 * 借鉴 hermes-agent 的 credential_pool.py 设计：
 * - 4 种轮换策略（fill_first / round_robin / random / least_used）
 * - 三态管理（OK / EXHAUSTED / DEAD）
 * - 冷却 TTL（401=5min, 429=1h, default=1h）
 * - 终端认证错误永久标记
 * - 兼容旧 API：getNextKey(provider) / reportRateLimit(provider, key)
 */

/** 凭证状态 */
export type CredentialState = "ok" | "exhausted" | "dead";

/** 轮换策略 */
export type RotationStrategy = "fill_first" | "round_robin" | "random" | "least_used";

/** 终端认证错误原因（永久标记为 DEAD） */
const TERMINAL_AUTH_REASONS = new Set([
  "token_invalidated",
  "token_revoked",
  "invalid_grant",
]);

/** 冷却时间配置（毫秒） */
const COOLDOWN_MS: Record<string, number> = {
  "401": 5 * 60 * 1000,   // 5 分钟
  "429": 60 * 60 * 1000,  // 1 小时
  "default": 60 * 60 * 1000, // 1 小时
};

/** DEAD 凭证清理间隔（24 小时） */
const DEAD_CLEANUP_MS = 24 * 60 * 60 * 1000;

export interface CredentialEntry {
  id: string;
  apiKey: string;
  baseUrl?: string;
  state: CredentialState;
  /** 进入当前状态的时间戳 */
  stateSince: number;
  /** 冷却到期时间戳（exhausted 状态下有效） */
  cooldownUntil: number;
  /** 使用次数 */
  useCount: number;
  /** 错误次数 */
  errorCount: number;
  /** 标记为 DEAD 的原因 */
  deadReason?: string;
}

export interface CredentialPoolOptions {
  strategy?: RotationStrategy;
  /** 凭证列表 */
  credentials: Array<{ apiKey: string; baseUrl?: string }>;
}

/**
 * 旧版配置格式（兼容 provider 代码中的 new CredentialPool({ provider: "openai", apiKeys: [...] })）
 */
export interface CredentialPoolLegacyConfig {
  provider?: string;
  apiKeys?: string[];
  strategy?: RotationStrategy;
}

export class CredentialPool {
  private entries: CredentialEntry[] = [];
  private strategy: RotationStrategy;
  private rrIndex = 0;
  /** provider → 凭证索引（旧 API 兼容） */
  private providerMap = new Map<string, string[]>();

  constructor(opts?: CredentialPoolOptions | CredentialPoolLegacyConfig) {
    // 无参数时创建空池（后续通过 getNextKey 返回 null）
    if (!opts) {
      this.strategy = "round_robin";
      return;
    }
    // 兼容旧版配置格式
    if ("apiKeys" in opts && opts.apiKeys) {
      this.strategy = opts.strategy ?? "round_robin";
      const provider = opts.provider ?? "default";
      this.providerMap.set(provider, []);
      for (const key of opts.apiKeys) {
        const entry: CredentialEntry = {
          id: `cred-${Math.random().toString(36).slice(2, 10)}`,
          apiKey: key,
          state: "ok",
          stateSince: Date.now(),
          cooldownUntil: 0,
          useCount: 0,
          errorCount: 0,
        };
        this.entries.push(entry);
        this.providerMap.get(provider)!.push(entry.id);
      }
    } else {
      const o = opts as CredentialPoolOptions;
      this.strategy = o.strategy ?? "fill_first";
      for (const c of o.credentials) {
        this.entries.push({
          id: `cred-${Math.random().toString(36).slice(2, 10)}`,
          apiKey: c.apiKey,
          baseUrl: c.baseUrl,
          state: "ok",
          stateSince: Date.now(),
          cooldownUntil: 0,
          useCount: 0,
          errorCount: 0,
        });
      }
    }
  }

  /**
   * 获取一个可用凭证。返回 null 表示所有凭证均不可用。
   */
  acquire(now = Date.now()): CredentialEntry | null {
    this.cleanDead(now);

    const available = this.entries.filter((e) => this.isUsable(e, now));
    if (available.length === 0) return null;

    let chosen: CredentialEntry;
    switch (this.strategy) {
      case "round_robin":
        chosen = available[this.rrIndex % available.length];
        this.rrIndex = (this.rrIndex + 1) % available.length;
        break;
      case "random":
        chosen = available[Math.floor(Math.random() * available.length)];
        break;
      case "least_used":
        chosen = available.reduce((a, b) => (a.useCount <= b.useCount ? a : b));
        break;
      case "fill_first":
      default:
        chosen = available[0];
        break;
    }

    chosen.useCount++;
    return chosen;
  }

  /**
   * 旧版 API：获取指定 provider 的下一个可用 API key。
   * @returns API key 字符串，或 null 表示无可用 key
   */
  getNextKey(provider: string): string | null {
    // 先尝试从 providerMap 查找
    const ids = this.providerMap.get(provider);
    if (ids && ids.length > 0) {
      const now = Date.now();
      for (const id of ids) {
        const entry = this.entries.find((e) => e.id === id);
        if (entry && this.isUsable(entry, now)) {
          entry.useCount++;
          return entry.apiKey;
        }
      }
      // 所有 key 都不可用，尝试 round-robin 重试
      const rrEntry = this.entries.find((e) => ids.includes(e.id));
      if (rrEntry && this.isUsable(rrEntry, now)) {
        return rrEntry.apiKey;
      }
      return null;
    }

    // 如果没有 provider 映射，使用全局 acquire
    const entry = this.acquire();
    return entry ? entry.apiKey : null;
  }

  /**
   * 旧版 API：报告指定 provider 的某个 key 遇到速率限制。
   */
  reportRateLimit(provider: string, key: string): void {
    const entry = this.entries.find((e) => e.apiKey === key);
    if (entry) {
      this.reportFailure(entry.id, 429);
    }
  }

  /**
   * 报告凭证使用成功，重置错误计数。
   */
  reportSuccess(credentialId: string): void {
    const entry = this.entries.find((e) => e.id === credentialId);
    if (!entry) return;
    entry.errorCount = 0;
    if (entry.state === "exhausted") {
      entry.state = "ok";
      entry.stateSince = Date.now();
      entry.cooldownUntil = 0;
    }
  }

  /**
   * 报告凭证使用失败，根据状态码更新状态。
   */
  reportFailure(credentialId: string, statusCode: number, reason?: string): void {
    const entry = this.entries.find((e) => e.id === credentialId);
    if (!entry) return;

    entry.errorCount++;

    if (reason && TERMINAL_AUTH_REASONS.has(reason)) {
      entry.state = "dead";
      entry.stateSince = Date.now();
      entry.deadReason = reason;
      return;
    }

    const key = String(statusCode);
    const cooldown = COOLDOWN_MS[key] ?? COOLDOWN_MS["default"];
    const now = Date.now();

    if (statusCode === 401 || statusCode === 403) {
      entry.state = "exhausted";
      entry.stateSince = now;
      entry.cooldownUntil = now + cooldown;
    } else if (statusCode === 429) {
      entry.state = "exhausted";
      entry.stateSince = now;
      entry.cooldownUntil = now + cooldown;
    } else if (entry.errorCount >= 5) {
      entry.state = "exhausted";
      entry.stateSince = now;
      entry.cooldownUntil = now + cooldown;
    }
  }

  /** 获取所有凭证状态快照（不包含 apiKey） */
  getStats(): Array<Omit<CredentialEntry, "apiKey">> {
    return this.entries.map(({ apiKey: _, ...rest }) => rest);
  }

  /** 可用凭证数量 */
  availableCount(now = Date.now()): number {
    return this.entries.filter((e) => this.isUsable(e, now)).length;
  }

  /** 是否有可用凭证 */
  hasAvailable(now = Date.now()): boolean {
    return this.availableCount(now) > 0;
  }

  private isUsable(entry: CredentialEntry, now: number): boolean {
    if (entry.state === "dead") return false;
    if (entry.state === "exhausted") {
      if (now >= entry.cooldownUntil) {
        entry.state = "ok";
        entry.stateSince = now;
        entry.cooldownUntil = 0;
        return true;
      }
      return false;
    }
    return true;
  }

  private cleanDead(now: number): void {
    this.entries = this.entries.filter(
      (e) => !(e.state === "dead" && now - e.stateSince > DEAD_CLEANUP_MS)
    );
  }
}
