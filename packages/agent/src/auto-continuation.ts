/**
 * 自动续跑（Auto-continuation）
 *
 * 背景（真实事故）：agent 在任务中途遇到工具失败、或自己发现了问题之后，
 * **不会自动纠正后接着跑**，而是把执行权交还给用户，要求用户输入「继续」
 * 才肯往下走。用户的原话：
 *
 *   「它发现了问题不自动纠正后接着跑任务，而是停下来等我输入"继续"！」
 *
 * 典型表现：
 *   - 「你回个 A 或 B，我就继续 🧬」
 *   - 「要不要我马上用授权码跑一次 IMAP 登录？你一句话我就开工」
 *   - 「接下来我将…（然后什么都没做就结束了本轮）」
 *   - 工具报错后只是把错误复述一遍，然后等用户说「继续」
 *
 * 设计目标：把「承诺了后续动作却没做」与「只把问题说出来却没修」这两类
 * 停顿识别出来，让主循环**自动回灌一条指令让模型继续执行**，而不是返回给用户。
 *
 * 与 completion-truthfulness 的分工：
 *   - completion-truthfulness 管「说完成但其实没完成」（事后对账）
 *   - 本模块管「该继续却停下来问人」（事前/事中续跑）
 * 两者在 llm-caller 里配合使用：先尝试自动续跑，续跑次数用尽才落回对账更正。
 */

/** 停顿原因，便于日志与测试定位 */
export type PrematureStopKind =
  /** 明确要求用户回复「继续」之类的确认词 */
  | "ask_user_to_continue"
  /** 承诺了"接下来/下一步我会…"，但本轮没有任何工具调用 */
  | "promise_future_action"
  /** 以问句把决定权交还用户（要不要我…？/需要我…吗？） */
  | "ask_user_permission";

/**
 * 「请用户回复继续」类特征——最直接、最该被消灭的停顿形态。
 */
