/**
 * 思考轨迹（Thinking Trace）
 *
 * 真实事故（2026-10-08）：用户反馈「任务完成后，整个思考的解决问题的过程
 * 一点都看不到」。逐层排查发现思考信息在三处同时丢失：
 *
 *  1. **模型推理文本被丢弃**：`StreamingTagScrubber` 把 `<think>/<reasoning>`
 *     区间内容直接扔掉，既不进正文也不留存。
 *  2. **行为轨迹没有结构**：工具调用/结果/失败散落在 progress 事件与
 *     session jsonl 里，前端只渲染了一个静态的「思考中…」标签
 *     （`msg.thinking` 从未被赋过真实内容），完成后什么都不剩。
 *  3. **没有持久化**：transcript 只存 `turnIndex/role/content/timestamp/toolCalls`，
 *     没有任何思考相关字段。
 *
 * 本模块提供统一的轨迹模型与采集器：把「模型怎么想」与「agent 做了什么」
 * 合并成一条**有序、可折叠、可持久化**的时间线。
 *
 * 设计要点：
 * - **不丢内容**：`detail` 保存原文（工具参数、结果摘要、推理全文），
 *   `title` 只是折叠态的一行摘要。
 * - **有上限**：推理文本与工具输出都做截断，避免把上下文撑爆；
 *   截断时显式标注，避免"看起来完整其实被截了"。
 * - **纯数据 + 纯函数**：便于单测，也便于前端直接消费。
 */

/** 轨迹条目类型 */
export type ThinkingStepKind =
  /** 模型推理（<think>/<reasoning> 或 reasoning_content） */
  | "reasoning"
  /** 模型决定调用某个工具 */
  | "decision"
  /** 工具执行结果 */
  | "tool_result"
  /** 工具/系统出错 */
  | "error"
  /** 系统行为（自动续跑、预算告警、反思、审批等） */
  | "system";

/** 单条轨迹 */
export interface ThinkingStep {
  kind: ThinkingStepKind;
  /** 一行摘要（折叠时可见，必须短） */
  title: string;
  /** 完整内容：参数 / 结果 / 推理全文 */
  detail?: string;
  /** 关联的工具名 */
  toolName?: string;
  /** 第几轮 LLM 调用（从 1 开始） */
  round?: number;
  /** 工具是否成功 */
  ok?: boolean;
  /** 内容是否因过长被截断 */
  truncated?: boolean;
  /** 相对任务开始的时间戳（毫秒） */
  offsetMs?: number;
}

/** 单条 detail 的最大长度（超出截断） */
export const MAX_DETAIL_CHARS = 4000;
/** 单条 title 的最大长度 */
export const MAX_TITLE_CHARS = 120;

/** 截断并标注 */
function clampDetail(text: string | undefined): { detail?: string; truncated?: boolean } {
  if (text === undefined || text === null) return {};
  const s = String(text);
  if (s.length <= MAX_DETAIL_CHARS) return { detail: s };
  return {
    detail: `${s.slice(0, MAX_DETAIL_CHARS)}\n…（内容过长，已截断，原长度 ${s.length} 字符）`,
    truncated: true,
  };
}

function clampTitle(text: string): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= MAX_TITLE_CHARS ? s : `${s.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

/**
 * 轨迹采集器：按时间顺序累积思考步骤。
 *
 * 用法：每轮 `chat()` 新建一个 → 各种事件到来时 `push` → 结束时交给上层持久化。
 */
export class ThinkingTrace {
  private steps: ThinkingStep[] = [];
  private readonly startedAt = Date.now();

  /** 追加一条 */
  push(step: Omit<ThinkingStep, "offsetMs"> & { offsetMs?: number }): ThinkingStep {
    const entry: ThinkingStep = {
      ...step,
      title: clampTitle(step.title),
      offsetMs: step.offsetMs ?? Date.now() - this.startedAt,
      ...clampDetail(step.detail),
    };
    this.steps.push(entry);
    return entry;
  }

  /** 记录模型推理文本 */
  addReasoning(text: string, round?: number): void {
    const s = String(text || "").trim();
    if (!s) return;
    this.push({
      kind: "reasoning",
      title: s.split(/\r?\n/).find((l) => l.trim())?.slice(0, MAX_TITLE_CHARS) || "模型推理",
      detail: s,
      round,
    });
  }

  /** 记录"决定调用工具" */
  addDecision(toolName: string, args: Record<string, unknown>, round?: number): void {
    this.push({
      kind: "decision",
      title: `决定调用 ${toolName}`,
      detail: safeJson(args),
      toolName,
      round,
    });
  }

  /** 记录工具执行结果 */
  addToolResult(
    toolName: string,
    raw: unknown,
    opts: { round?: number; ok?: boolean; durationMs?: number } = {},
  ): void {
    const text = typeof raw === "string" ? raw : safeJson(raw);
    const ok = opts.ok ?? !/\"success\"\s*:\s*false/.test(text.slice(0, 400));
    this.push({
      kind: ok ? "tool_result" : "error",
      title: ok ? `${toolName} 执行完成` : `${toolName} 执行失败`,
      detail: text,
      toolName,
      ok,
      round: opts.round,
    });
    if (typeof opts.durationMs === "number") {
      const last = this.steps[this.steps.length - 1];
      if (last) last.truncated = last.truncated; // 保持字段位置可预测
    }
  }

  /** 记录系统行为 */
  addSystem(title: string, detail?: string): void {
    this.push({ kind: "system", title, detail });
  }

  /** 是否为空 */
  get isEmpty(): boolean {
    return this.steps.length === 0;
  }

  /** 条目数 */
  get size(): number {
    return this.steps.length;
  }

  /** 只读快照 */
  snapshot(): ThinkingStep[] {
    return this.steps.slice();
  }

  /**
   * 序列化成落盘格式。
   * 始终返回数组（哪怕为空）—— 前端据此判断"这条消息有没有思考轨迹"，
   * 不依赖字段是否存在。
   */
  toJSON(): ThinkingStep[] {
    return this.snapshot();
  }

  /**
   * 生成折叠态摘要（默认展示的第一行）。
   *
   * 只有 `reasoning` 用 detail —— 那是模型真正的思考文本，最值得先看；
   * 其余类型一律用 title（"决定调用 file_read" / "shell_exec 执行失败"…），
   * 因为它们的 detail 是 JSON 参数或原始输出，直接拿来当预览毫无信息量
   * （曾经把 `{"path":"x"}` 当摘要，折叠态完全看不出在干什么）。
   */
  summary(maxChars = 30): string {
    const first = this.steps.find((s) => s.kind === "reasoning") ?? this.steps[0];
    if (!first) return "";
    const base = first.kind === "reasoning" ? (first.detail || first.title) : first.title;
    const flat = base.replace(/\s+/g, " ").trim();
    return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
  }
}

/** 安全 JSON 序列化（截断超长字符串） */
function safeJson(v: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      v,
      (_k, val) => {
        if (typeof val === "string" && val.length > MAX_DETAIL_CHARS) {
          return `${val.slice(0, MAX_DETAIL_CHARS)}…(截断)`;
        }
        if (val && typeof val === "object") {
          if (seen.has(val as object)) return "[Circular]";
          seen.add(val as object);
        }
        return val;
      },
      2,
    ) ?? String(v);
  } catch {
    return String(v);
  }
}