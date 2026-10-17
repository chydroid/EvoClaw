/**
 * 验证门（Verification Gate）—— 防止「未验证就声称完成」
 *
 * 借鉴 hermes-agent 的 agent/verification_stop.py：
 *   - 模型在**变更类工具**（文件写类）之后立即声称「已完成」时，
 *     门会注入一条合成的 user nudge，要求模型先验证工作成果再结束。
 *   - 与 completion-truthfulness 的「事后对账」不同，这是**事前拦截**：
 *     不是追加更正说明，而是让模型继续跑，直到它给出验证证据。
 *
 * 设计取舍：
 *   - 纯策略模块，不直接运行检查——它只决定「是否需要继续」，
 *     真正的验证动作由模型自己发起（读文件、跑测试、解包校验等）。
 *   - 文档/Markdown/纯数据文件不触发门（无可验证行为）。
 *   - 最多 2 次 nudge，防止无限续跑。
 */

/** 变更类（文件写）工具名——这些工具的产出需要验证 */
export const FILE_MUTATING_TOOLS = new Set([
  "file_create",
  "file_modify",
  "file_delete",
  "file_rename",
  "file_copy",
  "docx_create",
  "xlsx_create",
  "pptx_create",
  "write_file",
  "patch",
]);

/** 验证类工具名——这些工具的调用视为「有验证意图」 */
export const VERIFICATION_TOOLS = new Set([
  "file_read",
  "file_list",
  "shell_exec",
  "execute_code",
  "python_exec",
  "run_code",
  "grep",
  "search",
  "web_fetch",
  "browser_navigate",
  "docx_read",
  "xlsx_read",
  "pptx_read",
  "zip_read",
  "unzip",
]);

/** 纯文档/数据文件扩展名——这些文件的变更不触发验证门 */
const NON_CODE_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdx", ".rst", ".txt", ".text",
  ".adoc", ".asciidoc", ".org", ".log", ".csv", ".tsv",
  ".json", ".yaml", ".yml", ".xml", ".html", ".htm",
  ".css", ".scss", ".sass", ".less",
]);

/** 纯文档文件名（无扩展名也算） */
const NON_CODE_FILENAMES = new Set([
  "license", "licence", "notice", "authors", "contributors",
  "changelog", "codeowners", "readme",
]);

/** 最大 nudge 次数 */
const MAX_NUDGES = 2;

/** 验证门配置 */
export interface VerificationGateConfig {
  /** 是否启用验证门 */
  enabled?: boolean;
  /** 最大 nudge 次数 */
  maxNudges?: number;
}

/**
 * 判断路径是否为纯文档/数据文件（无可验证行为）。
 */
export function isNonCodePath(raw: string): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  // 提取文件名部分（去掉目录前缀）
  const lastSlash = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"));
  const filename = lower.slice(lastSlash + 1);
  const dot = filename.lastIndexOf(".");
  const suffix = dot > 0 ? filename.slice(dot) : "";
  if (NON_CODE_EXTENSIONS.has(suffix)) return true;
  if (!suffix && NON_CODE_FILENAMES.has(filename)) return true;
  return false;
}

/**
 * 过滤掉纯文档路径，保留可能有可验证行为的路径。
 */
export function filterVerifiablePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => p && !isNonCodePath(p)))];
}

/**
 * 判断本轮是否执行过变更类工具。
 */
export function hasFileMutation(
  executedTools: string[],
  fileMutatingTools: Set<string> = FILE_MUTATING_TOOLS,
): boolean {
  return executedTools.some((t) => fileMutatingTools.has(t));
}

/**
 * 判断本轮是否执行过验证类工具（有验证意图）。
 */
export function hasVerificationIntent(
  executedTools: string[],
  verificationTools: Set<string> = VERIFICATION_TOOLS,
): boolean {
  return executedTools.some((t) => verificationTools.has(t));
}

/**
 * 判断最终回复是否包含验证证据（模型在正文中描述了验证动作）。
 */
export function replyContainsVerificationEvidence(reply: string): boolean {
  const patterns = [
    /已验证|验证通过|检查过|确认无误|解包验证|zipfile.*验证|校验通过/,
    /verified|checked|confirmed|validated|test.*passed|tests.*passed/,
    /运行.*测试|跑.*测试|执行.*测试|运行.*检查|执行.*检查/,
    /读取.*确认|检查.*文件|检查.*内容|检查.*结果/,
  ];
  return patterns.some((p) => p.test(reply));
}

/**
 * 构建验证门 nudge 消息（合成 user 消息，注入对话继续跑）。
 *
 * @param changedPaths 本轮变更的文件路径
 * @param attempts 已尝试的 nudge 次数
 * @param maxNudges 最大 nudge 次数
 * @returns nudge 消息，null 表示不需要 nudge
 */
export function buildVerifyOnStopNudge(
  changedPaths: string[],
  attempts: number,
  maxNudges: number = MAX_NUDGES,
): string | null {
  const paths = filterVerifiablePaths(changedPaths);
  if (paths.length === 0 || attempts >= maxNudges) return null;

  const pathList = paths.slice(0, 8).map((p) => `- \`${p}\``).join("\n");
  const more = paths.length > 8 ? `\n- ... 另有 ${paths.length - 8} 个文件` : "";

  return (
    `⚠️ 验证门：你在本轮修改了以下文件，但尚未提供验证证据就准备结束：\n\n` +
    `${pathList}${more}\n\n` +
    `请在结束前完成验证：\n` +
    `1. 读取/检查你创建或修改的文件，确认内容正确\n` +
    `2. 如果是文档（docx/xlsx/pptx），用 python3 zipfile 解包验证结构\n` +
    `3. 如果是代码/脚本，运行测试或执行检查\n` +
    `4. 如果是数据文件，验证内容完整性和格式\n\n` +
    `验证完成后，给出验证结果并结束。如果确实无法验证（如纯文本文件），说明原因后可直接结束。`
  );
}

/**
 * 从工具调用参数中提取变更的文件路径。
 *
 * 支持 file_create / file_modify / docx_create / xlsx_create / pptx_create 等工具，
 * 它们的参数中都包含 `path` 字段。
 */
export function extractChangedPaths(
  executedTools: Array<{ name: string; arguments: Record<string, unknown> }>,
): string[] {
  const paths: string[] = [];
  for (const t of executedTools) {
    const args = t.arguments || {};
    const rawPath = args.path || args.filePath || args.file_path;
    if (typeof rawPath === "string" && rawPath) {
      paths.push(rawPath);
    }
  }
  return paths;
}

/**
 * 判断验证门是否应该触发。
 *
 * 触发条件（全部满足）：
 * 1. 本轮执行过变更类工具
 * 2. 模型准备结束（无更多工具调用）
 * 3. 本轮未执行过验证类工具
 * 4. 最终回复不含验证证据
 * 5. nudge 次数未超上限
 */
export function shouldTriggerVerificationGate(
  executedTools: string[],
  finalReply: string,
  nudgeAttempts: number,
  config: VerificationGateConfig = {},
): boolean {
  if (config.enabled === false) return false;
  const max = config.maxNudges ?? MAX_NUDGES;
  if (nudgeAttempts >= max) return false;
  if (!hasFileMutation(executedTools)) return false;
  if (hasVerificationIntent(executedTools)) return false;
  if (replyContainsVerificationEvidence(finalReply)) return false;
  return true;
}