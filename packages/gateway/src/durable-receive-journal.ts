/**
 * Durable inbound receive journal — 持久化入站接收日志。
 *
 * 对照 openclaw-main 的 src/channels/message/durable-receive.ts。
 *
 * 职责：
 *  - 跟踪 accepted/pending/completed/retryable 入站事件
 *  - 通过 pendingStore + completedStore 双队列检测重复事件
 *  - 完成事件以墓碑（tombstone）形式保留，TTL 到期自动清理
 *  - 支持 accept/pending/complete/release/deletePending 操作
 *  - 提供 InMemoryDurableReceiveJournal 内存实现（无需外部 store）
 *
 * 设计：
 *  - 渠道接收管线在收到事件后调用 accept(id, payload)
 *  - 返回 kind="accepted" 表示新事件；kind="pending"/"completed" 表示重复
 *  - 处理完成后调用 complete(id)；处理失败调用 release(id) 触发重试
 *  - pending() 返回所有待处理记录（按 receivedAt 排序）
 *  - pending TTL 到期视为僵尸事件，可被 release 重试
 */

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 待处理入站事件记录（保留至 dispatch 完成）。 */
export interface DurableInboundReceivePendingRecord<TPayload, TMetadata = unknown> {
  id: string;
  payload: TPayload;
  metadata?: TMetadata;
  receivedAt: number;
  updatedAt: number;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
}

/** 已完成入站事件墓碑（用于检测重复平台事件）。 */
export interface DurableInboundReceiveCompletedRecord<TCompletedMetadata = unknown> {
  id: string;
  completedAt: number;
  metadata?: TCompletedMetadata;
}

/** accept 结果：新事件 / 待处理重复 / 已完成重复。 */
export type DurableInboundReceiveAcceptResult<TPayload, TMetadata, TCompletedMetadata> =
  | {
      kind: "accepted";
      duplicate: false;
      record: DurableInboundReceivePendingRecord<TPayload, TMetadata>;
    }
  | {
      kind: "pending";
      duplicate: true;
      record: DurableInboundReceivePendingRecord<TPayload, TMetadata>;
    }
  | {
      kind: "completed";
      duplicate: true;
      record: DurableInboundReceiveCompletedRecord<TCompletedMetadata>;
    };

/** accept 时的可选元数据。 */
export interface DurableInboundReceiveAcceptOptions<TMetadata> {
  metadata?: TMetadata;
  receivedAt?: number;
}

/** complete 时的可选元数据。 */
export interface DurableInboundReceiveCompleteOptions<TCompletedMetadata> {
  metadata?: TCompletedMetadata;
  completedAt?: number;
}

/** release 时的可选元数据（用于触发重试）。 */
export interface DurableInboundReceiveReleaseOptions {
  lastError?: string;
  releasedAt?: number;
}

/** 持久化接收日志门面接口。 */
export interface DurableInboundReceiveJournal<TPayload, TMetadata = unknown, TCompletedMetadata = unknown> {
  accept(
    id: string,
    payload: TPayload,
    options?: DurableInboundReceiveAcceptOptions<TMetadata>,
  ): Promise<DurableInboundReceiveAcceptResult<TPayload, TMetadata, TCompletedMetadata>>;
  pending(): Promise<Array<DurableInboundReceivePendingRecord<TPayload, TMetadata>>>;
  complete(
    id: string,
    options?: DurableInboundReceiveCompleteOptions<TCompletedMetadata>,
  ): Promise<void>;
  release(id: string, options?: DurableInboundReceiveReleaseOptions): Promise<boolean>;
  deletePending(id: string): Promise<boolean>;
}

/** 持久化接收日志选项。 */
export interface DurableInboundReceiveJournalOptions<TPayload, TMetadata, TCompletedMetadata> {
  /** 待处理事件 TTL（毫秒）；到期后调用方可视为僵尸事件 */
  pendingTtlMs?: number;
  /** 已完成事件墓碑 TTL（毫秒）；到期后自动清理 */
  completedTtlMs?: number;
  /** 自定义 now 函数（测试用） */
  now?: () => number;
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 规范化事件 ID（去除首尾空白）。 */
function normalizeDurableInboundReceiveId(id: string): string {
  const normalized = id.trim();
  if (!normalized) {
    throw new Error("Durable inbound receive id cannot be empty");
  }
  return normalized;
}

/** 按 receivedAt 升序、id 字典序排序待处理记录。 */
function sortPendingRecords<TPayload, TMetadata>(
  records: Array<DurableInboundReceivePendingRecord<TPayload, TMetadata>>,
): Array<DurableInboundReceivePendingRecord<TPayload, TMetadata>> {
  return records.slice().sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id));
}

// ─── 内存实现 ─────────────────────────────────────────────────────────────────

/**
 * InMemoryDurableReceiveJournal — 基于内存 Map 的持久化接收日志实现。
 *
 * 适用于：
 *  - 单进程场景（不需要跨进程共享）
 *  - 测试与开发环境
 *  - 入站事件量较小、可接受重启丢失的场景
 *
 * 生产环境若需跨进程持久化，可参考 openclaw-main 的 store-backed 实现，
 * 接入 SQLite/Redis 等后端。
 */
