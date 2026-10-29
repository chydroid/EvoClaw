/**
 * 完成声明真实性校验（Completion Truthfulness Reconciliation）
 *
 * 背景：agent 曾出现「声称『✅ 添加邮箱完成』但实际从未调用 email」
 * 的伪造完成态。根因是系统提示词缺少真实性约束，且最终回复返回前
 * 没有任何机制把「模型的完成声明」与「实际发生的工具执行 / 未决权限」对账。
 *
 * 本模块提供纯函数式的对账能力，在 llm-caller 返回 finalReply 之前调用：
 *   - 模型声称完成，但操作仍处于 pending（等待人工审批） → 追加更正说明
 *   - 模型声称完成，但本回合完全没有执行任何工具      → 追加更正说明
 *   - 模型声称完成，但本回合有工具执行失败            → 追加更正说明
 *   - 模型声称完成，但本回合没有任何写文件类工具      → 追加更正说明
 *   - 模型声称完成，但声称执行的验证命令无执行记录    → 追加更正说明（v4 Task 8）
 *
 * 设计取舍：采用「确定性追加更正」而非「让模型重新生成一轮」。
 * 理由是重新生成会引入额外延迟与再次卡死的风险（与本项目此前的
 * 超时/续跑改造目标冲突），而确定性追加能 100% 保证用户不会看到
 * 未被更正的虚假成功。
 */

/** 未决权限的最小结构（与 llm-caller 中 pendingPermissions 元素一致） */
export interface PendingPermission {
  id: string;
  operation: string;
  description: string;
  target: string;
}

/** 本回合执行过但**返回失败**的工具（用于识别「执行了却失败仍声称完成」） */
export interface FailedTool {
  /** 工具名 */
  name: string;
  /** 从工具返回值中提取出的错误摘要 */
  error: string;
}

/**
 * 本回合执行过、但返回**空/零结果**的工具。
 *
 * 真实事故：email 返回 `{totalEmails: 0, categories: {}, topSenders: []}`，
 * 模型却输出了一份「共 30+ 封邮件、GitHub 通知 4 封 / 安全 5 封 / 账单 1 封…」
 * 精确到个位数的数据报告——全部是凭空编造。
 */
export interface EmptyResultTool {
  /** 工具名 */
  name: string;
  /** 判定的空结果字段（如 totalEmails=0），用于生成可读更正文本 */
  field: string;
}

export interface ReconcileInput {
  /** 模型生成的最终回复 */
  finalReply: string;
  /** 本回合仍未获批、需要用户审批的操作 */
  pendingPermissions?: PendingPermission[];
  /** 本回合是否真正执行过任何工具 */
  toolsExecuted?: boolean;
  /** 用户本轮的原始请求，用于判断是否包含"执行类"意图 */
  lastUserMessage?: string;
  /** 本回合执行过但返回失败的工具列表 */
  failedTools?: FailedTool[];
  /** 本回合执行过但返回空/零结果的工具列表 */
  emptyResultTools?: EmptyResultTool[];
  /** 本回合**真实执行过**的变更类工具调用（工具名 + 参数摘要） */
  writeOps?: Array<{ name: string; args: string }>;
  /**
   * 本回合真实执行过的 shell 命令文本（shell_exec/bash/execute_code 的原始命令）。
   * 用于「声称运行了验证命令但无执行记录」对账（v4 Task 8 事故：回复声称
   * 运行 node --test 验证通过，但工具日志只有 node -e require 测试）。
   */
  executedShellCommands?: string[];
}

export interface ReconcileResult {
  /** 是否检测到虚假/不可信的完成声明 */
  needsCorrection: boolean;
  /** 问题类型，便于测试与日志定位 */
  reason?: "pending_permissions" | "no_tool_executed" | "tool_failed" | "empty_but_detailed" | "write_claimed_not_executed" | "claimed_command_not_executed";
  /**
   * 给 **LLM 看**的续跑/纠错指令（内部提示词）。
   * ★ 绝不可直接展示给用户 —— 事故（2026-10-08 20:24）就是把它拼进了正文，
   * 用户看到"请修复上述失败后重新执行；在拿到工具的成功返回之前…"这种
   * 本该给模型自己看的句子。要展示请用 {@link buildUserFacingCorrection}。
   */
  notice?: string;
}

