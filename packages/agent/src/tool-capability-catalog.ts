/**
 * Tool Capability Catalog — 能力速查表（渐进式披露的"索引层"）。
 *
 * 背景（根因）：
 *   系统提示词此前把全部工具名平铺成一行（如 "Available tools: a, b, c, ..." 共 90+ 个）。
 *   在这种超长平铺列表里，弱模型几乎必然漏看单个工具名，于是得出
 *   "我没有这个工具 / 系统缺少 XX 接口" 的错误结论，并进一步臆造
 *   "需要改配置文件"、"无法通过对话完成" 这类不存在的限制。
 *   真实案例：用户要求"添加邮箱账户"，模型回复"邮件相关工具只有
 *   email_list_accounts、email_list_inbox、email_send，缺少添加/注册账户接口"，
 *   而 `email_add_account` 其实一直存在且已下发。
 *
 * 方案：
 *   在完整工具清单之外，额外生成一张「用户意图 → 工具名」的结构化速查表，
 *   把长列表切成若干短语义块，让"添加邮箱账户 → email_add_account"这类映射
 *   显式可见。规则用正则匹配工具名而非硬编码具体名字，工具改名也能命中。
 *
 * 设计约束：
 *   - 纯函数、无副作用、零 I/O，便于单测。
 *   - 只输出"实际已注册"的工具，避免提示词里出现不存在的工具名（会诱发幻觉）。
 *   - 未命中任何工具的意图不输出，保持提示词紧凑。
 */

export interface CapabilityRule {
  /** 用户意图的自然语言描述（中文，面向模型） */
  intent: string;
  /** 匹配工具名的正则（对工具名逐条 test） */
  pattern: RegExp;
  /** 该意图最多展示几个工具，防止单块过长 */
  limit?: number;
}

/**
 * 意图 → 工具名匹配规则。
 * 顺序即输出顺序；越容易误判为"没有这个能力"的意图排越靠前。
 */
export const CAPABILITY_RULES: CapabilityRule[] = [
  // ── 最容易漏的一类：创建/添加/注册接口 ──
  { intent: "添加/配置/注册邮箱账户", pattern: /^email_(add|create|register|setup|connect)/ },
  { intent: "创建/添加定时任务或提醒", pattern: /^scheduler_(create|add)/ },
  { intent: "安装/添加技能", pattern: /^skill_(install|find|add)/ },
  { intent: "添加/连接 MCP 服务", pattern: /^mcp_(add|connect|install|register)/ },
  { intent: "添加/新建记忆条目", pattern: /^memory_(store|add|create|save)/ },

  // ── 常规能力域 ──
  { intent: "查看/管理已配置邮箱账户", pattern: /^email_(list_accounts|accounts|remove|delete|update)/, limit: 4 },
  { intent: "发送邮件 / 读取收件箱 / 分析邮件", pattern: /^email_(send|list|get|read|analyze|summarize|fetch|search)/, limit: 6 },
  { intent: "管理定时任务（查询/修改/删除/执行/历史）", pattern: /^scheduler_(list|update|delete|execute|history|pause|resume)/, limit: 6 },
  { intent: "生成 Word/Excel/PPT 文档", pattern: /^(docx|xlsx|pptx)_/, limit: 8 },
  { intent: "生成图片 / 视频，下载音视频", pattern: /^(image|video|music)_/, limit: 8 },
  { intent: "浏览器自动化（打开网页/点击/截图/填表）", pattern: /^browser_/, limit: 14 },
  { intent: "文件读写与检索", pattern: /^file_/, limit: 8 },
  { intent: "代码库语义检索", pattern: /^(codebase|code)_/, limit: 6 },
  { intent: "网页搜索与抓取", pattern: /^(web_search|web_fetch|scrapling_fetch|fetch_node_page)$/ },
  { intent: "执行 Shell 命令 / 运行脚本", pattern: /^(shell_exec|shell_)/, limit: 4 },
];

