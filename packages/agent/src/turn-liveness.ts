// EvoClaw Turn 存活看门狗（借鉴 hermes-agent turn_liveness.py）
//
// hermes 的 TurnLivenessWatchdog 防的是：一个 turn 在飞行中**无声卡死**
//（无错误、lease 仍在续期），导致会话永不释放。#95548、#95663、#131740。
//
// 核心语义：
//   - 绑定到 (generation, activity_ts)：提交 abort 前会在同一把锁下重新校验，
//     **已恢复的 turn 绝不会被硬取消**
//   - AwakeIdleMeter：睡眠中的主机不算停滞（睡着的时间不计入上限）
//   - 看门狗触发时导出 turn 线程栈
//   - 提交前 vs 提交后 UI 表面分离：被否决的 abort 永远不会报告已提交的结果
//
// EvoClaw 差异：Node.js 是单线程事件循环，没有 hermes 那样的独立 daemon thread
// 看门狗——setTimeout 本身受 loop 计时约束。这里提供语义等价的实现：
//   - 用 generation 重新校验（对齐 hermes「已恢复的 turn 不会被硬取消」）
//   - 触发时只**报告**（onProgress + 可选 durable pause），不硬取消
//   - host 不睡眠（Node 服务器），所以无 AwakeIdleMeter 需求

/** 默认 turn 存活超时（hermes DEFAULT_TURN_LIVENESS_TIMEOUT_S=600.0）。 */
export const DEFAULT_TURN_LIVENESS_TIMEOUT_MS = 600_000;

/** 默认轮询间隔（hermes DEFAULT_TURN_LIVENESS_POLL_S=15.0）。 */
export const DEFAULT_TURN_LIVENESS_POLL_MS = 15_000;

/** 最小轮询间隔（hermes MIN_TURN_LIVENESS_POLL_S=0.01）。 */
const MIN_TURN_LIVENESS_POLL_MS = 10;

export interface TurnLivenessConfig {
  /** 无活动多久判为停滞（ms） */
  timeoutMs?: number;
  /** 轮询间隔（ms） */
  pollMs?: number;
  /** 是否启用 */
  enabled?: boolean;
}

export interface TurnLivenessEvent {
  sessionId: string;
  /** 已等待的毫秒 */
  waitedMs: number;
  /** 最后一次活动的时间戳 */
  lastActivityAt: number;
}

/**
 * Turn 存活看门狗。
 *
 * 用法：
 *   const dog = getTurnLivenessWatchdog();
 *   dog.start(sessionId, (e) => onProgress?.({ type: "status", ... "任务仍在进行中" }));
 *   dog.touch(sessionId); // 每次有进展时调用
 *   dog.stop(sessionId);   // turn 结束时调用
 */
export class TurnLivenessWatchdog {
  private readonly timeouts = new Map<string, NodeJS.Timeout>();
  private readonly activityTs = new Map<string, number>();
  private readonly generation = new Map<string, number>();
  private readonly config: Required<TurnLivenessConfig>;

  constructor(config: Partial<TurnLivenessConfig> = {}) {
    this.config = {
      timeoutMs: config.timeoutMs ?? DEFAULT_TURN_LIVENESS_TIMEOUT_MS,
      pollMs: config.pollMs ?? DEFAULT_TURN_LIVENESS_POLL_MS,
      enabled: config.enabled ?? true,
    };
  }

  /** 是否启用 */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** 更新配置 */
  updateConfig(config: Partial<TurnLivenessConfig>): void {
    this.config.timeoutMs = config.timeoutMs ?? this.config.timeoutMs;
    this.config.pollMs = config.pollMs ?? this.config.pollMs;
    this.config.enabled = config.enabled ?? this.config.enabled;
  }

  /**
   * 开始监控一个 turn。
   * @param onStale 停滞时的回调（会被重复调用，直到 stop）
   */
  start(sessionId: string, onStale: (event: TurnLivenessEvent) => void): void {
    if (!this.config.enabled) return;
    this.activityTs.set(sessionId, Date.now());
    this.generation.set(sessionId, (this.generation.get(sessionId) ?? 0) + 1);
    this.schedulePoll(sessionId, onStale);
  }

  /** 记录一次活动（重置停滞计时）。 */
  touch(sessionId: string): void {
    this.activityTs.set(sessionId, Date.now());
  }

  /** 停止监控一个 turn。 */
  stop(sessionId: string): void {
    const t = this.timeouts.get(sessionId);
    if (t) clearTimeout(t);
    this.timeouts.delete(sessionId);
    this.activityTs.delete(sessionId);
    this.generation.delete(sessionId);
  }

  /** 指定 session 是否已被判为停滞（无活动超过 timeoutMs）。 */
  isStale(sessionId: string): boolean {
    const lastActivity = this.activityTs.get(sessionId);
    if (!lastActivity) return false;
    return Date.now() - lastActivity >= this.config.timeoutMs;
  }

  /** 清空全部状态。 */
  clearAll(): void {
    for (const t of this.timeouts.values()) clearTimeout(t);
    this.timeouts.clear();
    this.activityTs.clear();
    this.generation.clear();
  }

  private schedulePoll(sessionId: string, onStale: (event: TurnLivenessEvent) => void): void {
    const gen = this.generation.get(sessionId) ?? 0;
    const pollMs = Math.max(MIN_TURN_LIVENESS_POLL_MS, this.config.pollMs);
    const t = setTimeout(() => {
      // ★ 重新校验 generation：若 turn 已被重启（start 过），
      // 这次 poll 是旧的，必须退出——对齐 hermes「已恢复的 turn 绝不被硬取消」。
      if (this.generation.get(sessionId) !== gen) return;
      const lastActivity = this.activityTs.get(sessionId) ?? 0;
      const waitedMs = Date.now() - lastActivity;
      if (waitedMs >= this.config.timeoutMs) {
        onStale({
          sessionId,
          waitedMs,
          lastActivityAt: lastActivity,
        });
        // 继续轮询：停滞是持续状态，每次 poll 都要重新报告，
        // 直到 stop()（turn 真正结束）或 touch()（有新进展）。
        this.schedulePoll(sessionId, onStale);
        return;
      }
      // 未停滞：继续轮询
      this.schedulePoll(sessionId, onStale);
    }, pollMs);
    t.unref?.(); // 不阻止进程退出
    this.timeouts.set(sessionId, t);
  }
}

// ── 单例 ────────────────────────────────────────────────────────────────────

let singleton: TurnLivenessWatchdog | null = null;

export function getTurnLivenessWatchdog(config?: Partial<TurnLivenessConfig>): TurnLivenessWatchdog {
  if (!singleton) {
    singleton = new TurnLivenessWatchdog(config);
  } else if (config) {
    singleton.updateConfig(config);
  }
  return singleton;
}

export function resetTurnLivenessWatchdog(): void {
  if (singleton) {
    singleton.clearAll();
  }
  singleton = null;
}