/**
 * 把内部纠错指令转成**给用户看**的一句话摘要。
 *
 * 用户要的是"明确的任务完成/失败提示 + 简洁准确的总结"，
 * 不是一段内部指令。所以这里只说清「哪些没成功」，不复述
 * "请修复上述失败后重新执行"这类对模型说的话。
 */
export function buildUserFacingCorrection(v: ReconcileResult): string {
  if (!v.needsCorrection) return "";
  const suffix = "\n\n---\n\n**⚠️ 任务未完成**：上面的结论需要修正——";

  switch (v.reason) {
    case "pending_permissions":
      return suffix + "有操作仍在等待你的审批，尚未实际执行，之前的「已完成」不成立。";
    case "tool_failed":
      return suffix + "本回合有工具执行失败，相关变更**没有生效**，之前的「已完成」不成立。失败项见上方执行记录。";
    case "no_tool_executed":
      return suffix + "本回合没有实际执行任何工具操作，之前的「已完成」不成立。";
    case "write_claimed_not_executed":
      return suffix + "本回合没有执行任何写文件/改文件类工具，「已修改/已创建」不成立。";
    case "empty_but_detailed":
      return suffix + "相关工具返回的是空结果，上文给出的数量与明细**并非来自实际数据**，请勿采信。";
    case "claimed_command_not_executed":
      return suffix + "回复声称执行了某些验证命令，但本回合工具日志中没有对应执行记录，「验证通过」不成立。";
    default:
      return suffix + "之前的「已完成」结论不成立，请以实际执行结果为准。";
  }
}

/**
 * 完成声明特征。中英文都要覆盖——模型在不同 provider 下的措辞不稳定。
 * 刻意只匹配"明确的完成动词 + 结果"，避免把"我会完成""能否完成"这类
 * 询问/承诺句式误判为完成声明。
 */
const COMPLETION_CLAIM_PATTERNS: RegExp[] = [
  // 中文：已完成 / 已添加 / 已创建 / 已删除 / 已修改 / 已发送 / 已安装 / 已配置 …
  // 「已成功完成」也常见（v4 Task 8 回复即此措辞），故 (?:成功)? 可选。
  /已(?:成功)?(?:完成|添加|新增|创建|删除|移除|修改|更新|发送|运行|执行|安装|配置|设置|保存|写入|注册|部署|搞定|办妥|处理好)/,
  // 中文：添加成功 / 配置完成 / 发送成功 …
  /(?:添加|创建|删除|修改|发送|安装|配置|设置|注册|保存|部署)(?:成功|完毕|完成)/,
  // 中文：搞定了 / 办好了 / 妥了
  /(?:搞定|办妥|办好了|弄好了|处理好了|妥了)/,
  // 中文：已经配置好了 / 已经添加完了（"已经"+"动词"+"了"）
  /已经(?:完成|添加|新增|创建|删除|移除|修改|更新|发送|运行|执行|安装|配置|设置|保存|写入|注册|部署|处理)(?:好|完|完毕|完事)?了/,
  // 中文："已 + 近指词 + 变更动词"（已就地修改 / 已改为 / 已更新为 …，2026-10-15 eval15 t11）
  /已\S{0,8}(?:修改|创建|写入|删除|移除|更新|保存|部署|改完|改好)/s,
  // 中文：句尾独立的"完成/完毕"（如"✅ 添加邮箱 xxx 完成"），
  // 刻意要求其后无其他实词，避免误伤"能帮我完成吗？"这类询问句
  /(?:^|[\s，,。、：:；;）)])(?:完成|完毕)(?:了)?\s*[。！!]*\s*$/,
  // 英文
  /\bhas been (?:added|created|configured|registered|saved|installed|sent)\b/i,
  /\b(?:successfully|successfully added|successfully created)\b/i,
  /\b(?:done|completed|finished)\b\s*[.!。！]?\s*$/i,
];

/**
 * 执行类意图特征。用户说出这些话时，理应产生工具调用；
 * 若模型在完全没有调用工具的情况下却声称"已完成"，即为伪造完成态。
 */
