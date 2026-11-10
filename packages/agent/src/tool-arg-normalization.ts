/**
 * 工具参数归一化：action 枚举取值容错。
 *
 * 背景（v10 Task 6，2026-11-10）：模型偶尔把枚举取值写坏，混入换行与伪 XML
 * 尾巴——实测 `file_write` 收到
 * `"create\n</parameter=overwrite>\ntrue"`（path/content 均合法）。
 * 各工具 handler 用严格 `===` 判别 action，坏值让整条调用报废且报错样式不一。
 *
 * 这里在**工具调用汇合点**统一做「首 token」归一化：
 *   1. 取值与枚举精确相等 → 原样放行；
 *   2. 否则取首个字母/数字/下划线/连字符 token（大小写不敏感）再与枚举比对；
 *   3. 命中 → 改写 action（handler 照常执行）；未命中 → 保留原值交 handler 报错。
 *
 * 只处理 `action` 一个键：它是复合工具的动作判别字段；其余参数不做猜测性
 * 改写，避免掩盖真实的参数错误。
 */
export interface ActionNormalizationResult {
  /** 归一化后的参数（未改写时为原对象引用） */
  args: Record<string, unknown>;
  /** 发生改写时为原始取值；未改写为 undefined */
  rewrittenFrom?: string;
  /** 发生改写时为归一化后的取值 */
  rewrittenTo?: string;
}

export function normalizeToolActionArg(
  definition: { parameters?: Record<string, unknown> } | undefined,
  args: Record<string, unknown>,
): ActionNormalizationResult {
  const actionParam = definition?.parameters?.action;
  if (!actionParam || typeof actionParam !== "object") return { args };
  const enumValues = (actionParam as { enum?: unknown }).enum;
  if (!Array.isArray(enumValues)) return { args };
  const allowed = enumValues.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (allowed.length === 0) return { args };

  const raw = args.action;
  if (typeof raw !== "string" || allowed.includes(raw)) return { args };

  const token = /^[a-z0-9_-]+/i.exec(raw.trim())?.[0]?.toLowerCase();
  if (!token) return { args };
  const match = allowed.find((v) => v.toLowerCase() === token);
  if (!match) return { args };

  return { args: { ...args, action: match }, rewrittenFrom: raw, rewrittenTo: match };
}
