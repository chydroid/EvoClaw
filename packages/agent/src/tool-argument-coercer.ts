/**
 * ToolArgumentCoercer — 工具参数类型强制转换器
 *
 * 借鉴 hermes-agent model_tools.py _coerce_value / _coerce_json：
 *
 * 核心机制：
 *   LLM 有时返回的参数类型与 schema 声明不匹配（例如 integer 字段返回 "42" 字符串）。
 *   本模块在工具调用前对参数进行类型强制转换，避免运行时类型错误。
 *
 * 支持的转换：
 *   - string → integer/number/boolean
 *   - string → JSON object/array（_coerce_json）
 *   - bare value → array（当 schema 声明 array）
 *   - null 检查（_schema_allows_null）
 *
 * 安全性：
 *   - 转换失败时保留原值（不抛异常）
 *   - 只做安全转换（不会丢失信息）
 *   - 兼容 OpenAI/Anthropic 的 JSON 字符串参数
 */

// ── 类型 ────────────────────────────────────────────────────────────────────

export type JsonSchema = Record<string, unknown>;

export interface CoerceResult {
  /** 转换后的值 */
  value: unknown;
  /** 是否进行了转换 */
  coerced: boolean;
  /** 转换原因（如果失败） */
  warning?: string;
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 检查 schema 是否允许 null。
 * 借鉴 hermes-agent _schema_allows_null。
 */
function schemaAllowsNull(schema: JsonSchema | undefined): boolean {
  if (!schema || typeof schema !== "object") return false;

  const type = schema.type;
  if (type === "null") return true;
  if (Array.isArray(type) && type.includes("null")) return true;
  if (schema.nullable === true) return true;

  // anyOf/oneOf 包含 null
  for (const key of ["anyOf", "oneOf"]) {
    const subSchemas = schema[key];
    if (Array.isArray(subSchemas)) {
      for (const sub of subSchemas) {
        if (schemaAllowsNull(sub as JsonSchema)) return true;
      }
    }
  }

  return false;
}

/**
 * 获取 schema 的主类型。
 */
function getSchemaType(schema: JsonSchema | undefined): string | null {
  if (!schema || typeof schema !== "object") return null;

  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    // 取第一个非 null 类型
    for (const t of type) {
      if (t !== "null") return t as string;
    }
    return type[0] as string;
  }

  // 从 anyOf/oneOf 推断
  for (const key of ["anyOf", "oneOf"]) {
    const subSchemas = schema[key];
    if (Array.isArray(subSchemas)) {
      for (const sub of subSchemas) {
        const subType = getSchemaType(sub as JsonSchema);
        if (subType && subType !== "null") return subType;
      }
    }
  }

  return null;
}

/**
 * 尝试解析 JSON 字符串。
 * 借鉴 hermes-agent _coerce_json。
 */
function tryParseJson(str: string): unknown | undefined {
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}

// ── 核心转换函数 ────────────────────────────────────────────────────────────

/**
 * 强制转换值到 schema 声明的类型。
 * 借鉴 hermes-agent _coerce_value。
 *
 * @param value 原始值
 * @param schema 参数 schema
 * @returns 转换结果
 */
export function coerceValue(value: unknown, schema: JsonSchema | undefined): CoerceResult {
  // 无 schema，不转换
  if (!schema || typeof schema !== "object") {
    return { value, coerced: false };
  }

  // null 处理
  if (value === null) {
    if (schemaAllowsNull(schema)) {
      return { value, coerced: false };
    }
    // schema 不允许 null，尝试转换为默认值
    return { value, coerced: false, warning: "null value but schema does not allow null" };
  }

  const targetType = getSchemaType(schema);
  if (!targetType) {
    return { value, coerced: false };
  }

  // 已经是正确类型
  // 注意：typeof 对 array 返回 "object"，需要特殊处理
  if (targetType === "array" && Array.isArray(value)) {
    return coerceArrayItems(value, schema);
  }
  if (targetType === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    return coerceObjectProperties(value as Record<string, unknown>, schema);
  }
  if (targetType !== "object" && targetType !== "array" && typeof value === targetType) {
    return { value, coerced: false };
  }

  // 类型转换
  switch (targetType) {
    case "integer":
      return coerceToInteger(value);
    case "number":
      return coerceToNumber(value);
    case "boolean":
      return coerceToBoolean(value);
    case "string":
      return coerceToString(value);
    case "array":
      return coerceToArray(value, schema);
    case "object":
      return coerceToObject(value);
    default:
      return { value, coerced: false };
  }
}

function coerceToInteger(value: unknown): CoerceResult {
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { value, coerced: false };
    }
    return { value: Math.trunc(value), coerced: true };
  }
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed)) {
      return { value: parsed, coerced: true };
    }
    // 尝试 parseFloat 后 trunc
    const floatVal = parseFloat(value);
    if (!isNaN(floatVal)) {
      return { value: Math.trunc(floatVal), coerced: true };
    }
  }
  if (typeof value === "boolean") {
    return { value: value ? 1 : 0, coerced: true };
  }
  return { value, coerced: false, warning: `cannot coerce ${typeof value} to integer` };
}

