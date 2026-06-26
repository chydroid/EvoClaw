// ── First Event Tracer ──
// OpenClaw 6.6 引入: 首事件追踪 + 慢响应诊断
// 测量从请求到首个token/event的延迟, 帮助定位慢响应

/** 追踪状态 */
export type TraceStage =
  | "queued"
  | "model_dispatch"
  | "model_first_token"
  | "first_event"
  | "completed"
  | "error";

/** 追踪记录 */
export interface FirstEventTrace {
  id: string;
  sessionId: string;
  userId?: string;
  model?: string;
  channel?: string;
  /** 请求内容长度 */
  promptLength: number;
  /** 各阶段时间戳 (ms) */
  queuedAt: number;
  dispatchedAt?: number;
  firstTokenAt?: number;
  firstEventAt?: number;
  completedAt?: number;
  /** 各阶段延迟 (ms) */
  queueLatencyMs?: number;
  dispatchLatencyMs?: number;
  /** 关键指标: model首token延迟 */
  ttftMs?: number;
  /** 关键指标: 首event延迟 */
  ttfeMs?: number;
  /** 关键指标: 总响应延迟 */
  totalLatencyMs?: number;
  /** 首token到首event的间隔 */
  firstEventLatencyMs?: number;
  /** Tokens per second (估算) */
  tps?: number;
  /** 输出tokens (估算) */
  outputTokens?: number;
  /** 状态 */
  stage: TraceStage;
  /** 错误信息 */
  error?: string;
  /** 是否已分类慢响应 (防止 firstEvent + complete 重复计数) */
  slowClassified?: boolean;
}

/** 慢响应阈值配置 */
export interface FirstEventTracerConfig {
  /** 慢响应阈值(ms) - 默认3000 */
  slowThresholdMs?: number;
  /** 极慢响应阈值(ms) - 默认10000 */
  verySlowThresholdMs?: number;
  /** 保留最近多少条 */
  retainCount?: number;
  /** 慢响应回调 */
  onSlow?: (trace: FirstEventTrace, level: "slow" | "very_slow") => void;
}

/**
 * FirstEventTracer
 * 追踪每个请求的TTFT(首token时间)和TTFE(首event时间)
 * 自动检测慢响应并触发回调
 */
export class FirstEventTracer {
  private config: Required<FirstEventTracerConfig>;
  private traces = new Map<string, FirstEventTrace>();
  private traceOrder: string[] = [];
  private stats = {
    total: 0,
    completed: 0,
    slow: 0,
    verySlow: 0,
    errored: 0,
    avgTtftMs: 0,
    avgTtfeMs: 0,
    avgTotalMs: 0,
    maxTtftMs: 0,
    maxTtfeMs: 0,
  };
  private ttftSum = 0;
  private ttftCount = 0;
  private ttfeSum = 0;
  private ttfeCount = 0;
  private totalSum = 0;

  constructor(config: Partial<FirstEventTracerConfig> = {}) {
    this.config = {
      slowThresholdMs: config.slowThresholdMs ?? 3000,
      verySlowThresholdMs: config.verySlowThresholdMs ?? 10000,
      retainCount: config.retainCount ?? 1000,
      onSlow: config.onSlow ?? (() => {}),
    };
  }

  /** 记录请求入队 */
  enqueue(id: string, info: { sessionId: string; model?: string; channel?: string; userId?: string; promptLength: number }): void {
    const trace: FirstEventTrace = {
      id,
      sessionId: info.sessionId,
      userId: info.userId,
      model: info.model,
      channel: info.channel,
      promptLength: info.promptLength,
      queuedAt: Date.now(),
      stage: "queued",
    };
    this.traces.set(id, trace);
    this.traceOrder.push(id);
    this.stats.total++;
    this.evictOld();
  }

  /** 记录派发到模型 */
  dispatched(id: string): void {
    const trace = this.traces.get(id);
    if (!trace) return;
    const now = Date.now();
    trace.dispatchedAt = now;
    trace.dispatchLatencyMs = now - trace.queuedAt;
    trace.queueLatencyMs = trace.dispatchLatencyMs;
    trace.stage = "model_dispatch";
  }

