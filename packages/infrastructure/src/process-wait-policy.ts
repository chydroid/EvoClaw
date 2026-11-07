/**
 * process wait policy — 静默等待策略（对齐 Hermes process_registry_wait_policy.py）。
 *
 * Hermes 语义（process_registry_wait_policy.py:150 + call site process_registry.py:2754）：
 *   - "静默"定义：wait/poll 观察到"仍在运行"时，会话累计输出字符数（total_output_chars，
 *     从 spawn=0 起单调递增的计数器）与上次观察**相同** → 记一次静默轮次。
 *   - 连续静默 2 次（_PROMOTE_AFTER）后提升：notify_on_complete 被置位（完成通知接管），
 *     并写 stop note 告知模型不要再紧紧轮询（Hermes _STOP_NOTE）。
 *   - 计数器在任何退出、非 wait/poll 动作、或 wait 引导后忘记（forget）。
 *   - fail-closed：completion 无法路由到调用方时不提升——EvoClaw 的对应条件是
 *     "没有任何调用方观察过该会话"（见 ProcessRegistry.observeAction 的 gate）。
 *   - 节奏：阻塞等待按 Hermes 的 1s 事件门控轮询节奏（completion_event.wait(timeout≤1.0s)），
 *     而非 0.poll 空转——见 ProcessRegistry.wait。
 *
 * 本模块为纯逻辑（计数与晋升判定），可在不接触任何进程的情况下单测。
 */

/** 连续静默观察多少次后触发晋升（对齐 Hermes _PROMOTE_AFTER = 2） */
export const PROMOTE_AFTER = 2;

interface SilenceState {
  totalOutputChars: number;
  consecutiveSilent: number;
  promoted: boolean;
  /** 观察方是否出现过一次（pollObserved 型）——晋升 fail-closed 路由位 */
  observed: boolean;
}

/**
 * 单次观察 → 晋升判定。
 * action: "wait"（调用方阻塞等待超时）| "poll"（周期快照，仍在运行）|
 *         "exited"（已退出——触发 forget）| "output"（有新输出——重置静默计数）。
 */
export interface WaitPolicyObserveResult {
  consecutiveSilent: number;
  promoted: boolean;
}

export class WaitPolicyTracker {
  private state = new Map<string, SilenceState>();

  /** 进程有新输出 → 字符计数推进，静默计数重置。
   * 注意：promoted 保持（Hermes 语义——晋升一次，会话余下生命周期内保持接管，直到退出 forget）。 */
  onOutput(sessionId: string, totalOutputChars: number): void {
    const cur = this.state.get(sessionId);
    this.state.set(sessionId, {
      totalOutputChars,
      consecutiveSilent: 0,
      promoted: cur?.promoted ?? false,
      observed: cur?.observed ?? false,
    });
  }

  /** 观察者（等待方）出现过一次（对应 Hermes "caller 存在"的路由位） */
  sawObserver(sessionId: string): void {
    const s = this.state.get(sessionId);
    if (s) s.observed = true;
    else this.state.set(sessionId, { totalOutputChars: 0, consecutiveSilent: 0, promoted: false, observed: true });
  }

  /**
   * 一次 wait/poll 观察。
   * - action=wait/poll + 仍在运行 + 输出字符数未推进 + 已存在观察方 → 静默计数 +1
   * - 达到 PROMOTE_AFTER → promoted=true（调用方负责执行副作用：notifyOnComplete + stop note）
   * - 输出已推进（total > baseline）或会话已退出 → 静默计数归零
   */
  observeAction(
    sessionId: string,
    action: "wait" | "poll" | "exited" | "output",
    totalOutputChars: number,
    stillRunning: boolean,
  ): WaitPolicyObserveResult {
    if (action === "exited" || action === "output") {
      this.forget(sessionId);
      return { consecutiveSilent: 0, promoted: false };
    }
    let s = this.state.get(sessionId);
    if (!s) {
      // 基线 = spawn(0)；Hermes 的 observable 语义：首次检查静默会话也计入。
      s = { totalOutputChars, consecutiveSilent: 0, promoted: false, observed: true };
      this.state.set(sessionId, s);
    }
    // 输出推进（与上次观察不同）→ 非静默
    if (totalOutputChars !== s.totalOutputChars) {
      s.totalOutputChars = totalOutputChars;
      s.consecutiveSilent = 0;
      return { consecutiveSilent: 0, promoted: false };
    }
    if (!stillRunning) {
      // exited=false 不对——本次观察已结束。静默计数仅在 stillRunning=true 时推进
      this.forget(sessionId);
      return { consecutiveSilent: 0, promoted: false };
    }
    if (!s.observed) {
      // fail-closed 提升门控：无调用方观察过 → 不提升（Hermes _caller_receives_completion 语义）
      s.observed = true; // 本次观察即观察方
    }
    s.consecutiveSilent++;
    const promoted = !s.promoted && s.consecutiveSilent >= PROMOTE_AFTER;
    if (promoted) {
      s.promoted = true;
      // 提升后把计数留作证据（Hermes 的 forgotten-once 语义），但已晋升的会话不再重复晋升
    }
    return { consecutiveSilent: s.consecutiveSilent, promoted };
  }

  /** forget（任何非 wait/poll 动作或退出触发） */
  forget(sessionId: string): void {
    this.state.delete(sessionId);
  }

  /** 是否已被提升 */
  isPromoted(sessionId: string): boolean {
    return this.state.get(sessionId)?.promoted ?? false;
  }

  /** 当前状态（测试/诊断用） */
  snapshot(sessionId: string): SilenceState | undefined {
    return this.state.get(sessionId);
  }
}
