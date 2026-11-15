/**
 * Session title — 会话标题自动派生（对标 hermes agent/title_generator.py）。
 *
 * 只移植「确定性即时标题 + provenance」不变量，不搬 Hermes 的后台小模型升级管线
 * （那需要 auxiliary client / 线程编排；如需可单独立项）：
 *   - 即时标题：取用户开场消息首个有意义的行，按词边界裁到 ≤48 字符，**永不失败**、
 *     永不调模型、不阻塞主路径。
 *   - Provenance 权威序：`derived < llm < user`。derived 标题只能被 llm/用户标题替换，
 *     **用户手输的标题永不被覆盖**（`SessionInfo.customName` 视为 user 级）。
 *   - 机器生成的 opener（压缩交接 / 恢复会话 / 模型切换标记）不派生标题。
 *   - 附件-only opener（只有 @file 引用、无粘贴内容）不派生标题——否则会拿被截断的
 *     文件路径当标题（#92068）。
 *
 * 与 Hermes 的差异：
 *   - 不做 CJK/占位符 answer-shaped guard 那套模型输出校验（那些针对 LLM 升级路径；
 *     本模块只做确定性派生，天然不会「回答问题」）。
 *   - 不做 mojibake 修复（Hermes 为模型输出准备；确定性派生输入是用户原文）。
 */

/** 即时标题上限（对齐 hermes MAX_DERIVED_TITLE_CHARS）。 */
export const MAX_DERIVED_TITLE_CHARS = 48;

/** 标题来源权威等级（越大越权威）。derived < llm < user。 */
export type TitleSource = "derived" | "llm" | "user";

const TITLE_SOURCE_RANK: Record<TitleSource, number> = {
  derived: 1,
  llm: 2,
  user: 3,
};

/** 机器生成的 opener 前缀（这些不派生标题）。 */
const MACHINE_PREFIXES: ReadonlyArray<string> = [
  "[CONTEXT COMPACTION",
  "[CONVERSATION SUMMARY",
  "[Runtime note:",
  "[System note:",
  "[SYSTEM]",
  "[System: The active model for this chat has changed to ",
];

/** @file/@folder 引用（附件-only opener 判定用）。 */
const ATTACHMENT_REF_RE = /@(?:file|folder):[^\s]+/g;

/** 控制标签包裹的机器内容（titling 前剥掉，保留其余）。 */
const CONTROL_WRAPPERS: ReadonlyArray<[string, string]> = [
  ["<command-message>", "</command-message>"],
  ["<command-name>", "</command-name>"],
  ["<command-args>", "</command-args>"],
  ["<local-command-caveat>", "</local-command-caveat>"],
  ["<local-command-stderr>", "</local-command-stderr>"],
  ["<local-command-stdout>", "</local-command-stdout>"],
  ["<task-notification>", "</task-notification>"],
  ["<system-reminder>", "</system-reminder>"],
  ["<ide_opened_file>", "</ide_opened_file>"],
  ["<ide_selection>", "</ide_selection>"],
];

/** 剥控制标签包裹的机器内容。 */
export function stripControlWrappers(text: string): string {
  let out = text;
  for (const [open, close] of CONTROL_WRAPPERS) {
    out = out.split(open).join("").split(close).join("");
  }
  return out;
}

/** 首个非空行。 */
function firstLine(text: string): string {
  for (const ln of text.split(/\r?\n/)) {
    if (ln.trim()) return ln.trim();
  }
  return "";
}

/** 附件-only opener：去掉 @file 引用后没有实质文本。 */
function isAttachmentOnlyOpener(message: string): boolean {
  const stripped = message.replace(ATTACHMENT_REF_RE, "").trim();
  return stripped.length === 0 && /@(?:file|folder):/.test(message);
}

/** 用户消息是否可派生标题（False 于机器 opener / 空 / 附件-only）。 */
export function isTitleableUserMessage(message: string): boolean {
  if (typeof message !== "string") return false;
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (MACHINE_PREFIXES.some((p) => trimmed.startsWith(p))) return false;
  if (isAttachmentOnlyOpener(message)) return false;
  return stripControlWrappers(trimmed).trim().length > 0;
}

/**
 * 确定性即时标题：首个有意义行，按词边界裁到 MAX_DERIVED_TITLE_CHARS。
 * 不可派生时返回 null。永不 throw。
 */
export function deriveTitle(message: string): string | null {
  if (!isTitleableUserMessage(message)) return null;
  const line = firstLine(stripControlWrappers(message)).replace(/\s+/g, " ");
  if (!line) return null;
  if (line.length <= MAX_DERIVED_TITLE_CHARS) return line;
  const cut = line.slice(0, MAX_DERIVED_TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  const head = space > MAX_DERIVED_TITLE_CHARS / 2 ? cut.slice(0, space) : cut;
  return head.replace(/[ ,.;:—–-]+$/, "") + "…";
}

/**
 * 是否应用新标题：仅当新来源权威等级 > 现有来源（或现有为空）。
 * 保证 derived 不覆盖 user，llm 不覆盖 user。
 */
export function shouldApplyTitle(
  existing: { title?: string; titleSource?: TitleSource } | null | undefined,
  nextSource: TitleSource,
): boolean {
  if (!existing || !existing.title) return true;
  const existingRank = existing.titleSource ? TITLE_SOURCE_RANK[existing.titleSource] : 0;
  return TITLE_SOURCE_RANK[nextSource] > existingRank;
}

/**
 * 应用派生标题到会话元数据（就地产出 {title, titleSource} 或 null）。
 * 若会话已有 `customName`（用户手输），视为 user 级，永不覆盖。
 */
export function applyDerivedTitle(
  session: { title?: string; titleSource?: TitleSource; customName?: string },
  message: string,
): { title: string; titleSource: TitleSource } | null {
  // 用户手输标题是 user 级，assistant/派生永不覆盖
  if (session.customName && session.customName.trim()) return null;
  const derived = deriveTitle(message);
  if (!derived) return null;
  if (!shouldApplyTitle(session, "derived")) return null;
  return { title: derived, titleSource: "derived" };
}
