// ReDoS 防护：检测指数级回溯风险的正则表达式。
//
// 检测模式：
//   1. 嵌套量词（如 (a+)+, (a*)*, (a+)*b）
//   2. 重叠量词（如 a+a+, a*a*）
//   3. 量词后跟自身（如 (a|a)+）
//   4. 通配符 + 量词（如 .*.*）
//   5. 嵌套捕获组 + 量词
//
// 灵感来自 openclaw-main 的 src/security/safe-regex.ts 与 safe-regex npm 包，
// 但 EvoClaw 实现更简洁：先用启发式规则识别风险，再估算回溯上界。
// 非目标：完整 regex AST 解析；保持保守的"宁可误报不可漏报"原则。

/** 风险等级 */
export type RegexRisk = "low" | "medium" | "high" | "critical";

/** 正则安全检测结果 */
export interface RegexSafetyResult {
  /** 是否安全（risk 为 low/medium 时为 true） */
  safe: boolean;
  /** 风险等级 */
  risk: RegexRisk;
  /** 具体问题描述列表 */
  issues: string[];
  /** 估算的最大回溯步数 */
  estimatedBacktracking: number;
}

// 量词字符：+ * ? {n} {n,} {n,m}
const QUANTIFIER_PATTERN = /[+*?]|\{(\d+)(,(\d+)?)?\}/;

/**
 * 提取正则源字符串。
 * 同时支持字符串与 RegExp 输入。
 */
function toSource(pattern: string | RegExp): string {
  if (pattern instanceof RegExp) {
    return pattern.source;
  }
  return pattern;
}

/**
 * 移除字符类 [abc] 与转义序列 \. \d 等的内容，避免误报。
 * 替换为单字符占位 "X"（仍可触发后续量词检测，但字符类内部量词不再被识别）。
 */
function stripClassesAndEscapes(source: string): string {
  let result = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    // 转义：跳过下一字符，用占位 "X" 代替（保留量词可识别）
    if (ch === "\\") {
      result += "X";
      i += 2;
      continue;
    }

    // 字符类：跳过到 ]，用占位 "X" 代替
    if (ch === "[") {
      let depth = 1;
      i += 1;
      while (i < source.length && depth > 0) {
        const inner = source[i];
        if (inner === "\\") {
          i += 2;
          continue;
        }
        if (inner === "[") depth += 1;
        if (inner === "]") depth -= 1;
        i += 1;
      }
      result += "X";
      continue;
    }

    result += ch;
    i += 1;
  }
  return result;
}

/**
 * 检测嵌套量词模式：量词紧接另一个量词（如 a++ / a*+ / a{2,3}*）。
 * 这是 ReDoS 最常见的指数级回溯来源。
 */
function detectNestedQuantifiers(stripped: string): string[] {
  const issues: string[] = [];
  // 匹配：(group)+ 后接量词，或 token+ 后接量词
  // 嵌套量词模式：[:+*?{] 后紧跟 [+*?{]
  const nestedPattern = /[+*?}][+*?{]/g;
  let m: RegExpExecArray | null;
  while ((m = nestedPattern.exec(stripped)) !== null) {
    issues.push(
      `嵌套量词 "${m[0]}" 位于位置 ${m.index}（可能导致指数级回溯）`,
    );
  }
  // 形如 (a+)+ 的模式：组内含 +/* 后组外跟 +/*
  const groupNestedPattern = /\([^)]*[+*?][^)]*\)[+*?]/g;
  while ((m = groupNestedPattern.exec(stripped)) !== null) {
    issues.push(
      `分组内量词后紧跟组外量词 "${m[0]}" 位于位置 ${m.index}`,
    );
  }
  return issues;
}

/**
 * 检测重叠量词：相同 token 紧邻重复（如 a+a+, a*a*）。
 */
function detectOverlappingQuantifiers(stripped: string): string[] {
  const issues: string[] = [];
  // 形如 X+X+ 或 X*X*（X 为单字符或转义占位）
  const overlapPattern = /(\w)[+*?]\1[+*?]/g;
  let m: RegExpExecArray | null;
  while ((m = overlapPattern.exec(stripped)) !== null) {
    issues.push(
      `重叠量词 "${m[0]}" 位于位置 ${m.index}（同一字符重复量化）`,
    );
  }
  return issues;
}

/**
 * 检测通配符 + 量词组合（如 .*.*）。
 */
function detectWildcardQuantifiers(source: string): string[] {
  const issues: string[] = [];
  // 原始 source 中查找 .+ . .* 或 .{n,} 后跟相同模式
  const wildcardPattern = /\.[+*]\.*[+*]/g;
  let m: RegExpExecArray | null;
  while ((m = wildcardPattern.exec(source)) !== null) {
    issues.push(
      `通配符 + 量词 "${m[0]}" 位于位置 ${m.index}（ catastrophic backtracking 来源）`,
    );
  }
  return issues;
}

