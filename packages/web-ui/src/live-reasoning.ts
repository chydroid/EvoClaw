/**
 * 实时推理（live reasoning）：把模型流式吐出的思考原文合并进思考轨迹。
 *
 * 真实事故（2026-10-08，小米 mimo 模型）：
 * 用户展开"执行过程"看到的只有铺天盖地的「正在生成回复...」，
 * 却看不到大模型的思考与分析过程 —— 而那正是他最想看的。
 *
 * 三个根因，本模块解决其中两个：
 *  1. 推理原文（reasoning_content / <think>）此前**从不下发** progress 事件，
 *     只静默写进内存轨迹 → 落盘了 ≠ 用户看得到。（后端已改为逐 chunk 下发）
 *  2. 推理是 2–6 字一个 chunk 下发的，若每个 chunk 各成一条轨迹，
 *     一段话会碎成几十条"这是一个""非常有趣" → 展开后根本没法读。
 *     （后端 appendReasoning 已合并；这里是前端的等价合并，防止快照与
 *     增量事件互相覆盖时出现重复条目）
 *  3. `type: "token"` / `phase: "generating"` 的 status 事件每几十毫秒一条，
 *     把"执行过程"刷满无信息量的同一句话。（见 isNoiseProgressStep）
 */

/** 与后端 ThinkingStep 对齐（前端只用到这些字段） */
export interface LiveThinkingStep {
  kind: "reasoning" | "decision" | "tool_result" | "error" | "system";
  title: string;
  detail?: string;
  round?: number;
  truncated?: boolean;
  offsetMs?: number;
  toolName?: string;
  ok?: boolean;
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).find((l) => l.trim()) || "模型推理";
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length <= 120 ? flat : `${flat.slice(0, 119)}…`;
}

/**
 * 把"本轮累积的推理全文"写进轨迹。
 *
 * - 末条是本轮 reasoning → **就地替换**（detail 增长，不新增条目）
 * - 否则 → 追加一条
 *
 * 这样展开思考面板看到的是**一整段连贯的思考**，而不是几十条碎片。
 */
export function mergeLiveReasoning(
  trace: LiveThinkingStep[] | undefined,
  text: string,
  round?: number,
): LiveThinkingStep[] {
  if (!text || !text.trim()) return trace ?? [];
  const base = (trace ?? []).slice();
  const last = base[base.length - 1];
  const sameRound =
    round === undefined || last?.round === undefined || last.round === round;

  if (last && last.kind === "reasoning" && !last.truncated && sameRound) {
    base[base.length - 1] = { ...last, detail: text, title: firstLine(text), round: last.round ?? round };
    return base;
  }
  base.push({ kind: "reasoning", title: firstLine(text), detail: text, round });
  return base;
}

/**
 * 判断某个 progress 事件是否属于"刷屏噪声"。
 *
 * 实测：`token` 事件每个正文片段一条、`status`+`generating` 每 50ms 一条，
 * detail 恒为「正在生成回复...」。它们对"执行过程"没有任何信息量，
 * 却能把真正有用的工具调用记录彻底淹没（用户原话：大量的"正在生成回复..."）。
 *
 * 注意：正文本身已经在气泡里逐字渲染了，这里再记一份纯属重复。
 */
export function isNoiseProgressStep(ev: {
  type?: string;
  phase?: string;
  detail?: string;
}): boolean {
  if (ev.type === "token") return true;
  if (ev.type === "status" && ev.phase === "generating") return true;
  // 保底：detail 就是那句占位文案的一律视为噪声
  if (ev.detail && /^正在生成回复/.test(ev.detail)) return true;
  return false;
}

/**
 * 折叠态摘要：**优先取模型推理原文**（不管它排在第几条）。
 *
 * 旧实现只看 `steps[0]`，而推理往往不在首位（前面有 system/decision），
 * 于是折叠后显示"决定调用 shell_exec"这种动作描述 —— 用户想看的
 * "模型怎么想"反而要展开才看得到。
 */
export function pickThinkingSummary(
  steps: LiveThinkingStep[] | undefined,
  maxChars = 30,
): string {
  if (!steps || steps.length === 0) return "";
  const r = steps.find((s) => s.kind === "reasoning" && s.detail);
  const base = (r?.detail || steps[0]?.title || "").replace(/\s+/g, " ").trim();
  return base.length <= maxChars ? base : `${base.slice(0, maxChars)}…`;
}

/** 取尾部片段（用于"正在思考"实时预览，避免长文本撑爆布局） */
export function tailText(text: string, maxChars = 220): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `…${text.slice(text.length - maxChars)}`;
}