const ACTION_INTENT_PATTERNS: RegExp[] = [
  /(?:添加|新增|增加|创建|删除|删掉|移除|修改|更新|发送|运行|执行|安装|配置|设置|注册|保存|写入|部署|导入)/,
  /\b(?:add|create|send|delete|remove|update|run|install|configure|set|register|save|write|deploy|import)\b/i,
];

/** 判断文本是否包含"完成声明" */
export function claimsCompletion(text: string): boolean {
  if (!text) return false;
  return COMPLETION_CLAIM_PATTERNS.some((re) => re.test(text));
}

/** 判断用户请求是否包含"执行类"意图 */
export function hasActionIntent(text: string): boolean {
  if (!text) return false;
  return ACTION_INTENT_PATTERNS.some((re) => re.test(text));
}

/**
 * 从一个工具返回值中提取「失败证据」；成功则返回 null。
 *
 * 需要处理的真实形态（都是本次事故里出现过的）：
 *   - `{ success: false, error: "..." }`
 *   - `{ success: false, errors: ["Skill not found"] }`
 *   - `{ success: true, result: { success: false, errors: ["Skill not found"] } }`  ← skill_manage 的外层包装，
 *     外层 success 为 true 极易被模型误读为成功
 *   - 序列化后的 JSON 字符串
 *
 * 注意：`{ success:false, requiresPermission:true }` 属于「等待审批」而非失败，
 * 由 pendingPermissions 分支处理，此处必须排除，避免重复/误导。
 */
