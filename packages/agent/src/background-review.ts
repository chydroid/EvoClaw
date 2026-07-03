/**
 * Background-review — turn 后自我反思 fork（fire-and-forget）。
 *
 * 对标 Hermes `agent/background_review.py`：
 *   每轮对话后启动一个后台子 Agent，重放对话快照并问自己
 *   "是否应保存/更新 skill 或 memory"。写入直接落到 memory + skill 存储。
 *   主对话与 prompt cache 完全不受影响。
 *
 * fork 继承父级 provider/model/credentials（命中同一 prefix cache，便宜）；
 * 工具白名单限定为 memory + skill 管理工具；其他工具运行时拒绝。
 *
 * 同模型走全量重放（warm cache）；不同模型走 compact digest（cold write 优化）。
 *
 * 注意：项目硬约束"自动技能创建（evoclaw-curator）必须永久禁用"。
 *   这个 fork 不是 curator —— 它是 agent 视角的即时反思，由 agent 自主判断
 *   是否写入，不依赖外部 cron，也不是无条件的"创建技能"。
 */

/**
 * Memory review prompt — 聚焦用户画像与偏好。
 */
export const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?

If something stands out, save it using the memory tool.
If nothing is worth saving, just say 'Nothing to save.' and stop.`;

/**
 * Skill review prompt — 聚焦工作流/技术/模式。
 */
export const SKILL_REVIEW_PROMPT = `Review the conversation above and update the skill library. Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.

Target shape of the library: CLASS-LEVEL skills, each with a rich SKILL.md and a references/ directory for session-specific detail. Not a long flat list of narrow one-session-one-skill entries. This shapes HOW you update, not WHETHER you update.

Signals to look for (any one of these warrants action):
  - User corrected your style, tone, format, legibility, or verbosity. Frustration signals like 'stop doing X', 'this is too verbose', 'don't format like this', 'why are you explaining', 'just give me the answer', 'you always do Y and I hate it', or an explicit 'remember this' are FIRST-CLASS skill signals, not just memory signals. Update the relevant skill(s) to embed the preference so the next session starts already knowing.
  - User corrected your workflow, approach, or sequence of steps. Encode the correction as a pitfall or explicit step in the skill that governs that class of task.
  - Non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged that a future session would benefit from. Capture it.
  - A skill that got loaded or consulted this session turned out to be wrong, missing a step, or outdated. Patch it NOW.

Do NOT capture (these become persistent self-imposed constraints that bite you later when the environment changes):
  - Environment-dependent failures: missing binaries, fresh-install errors, post-migration path mismatches, 'command not found', unconfigured credentials, uninstalled packages. The user can fix these — they are not durable rules.
  - Negative claims about tools or features ('browser tools do not work', 'X tool is broken'). These harden into refusals the agent cites against itself for months after the actual problem was fixed.
  - Session-specific transient errors that resolved before the conversation ended. If retrying worked, the lesson is the retry pattern, not the original failure.
  - One-off task narratives. A user asking 'summarize today's market' or 'analyze this PR' is not a class of work that warrants a skill.

'Nothing to save.' is a real option but should NOT be the default. If the session ran smoothly with no corrections and produced no new technique, just say 'Nothing to save.' and stop. Otherwise, act.`;

/**
 * Combined review prompt — 同时评估 memory 与 skill。
 */
export const COMBINED_REVIEW_PROMPT = `Review the conversation above and update two things:

**Memory**: who the user is. Did the user reveal persona, desires, preferences, personal details, or expectations about how you should behave? Save facts about the user and durable preferences with the memory tool.

**Skills**: how to do this class of task. Be ACTIVE — most sessions produce at least one skill update. A pass that does nothing is a missed learning opportunity, not a neutral outcome.

Target shape of the skill library: CLASS-LEVEL skills with a rich SKILL.md and a references/ directory for session-specific detail. Not a long flat list of narrow one-session-one-skill entries.

Signals that warrant a skill update (any one is enough):
  - User corrected your style, tone, format, legibility, verbosity, or approach. Frustration is a FIRST-CLASS skill signal, not just a memory signal. 'stop doing X', 'don't format like this', 'I hate when you Y' — embed the lesson in the skill that governs that task so the next session starts fixed.
  - Non-trivial technique, fix, workaround, or debugging path emerged.
  - A skill that was loaded or consulted turned out wrong, missing, or outdated — patch it now.

Do NOT capture as skills (these become persistent self-imposed constraints that bite you later when the environment changes):
  - Environment-dependent failures: missing binaries, fresh-install errors, post-migration path mismatches, 'command not found', unconfigured credentials, uninstalled packages.
  - Negative claims about tools or features ('browser tools do not work', 'X tool is broken'). These harden into refusals the agent cites against itself for months after the actual problem was fixed.
  - Session-specific transient errors that resolved before the conversation ended.
  - One-off task narratives.

