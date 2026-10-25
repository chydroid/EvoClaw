/**
 * load-error-copy — 可复用的「加载失败」文案（对标 hermes web/src/lib/load-error-copy.ts）。
 *
 * 为什么抽出来：多页都面临同一问题——请求失败与「数据本身就是空的」在 UI 上无法区分，
 * 网络抖动被静默展示成「无数据」会误导用户。把文案形状抽成纯函数，便于单测且保证各页口径一致。
 *
 * 用法：
 *   const copy = loadErrorCopy(t, "LLM 提供商", err?.message);
 *   {copy.title}     → 「加载 LLM 提供商失败」
 *   {copy.details}   → 「原因: …」（失败时非 null，成功时为 null）
 */

export interface LoadErrorCopy {
  title: string;
  details: string | null;
}

/**
 * @param what    加载对象的名称（如「LLM 提供商」「会话列表」），用于填 `{what}`。
 * @param detail  可选的失败细节（error message），填 `{detail}`；为 null/空时不生成 details。
 */
export function loadErrorCopy(what: string, detail?: string | null): LoadErrorCopy {
  const w = what || "数据";
  const title = `加载${w}失败`;
  const trimmed = detail == null ? "" : String(detail).trim();
  const details = trimmed ? `原因: ${trimmed}` : null;
  return { title, details };
}