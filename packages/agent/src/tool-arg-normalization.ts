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
 * 改写，避免掩盖真实的参数错误（高频**别名**见文件末尾 normalizeToolArgumentAliases）。
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

/**
 * 常见参数**别名**归一化（hermes 对齐 R12）。
 *
 * 背景：模型常按其它 agent 框架/历史工具的直接习惯传参——
 *   - shell_exec 传 `workdir`（hermes terminal 的字段名）而本工具用 `cwd`；
 *   - file_* 传 `file_path` / `filepath`（Claude Code 风格）而本工具用 `path`。
 * 这些多余字段不会被参数校验拒绝（校验只检查已声明参数），结果是**静默**
 * 按默认值执行：命令在 workspace 根而不是目标目录运行、file_read 报缺失
 * `path`。前者会产出误导性结果，比报错更糟。
 *
 * 仅在规范键缺失/为空、且别名键有非空字符串时复制，绝不覆盖模型显式值；
 * 映射表保持窄（只列真实高频别名），避免猜测性改写掩盖参数错误。
 */
const TOOL_ARG_ALIASES: Record<string, Record<string, readonly string[]>> = {
  shell_exec: {
    cwd: ["workdir", "working_dir", "workingDirectory", "workdirPath", "dir", "directory"],
    command: ["cmd"],
    timeout: ["timeout_seconds", "timeoutSec"],
  },
  execute_code: {
    timeout: ["timeout_seconds", "timeoutSec"],
  },
  file_read: { path: ["file_path", "filepath", "filePath", "filename"] },
  file_write: { path: ["file_path", "filepath", "filePath", "filename"] },
  file_delete: { path: ["file_path", "filepath", "filePath", "filename"] },
  file_list: { path: ["dir", "directory", "folder", "file_path", "filePath"] },
};

export interface ArgumentAliasApplication {
  from: string;
  to: string;
}

export interface ArgumentAliasResult {
  /** 归一化后的参数（未改写时为原对象引用） */
  args: Record<string, unknown>;
  /** 实际应用的别名映射（供日志/测试） */
  applied: ArgumentAliasApplication[];
}

export function normalizeToolArgumentAliases(
  toolName: string,
  args: Record<string, unknown>,
): ArgumentAliasResult {
  const mapping = TOOL_ARG_ALIASES[toolName];
  if (!mapping) return { args, applied: [] };

  const present = (value: unknown): boolean =>
    typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;

  let next = args;
  const applied: ArgumentAliasApplication[] = [];
  for (const [canonical, aliases] of Object.entries(mapping)) {
    if (present(next[canonical])) continue;
    const hit = aliases.find((alias) => present(next[alias]));
    if (!hit) continue;
    if (next === args) next = { ...args };
    next[canonical] = next[hit];
    applied.push({ from: hit, to: canonical });
  }
  return { args: next, applied };
}
