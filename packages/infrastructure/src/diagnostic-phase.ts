/**
 * 诊断阶段：用于追踪会话/任务/工具调用的执行阶段。
 *
 * 灵感来自 openclaw-main 的 src/logging/diagnostic-phase.ts。
 *
 * 与 trace-context.ts 中的 startSpan 不同：
 * - startSpan 关注调用链（树形）与 OTEL 兼容性
 * - DiagnosticPhaseTracker 关注同一实体的阶段序列（线性），
 *   自动结束上一个未结束的阶段，便于"会话卡在哪个阶段"的排查。
 */

/** 诊断阶段种类。 */
export type DiagnosticPhaseKind =
  | "init"           // 初始化
  | "auth"           // 认证
  | "fetch-context"  // 拉取上下文
  | "llm-call"       // LLM 调用
  | "tool-call"      // 工具调用
  | "skill-exec"     // 技能执行
  | "compact"        // 上下文压缩
  | "reply"          // 回复
  | "post-process"   // 后处理
  | "cleanup"        // 清理
  | "error"          // 错误
  | "done";          // 完成

/** 单个阶段的执行状态。 */
export type DiagnosticPhaseStatus = "running" | "succeeded" | "failed" | "cancelled";

/** 单个阶段记录。 */
export interface DiagnosticPhase {
  kind: DiagnosticPhaseKind;
  startedAt: Date;
  endedAt?: Date;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  status: DiagnosticPhaseStatus;
  error?: string;
}

/**
 * 诊断阶段跟踪器：按 entityId 累积阶段序列。
 *
 * 同一 entityId 下，调用 start 时会自动将上一个未结束的 phase 标记为
 * "cancelled"（原因 "superseded by <newKind>"），保证线性语义。
 */
export class DiagnosticPhaseTracker {
  private phases = new Map<string, DiagnosticPhase[]>();

  /** 开始一个新阶段；自动取消前一个未结束的阶段。 */
  start(
    entityId: string,
    kind: DiagnosticPhaseKind,
    metadata?: Record<string, unknown>,
  ): DiagnosticPhase {
    const list = this.phases.get(entityId) ?? [];
    // 自动取消上一个未结束的阶段
    const last = list[list.length - 1];
    if (last && last.status === "running") {
      const now = new Date();
      last.endedAt = now;
      last.durationMs = now.getTime() - last.startedAt.getTime();
      last.status = "cancelled";
      last.error = `superseded by ${kind}`;
    }
    const phase: DiagnosticPhase = {
      kind,
      startedAt: new Date(),
      status: "running",
      metadata,
    };
    list.push(phase);
    this.phases.set(entityId, list);
    return phase;
  }

  /** 结束指定 kind 的最新未结束阶段。 */
  end(
    entityId: string,
    kind: DiagnosticPhaseKind,
    status: "succeeded" | "failed" | "cancelled",
    error?: string,
  ): void {
    const list = this.phases.get(entityId);
    if (!list) return;
    // 反向查找最新的匹配 kind 且未结束的 phase
    for (let i = list.length - 1; i >= 0; i--) {
      const phase = list[i];
      if (phase.kind === kind && phase.status === "running") {
        const now = new Date();
        phase.endedAt = now;
        phase.durationMs = now.getTime() - phase.startedAt.getTime();
        phase.status = status;
        if (error !== undefined) phase.error = error;
        return;
      }
    }
  }

  /** 获取该实体的当前阶段（最后一个 running 阶段；无则返回最后阶段）。 */
  getCurrentPhase(entityId: string): DiagnosticPhase | undefined {
    const list = this.phases.get(entityId);
    if (!list || list.length === 0) return undefined;
    // 优先返回最后一个 running 阶段
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].status === "running") return list[i];
    }
    return list[list.length - 1];
  }

  /** 获取该实体的所有阶段（按时间顺序）。返回拷贝以防止外部修改。 */
  getAllPhases(entityId: string): DiagnosticPhase[] {
    const list = this.phases.get(entityId);
    return list ? list.map((p) => ({ ...p })) : [];
  }

  /** 计算总执行时长（所有已结束 phase 的 duration 之和）。 */
  getTotalDurationMs(entityId: string): number {
    const list = this.phases.get(entityId);
    if (!list) return 0;
    let total = 0;
    for (const phase of list) {
      if (typeof phase.durationMs === "number") {
        total += phase.durationMs;
      }
    }
    return total;
  }

  /** 清理指定实体的所有阶段。 */
  clear(entityId: string): void {
    this.phases.delete(entityId);
  }

  /** 清理所有阶段（防止内存泄漏）。 */
  clearAll(): void {
    this.phases.clear();
  }

  /** 获取当前跟踪中的所有实体 ID（用于稳定性监控等）。 */
  getTrackedEntities(): string[] {
    return Array.from(this.phases.keys());
  }
}