  /** 记录首token到达 */
  firstToken(id: string): void {
    const trace = this.traces.get(id);
    if (!trace) return;
    const now = Date.now();
    trace.firstTokenAt = now;
    if (trace.dispatchedAt) {
      trace.ttftMs = now - trace.dispatchedAt;
      this.ttftSum += trace.ttftMs;
      this.ttftCount++;
      this.stats.avgTtftMs = this.ttftSum / this.ttftCount;
      if (trace.ttftMs > this.stats.maxTtftMs) this.stats.maxTtftMs = trace.ttftMs;
    }
    trace.stage = "model_first_token";
  }

  /** 记录首event到达 (流式响应中第一个非token事件) */
  firstEvent(id: string, eventType?: string): void {
    const trace = this.traces.get(id);
    if (!trace) return;
    const now = Date.now();
    if (!trace.firstEventAt) {
      trace.firstEventAt = now;
      trace.ttfeMs = now - trace.queuedAt;
      this.ttfeSum += trace.ttfeMs;
      this.ttfeCount++;
      this.stats.avgTtfeMs = this.ttfeSum / this.ttfeCount;
      if (trace.ttfeMs > this.stats.maxTtfeMs) this.stats.maxTtfeMs = trace.ttfeMs;
    }
    if (trace.firstTokenAt) {
      trace.firstEventLatencyMs = now - trace.firstTokenAt;
    }
    trace.stage = "first_event";
    this.checkSlow(trace);
  }

  /** 记录完成 */
  complete(id: string, outputTokens?: number): void {
    const trace = this.traces.get(id);
    if (!trace) return;
    const now = Date.now();
    trace.completedAt = now;
    trace.totalLatencyMs = now - trace.queuedAt;
    trace.stage = "completed";
    if (outputTokens !== undefined && trace.firstTokenAt) {
      trace.outputTokens = outputTokens;
      const streamDuration = (now - trace.firstTokenAt) / 1000;
      if (streamDuration > 0) {
        trace.tps = outputTokens / streamDuration;
      }
    }
    this.totalSum += trace.totalLatencyMs;
    this.stats.completed++;
    this.stats.avgTotalMs = this.totalSum / this.stats.completed;
    this.checkSlow(trace);
  }

  /** 记录错误 */
  error(id: string, err: string): void {
    const trace = this.traces.get(id);
    if (!trace) return;
    const now = Date.now();
    trace.completedAt = now;
    trace.totalLatencyMs = now - trace.queuedAt;
    trace.error = err;
    trace.stage = "error";
    this.stats.errored++;
  }

  /** 获取trace */
  get(id: string): FirstEventTrace | undefined {
    return this.traces.get(id);
  }

  /** 获取最近的traces */
  getRecent(limit = 50): FirstEventTrace[] {
    const ids = this.traceOrder.slice(-limit);
    return ids.map((id) => this.traces.get(id)).filter((t): t is FirstEventTrace => t !== undefined);
  }

  /** 获取慢响应 */
  getSlow(limit = 20): FirstEventTrace[] {
    return this.getRecent(500)
      .filter((t) => (t.ttfeMs ?? 0) >= this.config.slowThresholdMs)
      .sort((a, b) => (b.ttfeMs ?? 0) - (a.ttfeMs ?? 0))
      .slice(0, limit);
  }

  /** 获取统计 */
  getStats() {
    return {
      ...this.stats,
      activeCount: this.traceOrder.length,
      slowRate: this.stats.total > 0 ? this.stats.slow / this.stats.total : 0,
      verySlowRate: this.stats.total > 0 ? this.stats.verySlow / this.stats.total : 0,
    };
  }

  /** 清理旧数据 */
  clear(): void {
    this.traces.clear();
    this.traceOrder = [];
  }

  private checkSlow(trace: FirstEventTrace): void {
    if (trace.slowClassified) return;
    const ttfe = trace.ttfeMs ?? trace.totalLatencyMs ?? 0;
    if (ttfe >= this.config.verySlowThresholdMs) {
      this.stats.verySlow++;
      trace.slowClassified = true;
      this.config.onSlow(trace, "very_slow");
    } else if (ttfe >= this.config.slowThresholdMs) {
      this.stats.slow++;
      trace.slowClassified = true;
      this.config.onSlow(trace, "slow");
    }
  }

  private evictOld(): void {
    while (this.traceOrder.length > this.config.retainCount) {
      const old = this.traceOrder.shift();
      if (old) this.traces.delete(old);
    }
  }
}
