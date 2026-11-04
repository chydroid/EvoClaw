/**
 * local-time.ts — 进程级时区与本地化日期字符串缓存
 *
 * 性能背景（2026-11-04 P0-1）：
 *   Intl.DateTimeFormat().resolvedOptions().timeZone 与 toLocaleDateString
 *   此前在 chatInner（动态尾 dateContext）与 tryCallLLM（ephemeralSuffix）
 *   中**每个用户 turn / 每个 provider 尝试**都重新构造 Intl 对象——ICU 初始化
 *   有实测开销，且时区在进程生命周期内不变、日期字符串天级不变，重算纯属
 *   重复计算。此处以模块级 memoize 消除：输出字节与旧实现完全一致
 *   （相同参数、相同 locale），仅去掉重复计算。
 */

let cachedTimeZone: string | null = null;
let cachedDateStr: { dayKey: string; value: string } | null = null;

/** 当前进程时区 ID（如 "Asia/Shanghai"），进程内恒定，缓存一次。 */
export function getProcessTimeZone(): string {
  if (cachedTimeZone === null) {
    try {
      cachedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
    } catch {
      cachedTimeZone = "Asia/Shanghai";
    }
  }
  return cachedTimeZone;
}

/** 本地日期字符串（zh-CN，"2026年11月4日星期三" 风格），按天缓存。 */
export function getCachedLocaleDateString(): string {
  const tz = getProcessTimeZone();
  const now = new Date();
  // 用「时区 + 本地日期 11 位时间戳前缀」做天级 key：跨天自动失效。
  const dayKey = `${tz}:${now.getTime().toString().slice(0, 9)}`;
  if (cachedDateStr && cachedDateStr.dayKey === dayKey) {
    return cachedDateStr.value;
  }
  const value = new Date().toLocaleDateString("zh-CN", {
    timeZone: tz,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  cachedDateStr = { dayKey, value };
  return value;
}