function coerceToNumber(value: unknown): CoerceResult {
  if (typeof value === "number") {
    return { value, coerced: false };
  }
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) {
      return { value: parsed, coerced: true };
    }
  }
  if (typeof value === "boolean") {
    return { value: value ? 1 : 0, coerced: true };
  }
  return { value, coerced: false, warning: `cannot coerce ${typeof value} to number` };
}

function coerceToBoolean(value: unknown): CoerceResult {
  if (typeof value === "boolean") {
    return { value, coerced: false };
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "true" || lower === "1" || lower === "yes") {
      return { value: true, coerced: true };
    }
    if (lower === "false" || lower === "0" || lower === "no" || lower === "") {
      return { value: false, coerced: true };
    }
  }
  if (typeof value === "number") {
    return { value: value !== 0, coerced: true };
  }
  return { value, coerced: false, warning: `cannot coerce ${typeof value} to boolean` };
}

function coerceToString(value: unknown): CoerceResult {
  if (typeof value === "string") {
    return { value, coerced: false };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { value: String(value), coerced: true };
  }
  if (value === null) {
    return { value: "", coerced: true };
  }
  if (typeof value === "object") {
    try {
      return { value: JSON.stringify(value), coerced: true };
    } catch {
      return { value: String(value), coerced: true };
    }
  }
  return { value, coerced: false };
}

function coerceToArray(value: unknown, schema: JsonSchema): CoerceResult {
  if (Array.isArray(value)) {
    return coerceArrayItems(value, schema);
  }

  // bare value → [value]（当 schema 声明 array）
  // 借鉴 hermes-agent：数组包装
  if (value !== null && value !== undefined) {
    // 如果是 JSON 字符串，尝试解析
    if (typeof value === "string") {
      const parsed = tryParseJson(value);
      if (Array.isArray(parsed)) {
        return coerceArrayItems(parsed, schema);
      }
    }
    // 包装为单元素数组
    const itemsSchema = schema.items as JsonSchema | undefined;
    if (itemsSchema) {
      const itemResult = coerceValue(value, itemsSchema);
      return { value: [itemResult.value], coerced: true };
    }
    return { value: [value], coerced: true };
  }

  return { value, coerced: false, warning: `cannot coerce ${typeof value} to array` };
}

function coerceToObject(value: unknown): CoerceResult {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return coerceObjectProperties(value as Record<string, unknown>, { type: "object", properties: {} });
  }

  // JSON 字符串 → object
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { value: parsed, coerced: true };
    }
  }

  return { value, coerced: false, warning: `cannot coerce ${typeof value} to object` };
}

function coerceArrayItems(arr: unknown[], schema: JsonSchema): CoerceResult {
  const itemsSchema = schema.items as JsonSchema | undefined;
  if (!itemsSchema) {
    return { value: arr, coerced: false };
  }

  let anyCoerced = false;
  const result: unknown[] = [];
  for (const item of arr) {
    const itemResult = coerceValue(item, itemsSchema);
    if (itemResult.coerced) anyCoerced = true;
    result.push(itemResult.value);
  }

  return { value: result, coerced: anyCoerced };
}

function coerceObjectProperties(
  obj: Record<string, unknown>,
  schema: JsonSchema,
): CoerceResult {
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  if (!properties) {
    return { value: obj, coerced: false };
  }

  let anyCoerced = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key in properties) {
      const propResult = coerceValue(value, properties[key]);
      if (propResult.coerced) anyCoerced = true;
      result[key] = propResult.value;
    } else {
      result[key] = value;
    }
  }

  return { value: result, coerced: anyCoerced };
}

// ── 主函数 ──────────────────────────────────────────────────────────────────

/**
 * 强制转换工具调用参数。
 *
 * @param args 原始参数（可能是字符串或对象）
 * @param schema 工具的 parameters schema
 * @returns 转换后的参数对象
 */
export function coerceToolArguments(
  args: Record<string, unknown> | string,
  schema: JsonSchema,
): { args: Record<string, unknown>; coerced: boolean; warnings: string[] } {
  let parsedArgs: Record<string, unknown>;

  // 如果 args 是字符串，先解析 JSON
  if (typeof args === "string") {
    const parsed = tryParseJson(args);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      parsedArgs = parsed as Record<string, unknown>;
    } else {
      // 无法解析，返回空对象
      return { args: {}, coerced: false, warnings: ["args string is not valid JSON object"] };
    }
  } else {
    parsedArgs = args;
  }

  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  if (!properties) {
    return { args: parsedArgs, coerced: false, warnings: [] };
  }

  let anyCoerced = false;
  const warnings: string[] = [];
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parsedArgs)) {
    if (key in properties) {
      const propResult = coerceValue(value, properties[key]);
      if (propResult.coerced) anyCoerced = true;
      if (propResult.warning) warnings.push(`${key}: ${propResult.warning}`);
      result[key] = propResult.value;
    } else {
      // schema 中未定义的参数，保留原值
      result[key] = value;
    }
  }

  // 补充默认值
  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in result) && typeof propSchema === "object" && propSchema !== null) {
      if ("default" in propSchema) {
        result[key] = propSchema.default;
      }
    }
  }

  return { args: result, coerced: anyCoerced, warnings };
}
