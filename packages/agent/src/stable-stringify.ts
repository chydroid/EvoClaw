/**
 * 稳定 JSON 序列化：按 key 字典序排序，保证相同语义对象输出相同字符串。
 *
 * 灵感来自 openclaw-main 的 src/agents/stable-stringify.ts。
 *
 * 用于 prompt cache：当 LLM provider 使用前缀匹配 cache 时，
 * 任何 key 顺序变化都会使 cache 失效。stable-stringify 确保
 * 即使对象内部 key 顺序不同，输出字符串也一致。
 *
 * 相比 openclaw-main 的实现，本版本增加了：
 * - topLevelKeyOrder：允许指定顶层 key 顺序
 * - dropUndefined：丢弃 undefined 值
 * - normalizeNumeric：将 NaN/Infinity 转为 null（符合 JSON 规范）
 * - replacer：自定义值转换器
 * - stableHash / stableEqual / stableDiff：辅助工具
 */

export interface StableStringifyOptions {
  /** 顶层 key 顺序（若指定则按此顺序，未列出的 key 按字典序追加） */
  topLevelKeyOrder?: string[];
  /** 是否缩进（默认无缩进，最紧凑） */
  indent?: number;
  /** 是否丢弃 undefined 值（默认 true） */
  dropUndefined?: boolean;
  /** 是否将 NaN/Infinity 转为 null（默认 true，JSON 规范） */
  normalizeNumeric?: boolean;
  /** 自定义值转换器 */
  replacer?: (key: string, value: unknown) => unknown;
}

interface InternalContext {
  opts: Required<Omit<StableStringifyOptions, "topLevelKeyOrder" | "replacer">>;
  topLevelKeyOrder?: string[];
  replacer?: (key: string, value: unknown) => unknown;
  stack: WeakSet<object>;
  depth: number;
}

const MAX_DEPTH = 100;

/**
 * 稳定 JSON 序列化。
 *
 * @param value 待序列化的值
 * @param opts 选项
 * @returns 稳定的 JSON 字符串
 */
export function stableStringify(
  value: unknown,
  opts?: StableStringifyOptions,
): string {
  const ctx: InternalContext = {
    opts: {
      indent: opts?.indent ?? 0,
      dropUndefined: opts?.dropUndefined ?? true,
      normalizeNumeric: opts?.normalizeNumeric ?? true,
    },
    topLevelKeyOrder: opts?.topLevelKeyOrder,
    replacer: opts?.replacer,
    stack: new WeakSet<object>(),
    depth: 0,
  };
  return stringifyValue(value, "", ctx);
}

function stringifyValue(
  value: unknown,
  key: string,
  ctx: InternalContext,
): string {
  // 应用 replacer
  if (ctx.replacer) {
    value = ctx.replacer(key, value);
  }

  // 1. undefined
  if (value === undefined) {
    return ctx.opts.dropUndefined ? "" : "null";
  }

  // 2. null
  if (value === null) {
    return "null";
  }

  // 3. string / boolean
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  // 4. number
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return ctx.opts.normalizeNumeric ? "null" : JSON.stringify(String(value));
    }
    return JSON.stringify(value);
  }

  // 5. bigint → 字符串（JSON 不支持 bigint）
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }

  // 6. symbol / function → 丢弃（按 undefined 处理）
  if (typeof value === "symbol" || typeof value === "function") {
    return ctx.opts.dropUndefined ? "" : "null";
  }

  // 深度保护，防止无限递归
  if (ctx.depth >= MAX_DEPTH) {
    return "null";
  }

  // 7. 数组
  if (Array.isArray(value)) {
    return stringifyArray(value, ctx);
  }

  // 8. 对象
  if (typeof value === "object") {
    return stringifyObject(value, ctx);
  }

  // 兜底
  return "null";
}

function stringifyArray(arr: unknown[], ctx: InternalContext): string {
  if (ctx.stack.has(arr as object)) {
    return JSON.stringify("[Circular]");
  }
  ctx.stack.add(arr as object);
  ctx.depth++;

  try {
    const parts: string[] = [];
    for (let i = 0; i < arr.length; i++) {
      const s = stringifyValue(arr[i], String(i), ctx);
      // 数组元素：undefined → null（保持索引位置）
      parts.push(s === "" ? "null" : s);
    }
    if (ctx.opts.indent > 0) {
      return `[${parts.length > 0 ? "\n" : ""}${parts
        .map((p) => indent(p, ctx.opts.indent, 1))
        .join(",\n")}${parts.length > 0 ? "\n" : ""}]`;
    }
    return `[${parts.join(",")}]`;
  } finally {
    ctx.stack.delete(arr as object);
    ctx.depth--;
  }
}