/**
 * 检测歧义交替 + 量词：形如 (a|a)+ 的模式中，分支可匹配相同文本，
 * 引发指数级回溯。
 */
function detectAmbiguousAlternation(stripped: string): string[] {
  const issues: string[] = [];
  // 形如 (a|a)+ 或 (ab|ab)* 的简单情形
  const altPattern = /\(([^|()]+)\|(\1)\)[+*?]/g;
  let m: RegExpExecArray | null;
  while ((m = altPattern.exec(stripped)) !== null) {
    issues.push(
      `歧义交替 "${m[0]}" 位于位置 ${m.index}（分支匹配相同文本）`,
    );
  }
  return issues;
}

/**
 * 估算最大回溯步数。
 *
 * 基于量词嵌套深度：每个嵌套量词乘以典型回溯因子 100。
 * - 无量词：1
 * - 单量词：100
 * - 嵌套 1 层：100^2 = 10^4
 * - 嵌套 2 层：100^3 = 10^6（high）
 * - 嵌套 3 层：100^4 = 10^8（critical）
 */
function estimateBacktracking(stripped: string): number {
  // 计算嵌套深度：找出所有量词位置，看相邻量词的距离
  const quantifierPositions: number[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "+" || ch === "*" || ch === "?") {
      quantifierPositions.push(i);
    } else if (ch === "{") {
      // 简化处理：将 {n,m} 视为一个量词位置
      quantifierPositions.push(i);
    }
  }

  if (quantifierPositions.length === 0) return 1;

  // 计算嵌套深度：相邻量词位置差 < 3 视为嵌套
  let depth = 1;
  for (let i = 1; i < quantifierPositions.length; i++) {
    if (quantifierPositions[i] - quantifierPositions[i - 1] < 3) {
      depth += 1;
    }
  }

  // 100^depth
  let result = 1;
  for (let i = 0; i < depth; i++) {
    result *= 100;
    // 防止溢出
    if (result > 1e12) return 1e12;
  }
  return result;
}

/**
 * 根据问题数量与回溯上界判定风险等级。
 *
 * 启发式：只要检测到 ReDoS 模式（issues > 0），就视为 high；
 * 因为这些模式都是已知的 catastrophic backtracking 来源。
 * 回溯上界用于进一步升级到 critical。
 */
function classifyRisk(
  issueCount: number,
  backtracking: number,
): RegexRisk {
  if (backtracking >= 1e8 || issueCount >= 3) return "critical";
  if (issueCount >= 1 || backtracking >= 1e6) return "high";
  if (backtracking >= 1e4) return "medium";
  return "low";
}

/**
 * 检测正则的 ReDoS 风险。
 *
 * @param pattern 字符串或 RegExp 实例
 * @returns 安全检测结果
 */
export function checkRegexSafety(pattern: string | RegExp): RegexSafetyResult {
  const source = toSource(pattern);
  const issues: string[] = [];

  // 空字符串视为安全
  if (source.length === 0) {
    return {
      safe: true,
      risk: "low",
      issues: [],
      estimatedBacktracking: 1,
    };
  }

  const stripped = stripClassesAndEscapes(source);

  // 按优先级顺序检测各种 ReDoS 模式
  issues.push(...detectNestedQuantifiers(stripped));
  issues.push(...detectOverlappingQuantifiers(stripped));
  issues.push(...detectWildcardQuantifiers(source));
  issues.push(...detectAmbiguousAlternation(stripped));

  const estimatedBacktracking = estimateBacktracking(stripped);
  const risk = classifyRisk(issues.length, estimatedBacktracking);

  return {
    safe: risk === "low" || risk === "medium",
    risk,
    issues,
    estimatedBacktracking,
  };
}

/**
 * 安全构造正则：如果检测到 ReDoS 风险（high/critical），抛出错误。
 *
 * @param pattern 正则源
 * @param flags 标志位（如 "i", "g", "m"）
 * @returns 编译后的 RegExp
 * @throws 当 risk 为 high/critical 时抛出错误
 */
export function safeRegExp(pattern: string, flags?: string): RegExp {
  const result = checkRegexSafety(pattern);
  if (result.risk === "high" || result.risk === "critical") {
    throw new Error(
      `Unsafe regex (risk=${result.risk}): ${result.issues.join("; ")}`,
    );
  }
  return new RegExp(pattern, flags);
}

/**
 * 判断正则是否为 ReDoS 风险（便捷封装）。
 *
 * @param pattern 字符串或 RegExp 实例
 * @returns 是否有 high/critical 风险
 */
export function isUnsafeRegex(pattern: string | RegExp): boolean {
  const result = checkRegexSafety(pattern);
  return result.risk === "high" || result.risk === "critical";
}
