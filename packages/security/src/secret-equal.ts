// 常量时间字符串比较 — 防 timing attack。
// 用于比较 secret / token / password / API key，避免通过响应时间差推断字符。
//
// 与 node:crypto.timingSafeEqual 的差异：
//   - timingSafeEqual 要求等长 Buffer，否则抛出异常（长度信息会泄露）
//   - secretEqual 允许任意长度字符串，长度不同时也消耗相同时间
//
// 灵感来自 openclaw-main 的 src/security/secret-equal.ts，但 EvoClaw 自行实现
// 字符比较以支持不等长字符串，不依赖 crypto.timingSafeEqual。

/**
 * 常量时间字符串比较。
 *
 * 算法：
 *   1. 取两字符串长度的最大值 maxLen，无论长度是否相同都遍历 maxLen 次
 *   2. 用异或累积每位的差异（不短路）
 *   3. 长度差异也异或到差异标记
 *   4. 当且仅当差异为 0 且长度相等时返回 true
 *
 * 注意：lengthMismatch 不直接返回 false，而是合并到 diff 中，确保长度差异
 * 路径与内容差异路径消耗相同时间。
 *
 * @param a 待比较的字符串（如用户提供的 token）
 * @param b 期望的字符串（如存储的 token）
 * @returns 两字符串是否相等
 */
export function secretEqual(a: string, b: string): boolean {
  // 长度先缓存到局部变量，避免在循环中重复访问属性
  const aLen = a.length;
  const bLen = b.length;
  const maxLen = aLen > bLen ? aLen : bLen;

  let diff = 0;

  // 遍历 maxLen 次：超出自身长度的位置取 0
  for (let i = 0; i < maxLen; i++) {
    const ac = i < aLen ? a.charCodeAt(i) : 0;
    const bc = i < bLen ? b.charCodeAt(i) : 0;
    diff |= ac ^ bc;
  }

  // 长度差异也合并到 diff（异或：长度相等时为 0，不等时为非 0）
  diff |= aLen ^ bLen;

  return diff === 0;
}

/**
 * 常量时间 Buffer 比较。
 *
 * 与 crypto.timingSafeEqual 行为相似但更宽容：允许不等长 Buffer，
 * 长度不同时也消耗相同时间。
 *
 * @param a 待比较的 Buffer
 * @param b 期望的 Buffer
 * @returns 两 Buffer 内容是否相等
 */
export function secretEqualBuffer(a: Buffer, b: Buffer): boolean {
  const aLen = a.length;
  const bLen = b.length;
  const maxLen = aLen > bLen ? aLen : bLen;

  let diff = 0;

  for (let i = 0; i < maxLen; i++) {
    const ab = i < aLen ? a[i] : 0;
    const bb = i < bLen ? b[i] : 0;
    diff |= ab ^ bb;
  }

  diff |= aLen ^ bLen;

  return diff === 0;
}

/**
 * 常量时间比较可选字符串。
 *
 * 当任一参数为 null/undefined 时返回 false（不泄露是哪一侧为空）。
 * 适用于处理来自配置的密钥（可能未设置）。
 *
 * @param provided 用户提供的值
 * @param expected 期望的值
 * @returns 是否相等；任一为空时返回 false
 */
export function safeEqualSecret(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  // 任一非字符串都返回 false；不区分"未提供"和"提供了空字符串"，
  // 避免通过响应时间泄露 expected 是否为空。
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  return secretEqual(provided, expected);
}

/**
 * 常量时间比较可选 Buffer。
 *
 * 与 safeEqualSecret 对应，处理 Buffer 版本。
 *
 * @param provided 用户提供的 Buffer
 * @param expected 期望的 Buffer
 * @returns 是否相等；任一为空时返回 false
 */
export function safeEqualSecretBuffer(
  provided: Buffer | null | undefined,
  expected: Buffer | null | undefined,
): boolean {
  if (!Buffer.isBuffer(provided) || !Buffer.isBuffer(expected)) {
    return false;
  }
  return secretEqualBuffer(provided, expected);
}