const ASK_TO_CONTINUE_PATTERNS: RegExp[] = [
  // 请回复继续 / 请回复「继续」
  /请\s*[「"'“]?\s*(?:回复|回|输入|发送|说)\s*[「"'“]?\s*(?:继续|continue)/i,
  // 回复「继续」我就…／回个「A」我就开工
  /(?:回复|回)\s*个?\s*[「"'“]?\s*[A-Za-z\u4e00-\u9fa5]{1,4}\s*[」"'”]?\s*(?:我)?(?:就|便|立刻|马上|立即)/,
  // 你一句话（回个话）就动手 / 告诉我一声 / 点头
  /你(?:一句话|回个话|说一声|点个头)/,
  /(?:告诉|通知)我(?:一声|一下)\s*(?:就|我)/,
  // 回个 A 或 B
  /回\s*个?\s*[A-Z]\s*(?:或|\/|还是)\s*[A-Z]/,
  // 等你回复/等你确认后我就…
  /(?:等|待)你\s*(?:回复|确认|授权|同意|点头)\s*(?:后|之后)?\s*(?:我)?(?:就|便|再|立刻|马上)/,
  // 确认后我就继续
  /(?:确认|授权|同意)(?:后|之后)\s*(?:我)?(?:就|便|再|立刻|马上)(?:继续|接着|开始|执行)/,
  // 需要你确认/需要你先确认
  /需要你\s*(?:先)?\s*(?:确认|授权|同意|提供)/,
  // 下一步怎么走，你来定 / 你定
  /(?:下一步|接下来)\s*(?:怎么走|怎么做|如何)\s*(?:，|,)?\s*(?:主人)?\s*你(?:来)?定/,
];

/**
 * 「承诺后续动作」类特征——只有在本轮**没有任何工具调用**时才算停顿
 * （若本轮确实调了工具，那只是正常的过程叙述，不算停顿）。
 */
const PROMISE_FUTURE_PATTERNS: RegExp[] = [
  /接下来\s*(?:我)?\s*(?:将|会|要|来|去)/,
  /下一步\s*(?:我)?\s*(?:将|会|要|来|去)/,
  /(?:我)?\s*(?:将|会|要)\s*(?:继续|接着)\s*(?:执行|处理|完成|拉取|运行|抓取|获取|验证|重试)/,
  /(?:我)?\s*(?:马上|立刻|立即|这就|现在就)\s*(?:去|来|开始|执行|运行|重试|用|做|跑|查|拉|写|改|动手|开工|处理|获取|抓取|登录)/,
  /一旦\s*你\s*(?:确认|同意|回复|授权|提供)/,
  /如果\s*你\s*(?:确认|同意|回复|授权)\s*(?:，|,)?\s*(?:我)?\s*(?:就|便)/,
];

/**
 * 「把决定权交还用户」的问句特征——结尾是问句且询问是否继续/是否需要。
 *
 * 含第一人称「我也可以继续 / 我就能接着做」：这是典型的「我停下了，等你发话」，
 * 语义上属于交还决定权而非命令用户回复，故放在这一组。
 * 用 `(?<!你)` 排除「**你**可以继续」这种劝用户继续的正常收尾话术。
 */
const ASK_PERMISSION_PATTERNS: RegExp[] = [
  /(?:要不要|需不需要|是否需要)\s*我\s*(?:继续|接着|马上|立刻|去|来|帮你)/,
  /要我\s*(?:继续|接着)\s*(?:吗|么|不)/,
  /(?:可以|能否|可否)\s*(?:继续|接着)\s*(?:吗|么)/,
  /你\s*(?:看|觉得)\s*(?:要不要|需不需要|如何|怎么样)/,
  /需要我\s*.{0,20}\s*(?:吗|么)\s*[?？]?\s*$/,
  // 第一人称交还决定权（排除「你可以继续」）
  /(?<!你)我(?:也|就|才能)?(?:可以|能)(?:继续|接着|马上|立刻)(?:做|执行|处理|往下)?/,
  // 反问句式：「是否继续」「要不要接着」
  /(?:告诉|问)我(?:是否|要不要|需要不?要)\s*(?:继续|接着|往下|做)/,
  /(?:是否|要不要)\s*(?:继续|接着)(?:处理|做|往下|执行)/,
];

/**
 * 判断回复是否属于「过早停顿」。
 *
 * @param reply 模型本轮生成的文本
 * @param opts.toolCallsThisRound 本轮是否产生了工具调用（true 时"承诺后续"不算停顿）
 * @returns 停顿类型；非停顿返回 null
 */
export function detectPrematureStop(
  reply: string,
  opts: { toolCallsThisRound?: boolean } = {},
): PrematureStopKind | null {
  if (!reply || !reply.trim()) return null;
  const text = reply.trim();

  // 1) 明确要用户回复「继续」——无论本轮有没有调用工具都算停顿
  //    （本轮调了工具还要求用户说继续，同样是多余的停顿）
  if (ASK_TO_CONTINUE_PATTERNS.some((re) => re.test(text))) {
    return "ask_user_to_continue";
  }

  // 2) 承诺后续动作——只有本轮没执行工具时才算
  if (!opts.toolCallsThisRound && PROMISE_FUTURE_PATTERNS.some((re) => re.test(text))) {
    return "promise_future_action";
  }

  // 3) 以问句把决定权交还用户
  if (ASK_PERMISSION_PATTERNS.some((re) => re.test(text))) {
    return "ask_user_permission";
  }

  return null;
}

/** 续跑指令所需的上下文 */
export interface ContinuationContext {
  /** 触发续跑的原因 */
  kind: PrematureStopKind | "needs_correction";
  /** 用户本轮的原始请求（用于让模型不忘目标） */
  userMessage?: string;
  /** completion-truthfulness 给出的更正说明（若有） */
  correction?: string;
  /** 本轮失败的工具 */
  failedTools?: Array<{ name: string; error: string }>;
  /** 本轮返回空结果的工具 */
  emptyResultTools?: Array<{ name: string; field: string }>;
}

/**
 * 构造回灌给模型的续跑指令。
 *
 * 刻意做成"系统级指令 + 明确的可执行清单"，而不是让模型自己悟：
 * 弱模型对含糊的 nudge 响应很差（这正是它停下来问人的原因）。
 */
export function buildContinuationDirective(ctx: ContinuationContext): string {
  const lines: string[] = [];

  lines.push("[系统指令] 你上一轮的回复把执行权交还给了用户，但**任务尚未完成**。请**立即继续执行**，不要再询问用户、不要以「回复继续」结尾。");

  if (ctx.userMessage) {
    lines.push(`用户的目标是：${ctx.userMessage.slice(0, 300)}`);
  }

  lines.push("请按下述要求继续：");

  if (ctx.failedTools && ctx.failedTools.length > 0) {
    const list = ctx.failedTools.map((f) => `  - \`${f.name}\`：${f.error}`).join("\n");
    lines.push(
      "1. 下面的工具**执行失败**了，请分析原因并**换一种方式重试**（例如：改用脚本文件替代内联命令、修正相对路径、调整参数范围、拆分步骤）：\n" + list,
    );
  }

  if (ctx.emptyResultTools && ctx.emptyResultTools.length > 0) {
    const list = ctx.emptyResultTools.map((e) => `  - \`${e.name}\`：${e.field}`).join("\n");
    lines.push(
      "2. 下面的工具返回了**空/零结果**，请先排查为何为空（参数范围、账号未配置、抓取失败），修复后重新获取，不要凭空补数据：\n" + list,
    );
  }

  if (ctx.correction) {
    lines.push("3. 系统对账发现的问题：" + ctx.correction.replace(/\n{2,}/g, " ").trim());
  }

  lines.push(
    "只有在**确实缺少你无法自行获取的必要信息**（如用户密码、授权码、个人偏好），" +
    "或操作**需要人工审批**时，才可以停下来询问。其余情况请直接调用工具继续，不要停下来。"
  );
  lines.push("直接开始执行，不要复述本指令。");

  return lines.join("\n");
}