/**
 * 「创建类」工具的命名特征：模型最容易对这类工具误判为"系统没有提供接口"，
 * 因此单独汇总成一行高亮展示。
 *
 * 注意 `add` 可能出现在词中（如 email_add_account）而非仅结尾，
 * 故用 `(?:_|$)` 同时覆盖「中间」与「结尾」两种位置。
 */
const CREATION_PATTERN = /_(?:add|create|register|new|setup|connect|install)(?:_|$)/;

/**
 * 判断工具名是否属于「创建/添加/注册」类。
 *
 * 除用于提示词速查表外，还用于**工具下发裁剪的白名单**：这类工具一旦因
 * 关键词未命中而被裁掉，模型会直接失去"新增某物"的能力并误判系统不支持，
 * 因此必须保证任何措辞下都下发。
 */
export function isCreationTool(toolName: string): boolean {
  return typeof toolName === "string" && CREATION_PATTERN.test(toolName);
}

/**
 * 按单条规则匹配已注册工具。
 * 保持入参顺序输出，保证结果稳定可测。
 */
export function matchCapabilityTools(toolNames: string[], pattern: RegExp, limit?: number): string[] {
  const matched = toolNames.filter((name) => pattern.test(name));
  return typeof limit === "number" && limit > 0 ? matched.slice(0, limit) : matched;
}

/**
 * 汇总所有"创建/添加类"工具名，用于高亮展示。
 * 排除已在速查表中作为独立意图首项出现的邮箱添加工具也无妨——重复出现反而强化记忆。
 */
export function collectCreationTools(toolNames: string[], limit = 24): string[] {
  return toolNames.filter((name) => CREATION_PATTERN.test(name)).slice(0, limit);
}

/** 超过这个数量的工具就自动折行，避免又变回"一行十几个名字"的可读性问题 */
const WRAP_THRESHOLD = 6;
/** 折行后每行最多放几个工具名 */
const PER_LINE = 3;

/**
 * 渲染「意图 → 工具名」一行。
 *
 * 工具多时**必须折行**：browser_* 这类前缀天然命中十几个工具，
 * 平铺一行等于又回到了「一行一长串名字、模型必然漏看单项」的老问题
 * （真实数据：browser 组有 14 个工具名挤在一行）。
 */
function renderIntentLine(intent: string, tools: string[]): string[] {
  if (tools.length <= WRAP_THRESHOLD) {
    return [`- ${intent} → ${tools.map((t) => `\`${t}\``).join(", ")}`];
  }
  const out = [`- ${intent}（共 ${tools.length} 个）：`];
  for (let i = 0; i < tools.length; i += PER_LINE) {
    const chunk = tools.slice(i, i + PER_LINE).map((t) => `\`${t}\``).join(", ");
    out.push(`  ${chunk}`);
  }
  return out;
}

/**
 * 生成能力速查表的提示词段落（不含标题行，由调用方决定标题）。
 * 若没有任何意图命中，返回空数组，调用方应跳过整段。
 */
export function buildCapabilityCatalogLines(toolNames: string[]): string[] {
  if (!Array.isArray(toolNames) || toolNames.length === 0) return [];

  const lines: string[] = [];
  const seen = new Set<string>();

  for (const rule of CAPABILITY_RULES) {
    const tools = matchCapabilityTools(toolNames, rule.pattern, rule.limit);
    // 该意图下所有工具都已在前面的意图中出现过时，跳过以避免冗余
    const fresh = tools.filter((t) => !seen.has(t));
    if (fresh.length === 0) continue;
    for (const t of fresh) seen.add(t);
    lines.push(...renderIntentLine(rule.intent, fresh));
  }

  const creation = collectCreationTools(toolNames).filter((t) => !seen.has(t));
  if (creation.length > 0) {
    lines.push(...renderIntentLine("其它「新建/添加/注册」类操作", creation));
  }

  return lines.length > 0 ? lines : [];
}
