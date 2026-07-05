/**
 * SkillNameSanitizer — 技能名规范化
 *
 * 借鉴 OpenSpace skill_engine/evolver.py 的 _sanitize_skill_name：
 *   - lowercase
 *   - 非 [a-z0-9-] 转 -
 *   - 折叠多 -
 *   - 50 字符上限
 *   - 超长时在单词边界（最后一个 - > 长度一半）截断
 *
 * 防止 `panel-enhanced-enhanced-merged_abc123` 永增长链。
 *
 * EvoClaw 落地点：
 *   - skill-curator.ts 创建新技能时规范化 name
 *   - skill-learner.ts 从对话提取技能时规范化 name
 */

const MAX_SKILL_NAME_LENGTH = 50;

/**
 * 规范化技能名（借鉴 OpenSpace _sanitize_skill_name）。
 *
 * @param input 原始输入名（可能含大写、空格、下划线、特殊字符）
 * @returns 规范化后的 name（lowercase + 仅 [a-z0-9-] + ≤50 字符）
 */
export function sanitizeSkillName(input: string): string {
  if (!input) return "";

  let name = input.toLowerCase().trim();

  // 非 [a-z0-9] 转 -
  name = name.replace(/[^a-z0-9]+/g, "-");

  // 折叠多 -
  name = name.replace(/-+/g, "-");

  // 去除首尾 -
  name = name.replace(/^-+|-+$/g, "");

  if (!name) return "";

  // 长度限制 + 单词边界截断
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    const halfLen = Math.floor(MAX_SKILL_NAME_LENGTH / 2);
    // 找最后一个 - 在 halfLen 之后的位置（优先在单词边界截断）
    const lastDashInLatter = name.lastIndexOf("-", MAX_SKILL_NAME_LENGTH);
    if (lastDashInLatter > halfLen) {
      name = name.slice(0, lastDashInLatter);
    } else {
      // 没有合适的单词边界，硬截断
      name = name.slice(0, MAX_SKILL_NAME_LENGTH);
    }
    // 截断后再次去尾 -
    name = name.replace(/-+$/g, "");
  }

  return name;
}

/**
 * 检查技能名是否已规范化。
 */
export function isSanitizedName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= MAX_SKILL_NAME_LENGTH;
}

/**
 * 生成"基础名 + 后缀"形式的派生名（用于 derived 进化）。
 *
 * 例如：baseName="pdf-extraction" + suffix="enhanced" → "pdf-extraction-enhanced"
 * 如果超长，先截断 baseName 再加 suffix。
 */
export function deriveSkillName(baseName: string, suffix: string): string {
  const sanitizedBase = sanitizeSkillName(baseName);
  const sanitizedSuffix = sanitizeSkillName(suffix);

  if (!sanitizedBase) return sanitizedSuffix;
  if (!sanitizedSuffix) return sanitizedBase;

  const combined = `${sanitizedBase}-${sanitizedSuffix}`;
  if (combined.length <= MAX_SKILL_NAME_LENGTH) {
    return combined;
  }

  // 超长：保留 suffix，截断 base
  const availableForBase = MAX_SKILL_NAME_LENGTH - sanitizedSuffix.length - 1;
  if (availableForBase <= 0) {
    // suffix 自己就超长，截断 suffix
    return sanitizedSuffix.slice(0, MAX_SKILL_NAME_LENGTH);
  }

  // 在 baseName 的 availableForBase 范围内找最后一个 -
  const truncatedBase = sanitizedBase.slice(0, availableForBase);
  const lastDash = truncatedBase.lastIndexOf("-");
  const finalBase = lastDash > availableForBase / 2 ? truncatedBase.slice(0, lastDash) : truncatedBase;

  return sanitizeSkillName(`${finalBase}-${sanitizedSuffix}`);
}