export function extractToolFailure(_toolName: string, result: unknown): string | null {
  if (result == null) return null;
  let obj: unknown = result;
  if (typeof obj === "string") {
    const t = obj.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return null;
    try {
      obj = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || obj === null) return null;

  const outer = pickError(obj as Record<string, unknown>);
  if (outer) return outer;

  // 包装形态：真正的失败藏在 result / data / output 里
  for (const key of ["result", "data", "output"]) {
    const nested = (obj as Record<string, unknown>)[key];
    if (nested && typeof nested === "object") {
      const inner = pickError(nested as Record<string, unknown>);
      if (inner) return inner;
    }
  }
  return null;
}

function pickError(o: Record<string, unknown>): string | null {
  if (!o || typeof o !== "object") return null;
  // 等待审批不是失败
  if (o.requiresPermission === true || o.status === "pending") return null;

  const failed = o.success === false;
  const hasErr = typeof o.error === "string" && o.error.trim().length > 0;
  const hasErrs = Array.isArray(o.errors) && o.errors.length > 0;
  if (!failed && !hasErr && !hasErrs) return null;

  const parts: string[] = [];
  if (hasErr) parts.push(String(o.error).trim());
  if (hasErrs) {
    // apply_patch 等工具返回 { path, reason } 结构化错误 —— 逐个拼出可读文案。
    // 此前直接 errors.map(String) 会把对象拼成 "[object Object]"（2026-10-28
    // v4 复测 Task 7 实测）：模型看到无意义错误后放弃写文件，把内容以文本
    // 形式写进回复，浪费 151K tokens。
    parts.push(
      (o.errors as unknown[]).map((e) => {
        if (typeof e === "string") return e;
        if (e && typeof e === "object") {
          const r = e as Record<string, unknown>;
          const p = typeof r.path === "string" ? r.path : "";
          const why = typeof r.reason === "string" ? r.reason : (typeof r.error === "string" ? r.error : "");
          const joined = [p, why].filter(Boolean).join(": ");
          return joined || String(r);
        }
        return String(e);
      }).join("; "),
    );
  }
  if (parts.length === 0 && typeof o.message === "string" && o.message.trim()) parts.push(o.message.trim());
  if (parts.length === 0 && typeof o.reason === "string" && o.reason.trim()) parts.push(o.reason.trim());
  return parts.length > 0 ? parts.join("; ") : failed ? "工具返回失败" : null;
}

/**
 * 从工具返回值中判定「空/零结果」；有实质数据则返回 null。
 *
 * 覆盖三类真实形态：
 *   - 计数字段为 0：`{ totalEmails: 0 }` / `{ total: 0 }` / `{ count: 0 }`
 *   - 数据数组为空：`{ emails: [] }` / `{ accounts: [] }` / `[...]` 长度为 0
 *   - 汇总对象为空：`{ categories: {} }` 且与计数同为 0
 *
 * 刻意只在 `success !== false` 时判定——失败由 extractToolFailure 处理，
 * 避免同一返回值同时触发两个分支、产生叠加噪音。
 */
/**
 * 数据检索类工具白名单：只有这些工具的空结果才触发「empty_but_detailed」对账。
 *
 * 执行类工具（shell_exec / file_write / sequential_thinking / todo_list 等）
 * 返回空输出是正常行为——「find 没找到文件」不等于「没有数据可查」。
 * 若不区分，创造性任务（API 设计、PRD、商业计划书）中模型先 shell_exec
 * 查文件（返回空），再基于自身知识生成带编号的设计文档，就会被误判为
 * 「工具返回空但回复却有明细 → 编造数据」→ 触发自动续跑死亡螺旋
 * （每轮 60K+ tokens，120s 超时内根本无法完成）。
 */
const DATA_RETRIEVAL_TOOLS = new Set([
  "web_search", "web_fetch",
  // 邮件数据/分析工具：totalEmails=0 等空结果同样意味着"无数据可查"
  "email",
  "file_read",
  "skill_manage", // skill 可能返回数据
]);
// 注：以下旧名已随工具合并精简移除（注册表中不存在，均为死引用，勿再加回）：
// file_search（88379a5）、tavily_search（并入 web_search）、
// email_search/email_list/email_fetch（合并为复合 email）、
// knowledge_search/semantic_search（语义检索未注册为独立工具）。

export function extractEmptyResult(toolName: string, result: unknown): EmptyResultTool | null {
  // ★ 2026-10-26 修复：非数据检索类工具的空结果不参与对账
  if (!DATA_RETRIEVAL_TOOLS.has(toolName)) return null;
  if (result == null) return null;
  let obj: unknown = result;
  if (typeof obj === "string") {
    const t = obj.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return null;
    try {
      obj = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (Array.isArray(obj)) {
    return obj.length === 0 ? { name: toolName, field: "[] (空数组)" } : null;
  }
  if (typeof obj !== "object" || obj === null) return null;

  const o = obj as Record<string, unknown>;
  if (o.success === false) return null; // 失败不算"空结果"
  if (o.requiresPermission === true) return null;

  // 包装形态：结果藏在 result / data / summary 里
  for (const key of ["result", "data", "summary"]) {
    const nested = o[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const inner = extractEmptyResult(toolName, nested);
      if (inner) return inner;
    }
  }

  // 计数字段
  const COUNT_FIELDS = [
    "totalEmails", "totalCount", "total_count", "totalItems", "total",
    "count", "length", "numFound", "resultCount",
  ];
  for (const f of COUNT_FIELDS) {
    if (o[f] === 0) return { name: toolName, field: `${f}=0` };
  }

  // 数据数组为空（只认"列表型"字段，避免把空 {} 配置误判）
  const LIST_FIELDS = [
    "emails", "accounts", "items", "results", "messages", "files", "records",
    "topSenders", "topKeywords", "actionItems", "categories",
  ];
  const present = LIST_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(o, f));
  if (present.length > 0) {
    // 只要有任一列表字段非空，就认为有实质数据
    const anyNonEmpty = present.some((f) => {
      const v = o[f];
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === "object") return Object.keys(v as object).length > 0;
      return false;
    });
    if (!anyNonEmpty) return { name: toolName, field: `${present.join("/")} 全为空` };
  }
  return null;
}

/**
 * 判断回复是否像一份「基于数据的事实报告」——即包含具体数量或逐条明细。
 *
 * 若工具明明返回空，回复却长这样，就几乎可以断定是编造：
 *   - "共拉取到 30+ 封邮件"
 *   - "| GitHub CI/CD 通知 | 4 |"
 *   - "1. xxx  2. xxx  3. xxx"
 */
export function looksLikeDetailedReport(text: string): boolean {
  if (!text) return false;
  // 具体数量断言：数字 + 量词（封/条/个/项/次/笔/份/台/人/天/行/页/条记录/个结果）
  // 必须是非零数字——「共 0 封邮件」是如实汇报，不是编造。
  const quantity = /(?:共|总计|一共|合计)?\s*([1-9]\d*)\s*\+?\s*(?:封|条|个|项|次|笔|份|台|人|天|行|页|条记录|个结果)/;
  // 表格形式的明细行：| xxx | 非零数字 |
  // 同样必须非零——`| 类别 | 0 |` 是「查到了但为空」的如实表格。
  const tableRow = /\|\s*[^\n|]{2,}\s*\|\s*[1-9]\d*\s*\|/;
  // 编号列举至少 3 条
  const numbered = /(?:^|\n)\s*(?:[1-9][0-9]?\s*[.、)）]|\*\s*\*\*)\s*\S/m;
  const numberedCount = (text.match(/(?:^|\n)\s*[1-9][0-9]?\s*[.、)）]\s*\S/gm) || []).length;
  // 编号列举是三类信号里最弱的一类：工具返回空之后给用户列 3 条排查建议
  // （web_search 无结果、接口返回空列表）是**正常且诚实**的回复，绝不能当成编造。
  // 因此只有「通篇不含建议/动作类措辞」时才把编号列举当作数据明细的证据。
  const ADVICE_WORDS = /(?:建议|请(?:您|你)?|可以|需要|试试|应该|下一步|重试|排查|否则|推荐|尝试)/;
  const looksLikeAdvice = ADVICE_WORDS.test(text);

  return Boolean(
    quantity.test(text) ||
    tableRow.test(text) ||
    (!looksLikeAdvice && numbered.test(text) && numberedCount >= 3),
  );
}