function stringifyObject(
  obj: object,
  ctx: InternalContext,
): string {
  if (ctx.stack.has(obj)) {
    return JSON.stringify("[Circular]");
  }
  ctx.stack.add(obj);
  ctx.depth++;

  try {
    const record = obj as Record<string, unknown>;

    // Error → 提取 name/message/stack
    if (obj instanceof Error) {
      const errObj: Record<string, unknown> = {
        name: (obj as Error).name,
        message: (obj as Error).message,
        stack: (obj as Error).stack,
      };
      // 不递归到原 Error（避免循环），直接序列化提取后的字段
      ctx.stack.delete(obj);
      return stringifyObject(errObj, ctx);
    }

    // Uint8Array → base64
    if (obj instanceof Uint8Array) {
      const bufObj: Record<string, unknown> = {
        type: "Uint8Array",
        data: Buffer.from(obj).toString("base64"),
      };
      ctx.stack.delete(obj);
      return stringifyObject(bufObj, ctx);
    }

    // Date → ISO 字符串
    if (obj instanceof Date) {
      return JSON.stringify(obj.toISOString());
    }

    // Map → 转为 entries 数组（按 key 字典序）
    if (obj instanceof Map) {
      const entries = Array.from(obj.entries()).sort((a, b) =>
        String(a[0]).localeCompare(String(b[0])),
      );
      const mapObj: Record<string, unknown> = {};
      for (const [k, v] of entries) {
        mapObj[String(k)] = v;
      }
      ctx.stack.delete(obj);
      return stringifyObject(mapObj, ctx);
    }

    // Set → 转为数组（已唯一）
    if (obj instanceof Set) {
      const arr = Array.from(obj);
      ctx.stack.delete(obj);
      return stringifyArray(arr, ctx);
    }

    // 收集所有可枚举 own keys
    const allKeys = Object.keys(record);

    // 过滤 undefined（若启用）
    const filteredKeys = ctx.opts.dropUndefined
      ? allKeys.filter((k) => record[k] !== undefined)
      : allKeys;

    // 排序：顶层使用 topLevelKeyOrder，其他按字典序
    const isTopLevel = ctx.depth === 1;
    const sortedKeys = sortKeys(filteredKeys, isTopLevel, ctx.topLevelKeyOrder);

    const parts: string[] = [];
    for (const k of sortedKeys) {
      const s = stringifyValue(record[k], k, ctx);
      if (s === "") continue; // dropUndefined 已在 stringifyValue 内处理
      parts.push(`${JSON.stringify(k)}:${ctx.opts.indent > 0 ? " " : ""}${s}`);
    }

    if (ctx.opts.indent > 0) {
      return `{${parts.length > 0 ? "\n" : ""}${parts
        .map((p) => indent(p, ctx.opts.indent, 1))
        .join(",\n")}${parts.length > 0 ? "\n" : ""}}`;
    }
    return `{${parts.join(",")}}`;
  } finally {
    ctx.stack.delete(obj);
    ctx.depth--;
  }
}

function sortKeys(
  keys: string[],
  isTopLevel: boolean,
  topLevelKeyOrder?: string[],
): string[] {
  if (!isTopLevel || !topLevelKeyOrder || topLevelKeyOrder.length === 0) {
    return [...keys].sort((a, b) => a.localeCompare(b));
  }
  const ordered: string[] = [];
  const used = new Set<string>();
  for (const k of topLevelKeyOrder) {
    if (keys.includes(k)) {
      ordered.push(k);
      used.add(k);
    }
  }
  const rest = keys.filter((k) => !used.has(k)).sort((a, b) => a.localeCompare(b));
  return [...ordered, ...rest];
}

function indent(str: string, indent: number, depth: number): string {
  const pad = " ".repeat(indent * depth);
  return str
    .split("\n")
    .map((line, i) => (i === 0 ? pad + line : pad + line))
    .join("\n");
}

