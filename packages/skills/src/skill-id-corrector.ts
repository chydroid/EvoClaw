/**
 * SkillIdCorrector — LLM 幻觉 skill_id 自适应纠错
 *
 * 借鉴 OpenSpace skill_engine/analyzer.py 的 _correct_skill_ids：
 *   - LLM 经常把 hex 后缀写错（cb → bc, 0/O 混淆）
 *   - 按 name prefix（__ 前的部分）筛候选
 *   - 候选 >20 时收紧阈值到 2，否则放宽到 4（候选数驱动阈值）
 *   - 多候选同距离时判 ambiguous，保留原值（歧义保护）
 *
 * EvoClaw 落地点：
 *   - skill-curator.ts 解析 LLM 演化建议时纠正 targetSkillIds
 *   - agent-model-executor.ts 解析 LLM 工具调用时纠正 skill_id 参数
 */

// ── 类型 ──────────────────────────────────────────────────────

export interface SkillIdCandidate {
  /** 完整 skill_id（name-uuid8 格式） */
  skillId: string;
  /** name 部分（__ 前的部分） */
  namePrefix: string;
}

export interface CorrectionResult {
  /** 原始输入 */
  original: string;
  /** 纠错后的 skill_id（如果纠正成功） */
  corrected: string | null;
  /** 是否发生了纠正 */
  wasCorrected: boolean;
  /** 是否歧义（多候选同距离） */
  ambiguous: boolean;
  /** 候选列表（用于调试） */
  candidates: Array<{ skillId: string; distance: number }>;
}

// ── 工具函数 ──────────────────────────────────────────────────

/**
 * 提取 skill_id 的 name prefix（__ 前的部分）。
 *
 * skill_id 格式：`<name>-<uuid8>` 或 `<name>__<uuid8>`
 * 例如：`pdf-extraction-fallback-9424c5` → `pdf-extraction-fallback`
 */
export function extractNamePrefix(skillId: string): string {
  // 优先按 __ 分割（OpenSpace 风格）
  const doubleUnderIndex = skillId.lastIndexOf("__");
  if (doubleUnderIndex > 0) {
    return skillId.slice(0, doubleUnderIndex);
  }

  // 退化：按最后一个 - 分割（假设 uuid8 是 8 位 hex）
  const lastDashIndex = skillId.lastIndexOf("-");
  if (lastDashIndex > 0) {
    const suffix = skillId.slice(lastDashIndex + 1);
    // 8 位 hex 模式
    if (/^[0-9a-f]{6,8}$/i.test(suffix)) {
      return skillId.slice(0, lastDashIndex);
    }
  }

  return skillId;
}

/**
 * 简化版 Levenshtein 距离（限制最大距离）。
 */
function editDistance(a: string, b: string, maxDist: number = 10): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

// ── 主函数 ────────────────────────────────────────────────────

/**
 * 纠正 LLM 输出的幻觉 skill_id。
 *
 * 算法（借鉴 OpenSpace _correct_skill_ids）：
 *   1. 如果输入完全匹配某个候选，直接返回（无需纠正）
 *   2. 按 name prefix 筛选候选
 *   3. 候选数 >20 时阈值 = 2，否则阈值 = 4
 *   4. 找出距离最小的候选
 *   5. 如果多个候选同距离，判 ambiguous，保留原值
 *
 * @param input LLM 输出的 skill_id
 * @param candidates 已注册的所有 skill_id 候选
 * @returns 纠错结果
 */
export function correctSkillId(
  input: string,
  candidates: SkillIdCandidate[],
): CorrectionResult {
  if (!input) {
    return {
      original: input,
      corrected: null,
      wasCorrected: false,
      ambiguous: false,
      candidates: [],
    };
  }

  // 1. 完全匹配，无需纠正
  const exactMatch = candidates.find((c) => c.skillId === input);
  if (exactMatch) {
    return {
      original: input,
      corrected: input,
      wasCorrected: false,
      ambiguous: false,
      candidates: [{ skillId: input, distance: 0 }],
    };
  }

  // 2. 按 name prefix 筛选
  const inputPrefix = extractNamePrefix(input);
  const prefixMatches = candidates.filter((c) => c.namePrefix === inputPrefix);

  // 3. 候选数驱动阈值
  const threshold = prefixMatches.length > 20 ? 2 : 4;

  if (prefixMatches.length === 0) {
    // name prefix 都不匹配，尝试全局最近
    const allCandidates = candidates.map((c) => ({
      skillId: c.skillId,
      distance: editDistance(input, c.skillId, threshold),
    }));

    const withinThreshold = allCandidates.filter((c) => c.distance <= threshold);
    if (withinThreshold.length === 0) {
      return {
        original: input,
        corrected: null,
        wasCorrected: false,
        ambiguous: false,
        candidates: allCandidates.sort((a, b) => a.distance - b.distance).slice(0, 5),
      };
    }

    withinThreshold.sort((a, b) => a.distance - b.distance);
    const best = withinThreshold[0];
    const sameDist = withinThreshold.filter((c) => c.distance === best.distance);

    if (sameDist.length > 1) {
      // 歧义保护
      return {
        original: input,
        corrected: null,
        wasCorrected: false,
        ambiguous: true,
        candidates: sameDist,
      };
    }

    return {
      original: input,
      corrected: best.skillId,
      wasCorrected: true,
      ambiguous: false,
      candidates: withinThreshold,
    };
  }

  // 4. 在 prefix 匹配的候选中找最近
  const distances = prefixMatches.map((c) => ({
    skillId: c.skillId,
    distance: editDistance(input, c.skillId, threshold),
  }));

  const withinThreshold = distances.filter((c) => c.distance <= threshold);
  if (withinThreshold.length === 0) {
    return {
      original: input,
      corrected: null,
      wasCorrected: false,
      ambiguous: false,
      candidates: distances.sort((a, b) => a.distance - b.distance).slice(0, 5),
    };
  }

  withinThreshold.sort((a, b) => a.distance - b.distance);
  const best = withinThreshold[0];
  const sameDist = withinThreshold.filter((c) => c.distance === best.distance);

  // 5. 歧义保护
  if (sameDist.length > 1) {
    return {
      original: input,
      corrected: null,
      wasCorrected: false,
      ambiguous: true,
      candidates: sameDist,
    };
  }

  return {
    original: input,
    corrected: best.skillId,
    wasCorrected: true,
    ambiguous: false,
    candidates: withinThreshold,
  };
}

/**
 * 批量纠正 skill_id 列表。
 *
 * @returns 纠错后的列表（ambiguous 的保留原值）
 */
export function correctSkillIds(
  inputs: string[],
  candidates: SkillIdCandidate[],
): string[] {
  return inputs.map((input) => {
    const result = correctSkillId(input, candidates);
    return result.corrected ?? input;
  });
}
