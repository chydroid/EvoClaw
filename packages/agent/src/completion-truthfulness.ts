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

export interface ReconcileInput {
  /** 模型生成的最终回复 */
  finalReply: string;
  /** 本回合仍未获批、需要用户审批的操作 */
  pendingPermissions?: PendingPermission[];
  /** 本回合是否真正执行过任何工具 */
  toolsExecuted?: boolean;
  /** 用户本轮的原始请求，用于判断是否包含"执行类"意图 */
  lastUserMessage?: string;
}

export interface ReconcileResult {
  /** 是否检测到虚假/不可信的完成声明 */
  needsCorrection: boolean;
  /** 问题类型，便于测试与日志定位 */
  reason?: "pending_permissions" | "no_tool_executed";
  /** 应追加到最终回复的确定性更正文本 */
  notice?: string;
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
 * 核心对账函数：把"完成声明"与"实际执行证据"比对。
 *
 * @returns needsCorrection=true 时，notice 为应确定性追加到回复末尾的更正说明
 */
export function reconcileCompletionTruthfulness(input: ReconcileInput): ReconcileResult {
  const { finalReply, pendingPermissions = [], toolsExecuted = false, lastUserMessage = "" } = input;

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

  // 情况二：声称完成，但本回合一个工具都没执行过（最典型的伪造完成态）
  if (!toolsExecuted && hasActionIntent(lastUserMessage)) {
    const notice =
      "\n\n---\n" +
      "⚠️ **更正**：上面的「已完成」并不成立——本次处理**没有实际执行任何工具操作**，该变更并未生效。\n" +
      "如果确实需要完成该操作，请让我调用对应工具重新执行；如果因缺少权限、配置或能力而无法完成，我会如实说明原因。";
    return { needsCorrection: true, reason: "no_tool_executed", notice };
  }

  return { needsCorrection: false };
}