/**
 * 计算对象的稳定 hash（用于 cache key）。
 *
 * 使用 djb2 + 长度后缀，与 prompt-cache.ts 保持一致。
 * 注意：非加密安全，但作为内存缓存 key 足够。
 *
 * @param value 待哈希的值
 * @param opts 序列化选项
 * @returns 稳定的 hash 字符串
 */
export function stableHash(
  value: unknown,
  opts?: StableStringifyOptions,
): string {
  const str = stableStringify(value, opts);
  if (str.length === 0) return "0:0";
  // djb2 + 长度后缀
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return `${hash.toString(36)}:${str.length.toString(36)}`;
}

/**
 * 比较两个对象是否语义相等（用 stableStringify）。
 *
 * @param a 对象 a
 * @param b 对象 b
 * @param opts 序列化选项
 * @returns true 表示语义相等
 */
export function stableEqual(
  a: unknown,
  b: unknown,
  opts?: StableStringifyOptions,
): boolean {
  return stableStringify(a, opts) === stableStringify(b, opts);
}

/**
 * 找出两个对象之间的差异（用于 cache 失效诊断）。
 * 返回路径列表，每个路径指向有差异的字段。
 *
 * @param oldObj 旧对象
 * @param newObj 新对象
 * @param basePath 基础路径前缀（递归用）
 * @returns 差异列表
 */
export interface StableDiffResult {
  path: string; // 差异路径（如 "messages[2].content"）
  type: "added" | "removed" | "changed";
  oldValue?: unknown;
  newValue?: unknown;
}

export function stableDiff(
  oldObj: unknown,
  newObj: unknown,
  basePath?: string,
): StableDiffResult[] {
  const results: StableDiffResult[] = [];
  const base = basePath ?? "";
  diffRecursive(oldObj, newObj, base, results);
  return results;
}

function diffRecursive(
  oldVal: unknown,
  newVal: unknown,
  path: string,
  results: StableDiffResult[],
): void {
  // 类型不同（且都不是 null）
  const oldType = oldVal === null ? "null" : typeof oldVal;
  const newType = newVal === null ? "null" : typeof newVal;
  const oldIsObj = oldVal !== null && typeof oldVal === "object";
  const newIsObj = newVal !== null && typeof newVal === "object";

  if (!oldIsObj && !newIsObj) {
    // 基础类型比较
    if (oldVal !== newVal) {
      results.push({
        path,
        type: "changed",
        oldValue: oldVal,
        newValue: newVal,
      });
    }
    return;
  }

  // 一边是对象/数组，另一边不是 → changed
  if (oldIsObj !== newIsObj) {
    results.push({
      path,
      type: "changed",
      oldValue: oldVal,
      newValue: newVal,
    });
    return;
  }

  // 都是数组
  if (Array.isArray(oldVal) && Array.isArray(newVal)) {
    const maxLen = Math.max(oldVal.length, newVal.length);
    for (let i = 0; i < maxLen; i++) {
      const subPath = `${path}[${i}]`;
      if (i >= oldVal.length) {
        results.push({ path: subPath, type: "added", newValue: newVal[i] });
      } else if (i >= newVal.length) {
        results.push({ path: subPath, type: "removed", oldValue: oldVal[i] });
      } else {
        diffRecursive(oldVal[i], newVal[i], subPath, results);
      }
    }
    return;
  }

  // 一个是数组一个是对象 → changed
  if (Array.isArray(oldVal) !== Array.isArray(newVal)) {
    results.push({
      path,
      type: "changed",
      oldValue: oldVal,
      newValue: newVal,
    });
    return;
  }

  // 都是对象
  const oldRec = oldVal as Record<string, unknown>;
  const newRec = newVal as Record<string, unknown>;
  const allKeys = new Set<string>([
    ...Object.keys(oldRec),
    ...Object.keys(newRec),
  ]);

  for (const k of allKeys) {
    const subPath = path ? `${path}.${k}` : k;
    const inOld = Object.prototype.hasOwnProperty.call(oldRec, k);
    const inNew = Object.prototype.hasOwnProperty.call(newRec, k);
    if (!inOld && inNew) {
      results.push({ path: subPath, type: "added", newValue: newRec[k] });
    } else if (inOld && !inNew) {
      results.push({ path: subPath, type: "removed", oldValue: oldRec[k] });
    } else {
      diffRecursive(oldRec[k], newRec[k], subPath, results);
    }
  }
}