/**
 * 核心对账函数：把"完成声明"与"实际执行证据"比对。
 *
 * @returns needsCorrection=true 时，notice 为应确定性追加到回复末尾的更正说明
 */
export function reconcileCompletionTruthfulness(input: ReconcileInput): ReconcileResult {
  const {
    finalReply,
    pendingPermissions = [],
    toolsExecuted = false,
    lastUserMessage = "",
    failedTools = [],
    emptyResultTools = [],
  } = input;

  // ── 情况零：工具返回空/零结果，回复却给出精确数量与逐条明细 → 数据系编造 ──
  // 这一分支**刻意不要求先有完成声明**：本次事故的回复并未写「已完成」，
  // 而是直接输出了一份看起来很专业的分类统计表，比伪造完成态更具迷惑性。
  if (emptyResultTools.length > 0 && looksLikeDetailedReport(finalReply)) {
    const list = emptyResultTools.map((e) => `- \`${e.name}\`：${e.field}`).join("\n");
    const notice =
      "\n\n---\n" +
      "⚠️ **更正**：本回复中的数量与明细**不可信**。本回合以下工具返回的是**空/零结果**，" +
      "并没有可供统计的数据：\n" +
      list +
      "\n\n上面的表格/数量并非来自工具返回值。请先确认该工具为何返回空" +
      "（如参数范围、账号未配置、抓取失败），修复后再重新拉取；在此之前请勿采信这些数字。";
    return { needsCorrection: true, reason: "empty_but_detailed", notice };
  }

  // 没有完成声明 → 无需干预（绝大多数正常回复走这条快速路径）
  if (!claimsCompletion(finalReply)) {
    return { needsCorrection: false };
  }

  // 情况一：声称完成，但仍有操作卡在"等待用户审批"，实际未生效
  if (pendingPermissions.length > 0) {
    const list = pendingPermissions
      .map((p) => `- \`${p.operation}\`：${p.description || "该操作"}${p.target ? `（目标：${p.target}）` : ""}`)
      .join("\n");
    const notice =
      "\n\n---\n" +
      "⚠️ **更正**：上面的「已完成」并不成立。以下操作仍在**等待你的审批**，实际尚未执行：\n" +
      list +
      "\n\n请在审批通过后让我重新确认结果；在审批之前请勿认为配置已经生效。";
    return { needsCorrection: true, reason: "pending_permissions", notice };
  }

  // 情况二：声称完成，但本回合有工具**执行了却返回失败**。
  // 真实事故：调用 skill_manage("email") 返回 errors:["Skill not found"]
  // （外层 success 仍为 true，模型误读为成功），随后回复「✅ 添加邮箱完成」。
  if (failedTools.length > 0) {
    const list = failedTools.map((f) => `- \`${f.name}\`：${f.error}`).join("\n");
    const notice =
      "\n\n---\n" +
      "⚠️ **更正**：上面的「已完成」并不成立。本回合以下工具**执行了但返回失败**，该变更并未生效：\n" +
      list +
      "\n\n请修复上述失败后重新执行；在拿到工具的成功返回之前，请勿认为操作已经完成。";
    return { needsCorrection: true, reason: "tool_failed", notice };
  }

  // 情况五：声称执行了验证命令，但本回合工具日志中没有该命令的执行记录。
  // 真实事故（v4 Task 8，2026-10-28）：回复「✅ 运行 node --test 验证全部通过」，
  // 但本轮 shell_exec 只有 node -e require 测试——node --test 从未执行，
  // 测试文件也从未创建。验证门因「调过 shell_exec + 回复含运行测试」而放行，
  // 因此需要这一道独立的对账。
  if (claimsCompletion(finalReply)) {
    const claimed = extractClaimedCommands(finalReply);
    if (claimed.length > 0) {
      const executed = input.executedShellCommands ?? [];
      const missing = claimed.filter(
        (c) => !executed.some((e) => e.includes(c) || c.includes(e)),
      );
      if (missing.length > 0) {
        const notice =
          "\n\n---\n" +
          "⚠️ **更正**：上面的「已完成」并不成立。回复声称执行了以下验证命令，但本回合工具日志中**没有该命令的执行记录**：\n" +
          missing.map((c) => `- \`${c}\``).join("\n") + "\n\n" +
          "请真正执行该命令（或说明为何无法执行）后再汇报结果；在拿到实际执行输出之前，请勿认为验证已通过。";
        return { needsCorrection: true, reason: "claimed_command_not_executed", notice };
      }
    }
  }

  // 情况三：声称完成，但本回合一个工具都没执行过（最典型的伪造完成态）
  // ★ 2026-10-26 修复：创造性任务（API 设计/PRD/商业计划书/技术文档）
  //   模型可以仅凭自身知识产出完整交付物，不需要工具。如果回复已经是
  //   实质性内容（> 300 字符），不应强制要求工具调用——否则会触发
  //   自动续跑，模型被迫调用 shell_exec/file_read 等无关工具，
  //   每个结果加入对话历史导致 token 爆炸（300K+）和超时。
  if (!toolsExecuted && hasActionIntent(lastUserMessage) && finalReply.length <= 300) {
    const notice =
      "\n\n---\n" +
      "⚠️ **更正**：上面的「已完成」并不成立——本次处理**没有实际执行任何工具操作**，该变更并未生效。\n" +
      "如果确实需要完成该操作，请让我调用对应工具重新执行；如果因缺少权限、配置或能力而无法完成，我会如实说明原因。";
    return { needsCorrection: true, reason: "no_tool_executed", notice };
  }

  // 情况四：声称**写文件类完成**（已修改/已创建/已写入…），但本回合没有任何
  // 变更类工具真正执行过。
  // 真实事故（2026-10-15 eval15 t11）：只跑了 file_list/file_read 两个只读工具，
  // 模型却把未执行的 file_write 以**文本形式**写在正文里（"[工具运行详情] {…}"）
  // 并声称「已就地修改」。文件根本没变。只读工具的调用不构成写操作证据，
  // 必须单独识别——否则被情况三的 toolsExecuted 快速路径放行。
  const writeOps = input.writeOps ?? [];
  if (writeOps.length === 0 && hasActionIntent(lastUserMessage) && claimsWriteCompletion(finalReply)) {
    const notice =
      "\n\n---\n" +
      "⚠️ **更正**：上面的「已修改/已创建」并不成立——本回合**没有执行任何写文件类工具**" +
      "（只做了文件读取/列表等只读操作）。请真正调用 file_write 等工具完成操作，" +
      "并在拿到工具的成功返回后再汇报结果。";
    return { needsCorrection: true, reason: "write_claimed_not_executed", notice };
  }

  return { needsCorrection: false };
}