export class InMemoryDurableReceiveJournal<TPayload, TMetadata = unknown, TCompletedMetadata = unknown>
  implements DurableInboundReceiveJournal<TPayload, TMetadata, TCompletedMetadata>
{
  private pendingStore = new Map<string, DurableInboundReceivePendingRecord<TPayload, TMetadata>>();
  private completedStore = new Map<string, DurableInboundReceiveCompletedRecord<TCompletedMetadata>>();
  private readonly now: () => number;
  private readonly pendingTtlMs?: number;
  private readonly completedTtlMs?: number;

  constructor(options: DurableInboundReceiveJournalOptions<TPayload, TMetadata, TCompletedMetadata> = {}) {
    this.now = options.now ?? Date.now;
    this.pendingTtlMs = options.pendingTtlMs;
    this.completedTtlMs = options.completedTtlMs;
  }

  async accept(
    id: string,
    payload: TPayload,
    acceptOptions?: DurableInboundReceiveAcceptOptions<TMetadata>,
  ): Promise<DurableInboundReceiveAcceptResult<TPayload, TMetadata, TCompletedMetadata>> {
    const key = normalizeDurableInboundReceiveId(id);
    this.pruneExpired();

    // 1. 检查墓碑（已完成事件）
    const completed = this.completedStore.get(key);
    if (completed) {
      return { kind: "completed", duplicate: true, record: completed };
    }

    const receivedAt = acceptOptions?.receivedAt ?? this.now();
    const record: DurableInboundReceivePendingRecord<TPayload, TMetadata> = {
      id: key,
      payload,
      receivedAt,
      updatedAt: receivedAt,
      attempts: 0,
    };
    if (acceptOptions?.metadata !== undefined) {
      record.metadata = acceptOptions.metadata;
    }

    // 2. 检查是否已存在 pending（重复事件）
    const existing = this.pendingStore.get(key);
    if (existing) {
      // 若旧 pending 已 TTL 过期，则视为僵尸事件，覆盖为新记录
      if (this.isPendingExpired(existing)) {
        this.pendingStore.set(key, record);
        return { kind: "accepted", duplicate: false, record };
      }
      return { kind: "pending", duplicate: true, record: existing };
    }

    // 3. 插入新 pending（处理 race：完成事件可能在两次检查之间写入）
    this.pendingStore.set(key, record);
    const completedAfterInsert = this.completedStore.get(key);
    if (completedAfterInsert) {
      this.pendingStore.delete(key);
      return { kind: "completed", duplicate: true, record: completedAfterInsert };
    }
    return { kind: "accepted", duplicate: false, record };
  }

  async pending(): Promise<Array<DurableInboundReceivePendingRecord<TPayload, TMetadata>>> {
    this.pruneExpired();
    const records: Array<DurableInboundReceivePendingRecord<TPayload, TMetadata>> = [];
    for (const [key, value] of this.pendingStore.entries()) {
      // 清理已完成但未删除的 pending
      if (this.completedStore.has(key)) {
        this.pendingStore.delete(key);
        continue;
      }
      records.push(value);
    }
    return sortPendingRecords(records);
  }

  async complete(
    id: string,
    completeOptions?: DurableInboundReceiveCompleteOptions<TCompletedMetadata>,
  ): Promise<void> {
    const key = normalizeDurableInboundReceiveId(id);
    const completedAt = completeOptions?.completedAt ?? this.now();
    const record: DurableInboundReceiveCompletedRecord<TCompletedMetadata> = {
      id: key,
      completedAt,
    };
    if (completeOptions?.metadata !== undefined) {
      record.metadata = completeOptions.metadata;
    }
    this.completedStore.set(key, record);
    this.pendingStore.delete(key);
  }

  async release(id: string, releaseOptions?: DurableInboundReceiveReleaseOptions): Promise<boolean> {
    const key = normalizeDurableInboundReceiveId(id);
    const record = this.pendingStore.get(key);
    if (!record) {
      return false;
    }
    const releasedAt = releaseOptions?.releasedAt ?? this.now();
    const updated: DurableInboundReceivePendingRecord<TPayload, TMetadata> = {
      ...record,
      updatedAt: releasedAt,
      attempts: record.attempts + 1,
      lastAttemptAt: releasedAt,
    };
    if (releaseOptions?.lastError !== undefined) {
      updated.lastError = releaseOptions.lastError;
    }
    this.pendingStore.set(key, updated);
    return true;
  }

  async deletePending(id: string): Promise<boolean> {
    const key = normalizeDurableInboundReceiveId(id);
    return this.pendingStore.delete(key);
  }

  // ─── 内部工具 ───

  /** 判断 pending 是否已 TTL 过期（视为僵尸）。 */
  private isPendingExpired(record: DurableInboundReceivePendingRecord<TPayload, TMetadata>): boolean {
    if (!this.pendingTtlMs) return false;
    return this.now() - record.updatedAt > this.pendingTtlMs;
  }

  /** 清理已过期的墓碑记录。 */
  private pruneExpired(): void {
    if (!this.completedTtlMs) return;
    const now = this.now();
    for (const [key, record] of this.completedStore.entries()) {
      if (now - record.completedAt > this.completedTtlMs) {
        this.completedStore.delete(key);
      }
    }
  }

  /** 获取 pending 记录数（诊断用）。 */
  getPendingCount(): number {
    return this.pendingStore.size;
  }

  /** 获取 completed 墓碑数（诊断用）。 */
  getCompletedCount(): number {
    return this.completedStore.size;
  }

  /** 清空所有状态（测试用）。 */
  clear(): void {
    this.pendingStore.clear();
    this.completedStore.clear();
  }
}

// ─── 工厂函数（对齐 openclaw-main API） ───────────────────────────────────────

/** 创建基于内存的持久化接收日志。 */
export function createInMemoryDurableReceiveJournal<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(
  options?: DurableInboundReceiveJournalOptions<TPayload, TMetadata, TCompletedMetadata>,
): DurableInboundReceiveJournal<TPayload, TMetadata, TCompletedMetadata> {
  return new InMemoryDurableReceiveJournal<TPayload, TMetadata, TCompletedMetadata>(options);
}