Act on whichever of the two dimensions has real signal. If genuinely nothing stands out on either, say 'Nothing to save.' and stop — but don't reach for that conclusion as a default.`;

// ── 类型定义 ────────────────────────────────────────────────

/** 对话消息快照（最小契约） */
export interface ReviewMessage {
  role: "user" | "assistant" | "tool" | "system";
  content?: string | unknown;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

/** Review runtime 解析结果 */
export interface ReviewRuntime {
  provider: string | null;
  model: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  /** 是否路由到与父级不同的模型（true → digest 重放） */
  routed: boolean;
}

/** Review 配置 */
export interface BackgroundReviewConfig {
  /** 启用 review（默认 false，需显式开启） */
  enabled: boolean;
  /** 每隔多少轮触发一次（默认 10） */
  intervalTurns: number;
  /** 是否 review memory */
  reviewMemory: boolean;
  /** 是否 review skills */
  reviewSkills: boolean;
  /** 通知模式：off / on / verbose */
  notificationMode: "off" | "on" | "verbose";
  /** 路由到不同模型时的 max iterations */
  maxIterations: number;
  /** digest 重放保留的最近消息数 */
  digestTail: number;
}

export const DEFAULT_REVIEW_CONFIG: BackgroundReviewConfig = {
  enabled: false,
  intervalTurns: 10,
  reviewMemory: true,
  reviewSkills: true,
  notificationMode: "on",
  maxIterations: 16,
  digestTail: 24,
};

/** Review fork 调用方契约（由调用方注入 LLM 调用能力） */
export interface ReviewChatFn {
  (opts: {
    messages: ReviewMessage[];
    systemPrompt?: string;
    model?: string | null;
    provider?: string | null;
    toolWhitelist?: string[];
    maxIterations?: number;
  }): Promise<ReviewMessage[]>;
}

/** Review 完成后的动作摘要 */
export interface ReviewAction {
  tool: string;
  action: string;
  target: string;
  preview: string;
}

// ── digest 重放（routed 路径专用） ─────────────────────────

function msgText(m: ReviewMessage): string {
  const c = m.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((b: { text?: string }) => (typeof b?.text === "string" ? b.text : ""))
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * 紧凑重放：保留最近 `tail` 条消息，旧消息折叠成一条 synthetic user digest。
 * 仅在路由到不同模型时使用（cache 已冷，少写一些 token 是纯收益）。
 */
export function digestHistory(
  messagesSnapshot: ReviewMessage[],
  tail = DEFAULT_REVIEW_CONFIG.digestTail,
): ReviewMessage[] {
  const msgs = [...(messagesSnapshot ?? [])];
  if (msgs.length <= tail) return msgs;

  let effectiveTail = tail;
  // 保留段不能以 tool 消息开头（role 交替规则）
  while (msgs[effectiveTail * -1]?.role === "tool") {
    effectiveTail++;
    if (msgs.length <= effectiveTail) return msgs;
  }
  const keep = msgs.slice(-effectiveTail);
  const old = msgs.slice(0, -effectiveTail);

  const lines: string[] = [];
  for (const m of old) {
    const role = m.role;
    const text = msgText(m).replace(/\n/g, " ");
    if (role === "user" && text) {
      lines.push(`USER: ${text.slice(0, 300)}`);
    } else if (role === "assistant") {
      const tcs = m.tool_calls ?? [];
      if (tcs.length > 0) {
        const names = tcs
          .map((tc) => tc?.function?.name ?? "?")
          .filter(Boolean);
        lines.push(`ASSISTANT[tools: ${names.join(", ")}]`);
      }
      if (text) lines.push(`ASSISTANT: ${text.slice(0, 200)}`);
    }
  }

  const digest: ReviewMessage = {
    role: "user",
    content: `[Earlier conversation digest — older turns summarised to bound the review's cold-write cost on the routed aux model. Recent turns follow verbatim below.]\n${lines.join("\n")}`,
  };
  return [digest, ...keep];
}

// ── Review runtime 解析 ────────────────────────────────────

/**
 * 解析 review fork 的 runtime。
 *
 * 默认（auto / 未配置 / 与父级相同）：继承父级 runtime（routed=false，warm cache）。
 * 配置 auxiliary.background_review.{provider,model} 指定不同模型时，routed=true。
 */
export function resolveReviewRuntime(opts: {
  parentProvider: string | null;
  parentModel: string | null;
  parentApiKey?: string | null;
  parentBaseUrl?: string | null;
  config?: Record<string, unknown> | null;
}): ReviewRuntime {
  const parent: ReviewRuntime = {
    provider: opts.parentProvider,
    model: opts.parentModel,
    apiKey: opts.parentApiKey ?? null,
    baseUrl: opts.parentBaseUrl ?? null,
    routed: false,
  };

  const aux = (opts.config?.auxiliary as Record<string, unknown>) ?? {};
  const task = (aux.background_review as Record<string, unknown>) ?? {};
  const taskProvider = String(task.provider ?? "").trim() || null;
  const taskModel = String(task.model ?? "").trim() || null;
  const taskBaseUrl = String(task.base_url ?? "").trim() || null;
  const taskApiKey = String(task.api_key ?? "").trim() || null;

  if (!taskProvider || taskProvider === "auto" || !taskModel) return parent;
  if (taskProvider === opts.parentProvider && taskModel === opts.parentModel) {
    return parent;
  }

  return {
    provider: taskProvider,
    model: taskModel,
    apiKey: taskApiKey,
    baseUrl: taskBaseUrl,
    routed: true,
  };
}

// ── 动作摘要提取 ───────────────────────────────────────────

/** 工具白名单：只有 memory / skill_manage 的成功调用算作 review 动作 */
const NOTIFY_TOOLS = new Set(["memory", "skill_manage"]);

/**
 * 从 review agent 的会话消息中提取成功的 memory/skill 动作摘要。
 *
 * 跳过 prior_snapshot 中已存在的 tool 消息（避免把继承的历史结果当成新动作）。
 *
 * @param reviewMessages review agent 的会话消息
 * @param priorSnapshot review 启动前继承的历史消息
 * @param notificationMode off/on/verbose
 */
export function summarizeBackgroundReviewActions(
  reviewMessages: ReviewMessage[],
  priorSnapshot: ReviewMessage[] = [],
  notificationMode: BackgroundReviewConfig["notificationMode"] = "on",
): ReviewAction[] {
  if (notificationMode === "off") return [];

  // 收集 prior 中已有的 tool_call_id，避免重复呈现
  const existingToolCallIds = new Set<string>();
  const existingToolContents = new Set<string>();
  for (const prior of priorSnapshot) {
    if (prior.role !== "tool") continue;
    if (prior.tool_call_id) {
      existingToolCallIds.add(prior.tool_call_id);
    } else if (typeof prior.content === "string") {
      existingToolContents.add(prior.content);
    }
  }

  // 收集所有 review agent 的 tool_call，建立 id → 详情映射
  const callDetails = new Map<string, {
    tool: string;
    action: string;
    target: string;
    content: string;
    name: string;
    oldString: string;
    newString: string;
  }>();
  for (const msg of reviewMessages ?? []) {
    if (msg.role !== "assistant") continue;
    for (const tc of msg.tool_calls ?? []) {
      const fn = tc?.function;
      const fnName = fn?.name ?? "";
      const tcid = tc?.id;
      if (!fnName || !NOTIFY_TOOLS.has(fnName)) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(fn?.arguments ?? "{}");
      } catch {
        args = {};
      }
      if (tcid) {
        callDetails.set(tcid, {
          tool: fnName,
          action: String(args.action ?? "?"),
          target: String(args.target ?? "memory"),
          content: String(args.content ?? ""),
          name: String(args.name ?? ""),
          oldString: String(args.old_string ?? ""),
          newString: String(args.new_string ?? ""),
        });
      }
    }
  }

  // 遍历 tool 结果消息，提取成功动作
  const actions: ReviewAction[] = [];
  for (const msg of reviewMessages ?? []) {
    if (msg.role !== "tool") continue;
    const tcid = msg.tool_call_id;
    if (tcid && existingToolCallIds.has(tcid)) continue;
    if (!tcid && typeof msg.content === "string" && existingToolContents.has(msg.content)) {
      continue;
    }

    let data: { success?: boolean; message?: string; target?: string } = {};
    try {
      data = JSON.parse(typeof msg.content === "string" ? msg.content : "{}");
    } catch {
      continue;
    }
    if (!data.success) continue;

    const detail = tcid ? callDetails.get(tcid) : undefined;
    if (tcid && callDetails.size > 0 && !detail) continue;

    const isSkill = detail?.tool === "skill_manage";
    const target = data.target ?? detail?.target ?? "";
    const label = isSkill
      ? "Skill"
      : target === "memory"
        ? "Memory"
        : target === "user"
          ? "User profile"
          : target || "Memory";

    const message = data.message ?? "";
    const messageLower = message.toLowerCase();

    // 提取预览
    let preview = "";
    if (detail?.content) {
      preview = detail.content.slice(0, 120);
    } else if (detail?.newString) {
      preview = detail.newString.slice(0, 120);
    } else if (message) {
      preview = message.slice(0, 120);
    }

    if (notificationMode === "verbose") {
      const action = detail?.action ?? "";
      if (action === "add" && preview) {
        actions.push({ tool: label, action: "add", target: detail?.name ?? "", preview: `➕ ${preview}` });
      } else if (action === "replace" && preview) {
        actions.push({ tool: label, action: "replace", target: detail?.name ?? "", preview: `✏️ ${preview}` });
      } else if (action === "remove" && detail?.oldString) {
        actions.push({ tool: label, action: "remove", target: detail?.name ?? "", preview: `➖ ${detail.oldString.slice(0, 60)}` });
      } else {
        actions.push({ tool: label, action, target: detail?.name ?? "", preview: preview || `${label} updated` });
      }
    } else {
      // on 模式：只在创建/更新/打补丁时呈现
      if (
        messageLower.includes("created") ||
        messageLower.includes("updated") ||
        (isSkill && messageLower.includes("patched")) ||
        messageLower.includes("added") ||
        messageLower.includes("replaced") ||
        messageLower.includes("removed")
      ) {
        actions.push({ tool: label, action: "update", target: detail?.name ?? "", preview: preview || `${label} updated` });
      }
    }
  }

  // 去重
  const seen = new Set<string>();
  return actions.filter((a) => {
    const key = `${a.tool}|${a.action}|${a.preview}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── 核心：启动 review fork ─────────────────────────────────

/**
 * 启动 background review（fire-and-forget）。
 *
 * 调用方注入 `chatFn` 提供 LLM 调用能力（实际 fork 一个子 agent）。
 * 返回一个 Promise，但通常不 await（fire-and-forget）。
 *
 * @param opts.parentProvider 父级 provider
 * @param opts.parentModel 父级 model
 * @param opts.messagesSnapshot 对话快照
 * @param opts.chatFn LLM 调用函数
 * @param opts.config review 配置
 * @param opts.auxConfig auxiliary 配置（用于路由到不同模型）
 * @param opts.onComplete 完成回调（接收动作摘要）
 */
export async function runBackgroundReview(opts: {
  parentProvider: string | null;
  parentModel: string | null;
  parentApiKey?: string | null;
  parentBaseUrl?: string | null;
  messagesSnapshot: ReviewMessage[];
  chatFn: ReviewChatFn;
  config?: Partial<BackgroundReviewConfig>;
  auxConfig?: Record<string, unknown> | null;
  onComplete?: (actions: ReviewAction[]) => void;
  onError?: (err: unknown) => void;
}): Promise<ReviewAction[]> {
  const cfg: BackgroundReviewConfig = { ...DEFAULT_REVIEW_CONFIG, ...opts.config };
  if (!cfg.enabled) return [];

  // 选择 prompt
  let prompt: string;
  if (cfg.reviewMemory && cfg.reviewSkills) {
    prompt = COMBINED_REVIEW_PROMPT;
  } else if (cfg.reviewMemory) {
    prompt = MEMORY_REVIEW_PROMPT;
  } else {
    prompt = SKILL_REVIEW_PROMPT;
  }

  const runtime = resolveReviewRuntime({
    parentProvider: opts.parentProvider,
    parentModel: opts.parentModel,
    parentApiKey: opts.parentApiKey,
    parentBaseUrl: opts.parentBaseUrl,
    config: opts.auxConfig ? { auxiliary: opts.auxConfig } : null,
  });

  // 同模型 → 全量重放（warm cache）；不同模型 → digest（cold write 优化）
  const history = runtime.routed
    ? digestHistory(opts.messagesSnapshot, cfg.digestTail)
    : opts.messagesSnapshot;

  // 工具白名单
  const toolWhitelist = cfg.reviewMemory
    ? ["memory", "skill_manage"]
    : ["skill_manage"];

  try {
    const reviewMessages = await opts.chatFn({
      messages: history,
      systemPrompt: undefined, // 继承父级 prompt（由 chatFn 实现）
      model: runtime.model,
      provider: runtime.provider,
      toolWhitelist,
      maxIterations: cfg.maxIterations,
    });

    const actions = summarizeBackgroundReviewActions(
      reviewMessages,
      opts.messagesSnapshot,
      cfg.notificationMode,
    );

    opts.onComplete?.(actions);
    return actions;
  } catch (err) {
    opts.onError?.(err);
    return [];
  }
}

/**
 * 判断当前 turn 是否应触发 background review。
 *
 * @param turnIndex 当前 turn 序号（0-based）
 * @param config review 配置
 */
export function shouldRunBackgroundReview(
  turnIndex: number,
  config: BackgroundReviewConfig = DEFAULT_REVIEW_CONFIG,
): boolean {
  if (!config.enabled) return false;
  return turnIndex > 0 && turnIndex % config.intervalTurns === 0;
}