/**
 * 写文件类完成声明：「已修改」「已创建」「已写入」「修改成功」……
 * 与 COMPLETION_CLAIM_PATTERNS 的区别：这里只挑**变更动词**——
 * 只读验证（「已运行」「已检查」）不算。
 */
const WRITE_CLAIM_PATTERNS: RegExp[] = [
  /已\S{0,8}(?:修改|创建|写入|删除|更新|保存|部署|移除|新增)/s,
  /(?:^|[\n\s，,。（(])[\S]{0,4}(?:修改|创建|写入|删除|更新|保存|部署)(?:成功|完毕|完成)/,
  /已就地修改/,
];

/** 判断回复是否声称了写文件类完成 */
export function claimsWriteCompletion(text: string): boolean {
  if (!text) return false;
  return WRITE_CLAIM_PATTERNS.some((re) => re.test(text));
}

// ── 声称执行过的命令提取（v4 Task 8 事故驱动）───────────────────────────

/** 引号内命令（反引号/单双引号/中文引号） */
const QUOTED_CMD_RE = /[「'"`『]([^」'"`』\n]{4,120})[」'"`』]/g;
/** 散文句式：运行/执行/跑 + 验证类命令 */
const PROSE_VERIFY_RE =
  /(?:运行|执行|跑)\s*(?:了)?\s*(node\s+--test|npm\s+test|pnpm\s+test|yarn\s+test|vitest(?:\s+run)?|jest|mocha|tsc|pytest|make\s+test|deno\s+test)\b/gi;
/** 验证类命令特征 */
const VERIFICATION_CMD_RE =
  /(?:test|vitest|jest|mocha|tsc|pytest|make\s+test|npm\s+test|pnpm\s+test|yarn\s+test|node\s+--test|deno\s+test)/i;
/** 句子执行上下文：声称「运行/执行/验证通过」等 */
const EXEC_CONTEXT_RE = /(?:运行|执行|跑|验证|通过|测试|检查|passed|verified|ran)/i;
/** 已知解释器/运行器名（引号内单命令必须以此开头） */
const CMD_LEADER_RE = /^(?:node|npm|npx|pnpm|yarn|vitest|jest|mocha|tsc|pytest|python3?|bash|sh|make|deno)\b/i;
/** 恰好是单个运行器名（无参数形态） */
const SINGLE_RUNNER_RE = /^(?:vitest|jest|mocha|pytest|tsc|deno)$/i;

/** 判断引号内文本是否像一条命令（而非路径/文件名） */
function looksLikeCommand(c: string): boolean {
  // 含空格或 flag → 命令 + 参数（`node --test` / `npm test` / `jest --watch`）
  if (/\s/.test(c) || /--/.test(c)) return true;
  // 单个词：必须是已知运行器名（`vitest`），排除 `node-test.js` 这类文件名
  return SINGLE_RUNNER_RE.test(c);
}

/**
 * 从回复中提取声称执行过的**验证类命令**。
 *
 * 两类来源：
 *   1. 引号内命令：`node --test`、"npm test" 等
 *   2. 散文句式：运行/执行/跑 + 命令，如「运行 node --test 验证通过」
 *
 * 只收录验证类命令，且所在句子必须含执行/验证上下文词——
 * 避免把示例引用误判为执行声称。
 */
export function extractClaimedCommands(reply: string): string[] {
  const out = new Set<string>();
  if (!reply) return [];
  // 按句子切分，只检查含执行上下文的句子
  const sentences = reply.split(/[.!?。！？\n]+/);
  for (const sentence of sentences) {
    if (!EXEC_CONTEXT_RE.test(sentence)) continue;
    // 引号内命令
    for (const m of sentence.match(QUOTED_CMD_RE) || []) {
      const c = m.replace(/[「'"`『」』]/g, "").trim();
      if (!VERIFICATION_CMD_RE.test(c)) continue;
      if (CMD_LEADER_RE.test(c) && looksLikeCommand(c)) out.add(c);
    }
    // 散文：运行 + 命令
    for (const m of sentence.match(PROSE_VERIFY_RE) || []) {
      const c = m.replace(/^.*?(?:运行|执行|跑)/, "").trim();
      if (c) out.add(c);
    }
  }
  return Array.from(out);
}
