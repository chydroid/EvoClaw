/**
 * 完成声明真实性校验（Completion Truthfulness Reconciliation）
 *
 * 背景：agent 曾出现「声称『✅ 添加邮箱完成』但实际从未调用 email_add_account」
 * 的伪造完成态。根因是系统提示词缺少真实性约束，且最终回复返回前
 * 没有任何机制把「模型的完成声明」与「实际发生的工具执行 / 未决权限」对账。
 *
 * 本模块提供纯函数式的对账能力，在 llm-caller 返回 finalReply 之前调用：
 *   - 模型声称完成，但操作仍处于 pending（等待人工审批） → 追加更正说明
 *   - 模型声称完成，但本回合完全没有执行任何工具      → 追加更正说明
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
 * 真实事故：email_analyze 返回 `{totalEmails: 0, categories: {}, topSenders: []}`，
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
}

export interface ReconcileResult {
  /** 是否检测到虚假/不可信的完成声明 */
  needsCorrection: boolean;
  /** 问题类型，便于测试与日志定位 */
  reason?: "pending_permissions" | "no_tool_executed" | "tool_failed" | "empty_but_detailed";
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
    case "empty_but_detailed":
      return suffix + "相关工具返回的是空结果，上文给出的数量与明细**并非来自实际数据**，请勿采信。";
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
  /已(?:完成|添加|新增|创建|删除|移除|修改|更新|发送|运行|执行|安装|配置|设置|保存|写入|注册|部署|搞定|办妥|处理好)/,
  // 中文：添加成功 / 配置完成 / 发送成功 …
  /(?:添加|创建|删除|修改|发送|安装|配置|设置|注册|保存|部署)(?:成功|完毕|完成)/,
  // 中文：搞定了 / 办好了 / 妥了
  /(?:搞定|办妥|办好了|弄好了|处理好了|妥了)/,
  // 中文：已经配置好了 / 已经添加完了（"已经"+"动词"+"了"）
  /已经(?:完成|添加|新增|创建|删除|移除|修改|更新|发送|运行|执行|安装|配置|设置|保存|写入|注册|部署|处理)(?:好|完|完毕|完事)?了/,
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
 *   - `{ success: true, result: { success: false, errors: ["Skill not found"] } }`  ← skill_execute 的外层包装，
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
  if (hasErrs) parts.push((o.errors as unknown[]).map(String).join("; "));
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
export function extractEmptyResult(_toolName: string, result: unknown): EmptyResultTool | null {
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
    return obj.length === 0 ? { name: _toolName, field: "[] (空数组)" } : null;
  }
  if (typeof obj !== "object" || obj === null) return null;

  const o = obj as Record<string, unknown>;
  if (o.success === false) return null; // 失败不算"空结果"
  if (o.requiresPermission === true) return null;

  // 包装形态：结果藏在 result / data / summary 里
  for (const key of ["result", "data", "summary"]) {
    const nested = o[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const inner = extractEmptyResult(_toolName, nested);
      if (inner) return inner;
    }
  }

  // 计数字段
  const COUNT_FIELDS = [
    "totalEmails", "totalCount", "total_count", "totalItems", "total",
    "count", "length", "numFound", "resultCount",
  ];
  for (const f of COUNT_FIELDS) {
    if (o[f] === 0) return { name: _toolName, field: `${f}=0` };
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
    if (!anyNonEmpty) return { name: _toolName, field: `${present.join("/")} 全为空` };
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
  // 真实事故：调用 skill_execute("email_add_account") 返回 errors:["Skill not found"]
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

  // 情况三：声称完成，但本回合一个工具都没执行过（最典型的伪造完成态）
  if (!toolsExecuted && hasActionIntent(lastUserMessage)) {
    const notice =
      "\n\n---\n" +
      "⚠️ **更正**：上面的「已完成」并不成立——本次处理**没有实际执行任何工具操作**，该变更并未生效。\n" +
      "如果确实需要完成该操作，请让我调用对应工具重新执行；如果因缺少权限、配置或能力而无法完成，我会如实说明原因。";
    return { needsCorrection: true, reason: "no_tool_executed", notice };
  }

  return { needsCorrection: false };
}
