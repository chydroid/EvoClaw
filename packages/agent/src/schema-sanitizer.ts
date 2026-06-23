/**
 * SchemaSanitizer — JSON Schema 清洗器（多后端兼容）
 *
 * 借鉴 hermes-agent tools/schema_sanitizer.py：
 *
 * 核心机制：
 *   针对不同 LLM 后端的 schema 限制进行反应式清洗。
 *   - llama.cpp：grammar-parse 失败时剥离 pattern/format
 *   - OpenAI Codex：剥离顶层 allOf/anyOf/oneOf/enum/not
 *   - Fireworks：剥离 $ref 旁边的 default
 *   - xAI Responses：剥离含 / 的 enum
 *   - Anthropic：折叠 anyOf/oneOf 可空联合类型
 *
 * 清洗函数：
 *   - sanitizeToolSchemas(tools) — 主入口
 *   - stripNullableUnions — 折叠 anyOf/oneOf 可空联合类型
 *   - stripTopLevelCombinators — 剥离顶层 allOf/anyOf/oneOf/enum/not
 *   - stripRefSiblings — 剥离 $ref 旁边的 default
 *   - stripPatternAndFormat — 反应式清洗（llama.cpp 兼容）
 *   - stripSlashEnum — 剥离含 / 的 enum（xAI 兼容）
 */

// ── 类型 ────────────────────────────────────────────────────────────────────

export type JsonSchema = Record<string, unknown>;

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: JsonSchema;
  };
}

export type BackendType =
  | "openai"
  | "anthropic"
  | "google"
  | "openai-codex"
  | "fireworks"
  | "xai"
  | "llama-cpp"
  | "ollama"
  | "generic";

export interface SanitizeOptions {
  /** 目标后端 */
  backend?: BackendType;
  /** 是否剥离 pattern/format（llama.cpp 兼容） */
  stripPatternFormat?: boolean;
  /** 是否剥离含 / 的 enum（xAI 兼容） */
  stripSlashEnum?: boolean;
  /** 是否剥离顶层组合器（OpenAI Codex 兼容） */
  stripTopLevelCombinators?: boolean;
  /** 是否剥离 $ref 兄弟（Fireworks 兼容） */
  stripRefSiblings?: boolean;
  /** 是否折叠可空联合（Anthropic 兼容） */
  stripNullableUnions?: boolean;
}

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 顶层禁止的关键字（OpenAI Codex 不支持） */
const TOP_LEVEL_FORBIDDEN_KEYS = ["allOf", "anyOf", "oneOf", "enum", "not"];

/** $ref 旁边禁止的兄弟关键字（Fireworks 不支持） */
const REF_FORBIDDEN_SIBLINGS = new Set(["default"]);

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 深拷贝 JSON Schema。
 */
function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(deepClone) as unknown as T;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = deepClone(value);
  }
  return result as unknown as T;
}

/**
 * 检查 schema 是否允许 null。
 * 借鉴 hermes-agent _schema_allows_null：
 *   - type 包含 null
 *   - nullable: true
 *   - anyOf/oneOf 包含 null 类型
 */
function schemaAllowsNull(schema: JsonSchema): boolean {
  if (!schema || typeof schema !== "object") return false;

  // type: null 或 type: ["string", "null"]
  const type = schema.type;
  if (type === "null") return true;
  if (Array.isArray(type) && type.includes("null")) return true;

  // nullable: true（OpenAPI 3.0 风格）
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

// ── 清洗函数 ────────────────────────────────────────────────────────────────

/**
 * 折叠 anyOf/oneOf 可空联合类型。
 * 借鉴 hermes-agent strip_nullable_unions：
 *   [T, null] → T（保留 type，移除 anyOf/oneOf）
 *
 * Anthropic 不支持 anyOf/oneOf，需要折叠可空联合。
 */
function stripNullableUnionsImpl(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== "object") return schema;

  for (const key of ["anyOf", "oneOf"]) {
    const subSchemas = schema[key];
    if (!Array.isArray(subSchemas)) continue;

    // 检查是否是可空联合（恰好 2 个子 schema，其中一个是 null）
    if (subSchemas.length === 2) {
      const [a, b] = subSchemas as JsonSchema[];
      const aNull = schemaAllowsNull(a);
      const bNull = schemaAllowsNull(b);

      if (aNull && !bNull) {
        // [null, T] → T
        const nonNull = b;
        const result = { ...schema };
        delete result[key];
        // 合并非 null 子 schema 的属性
        for (const [k, v] of Object.entries(nonNull)) {
          if (!(k in result)) {
            result[k] = v;
          }
        }
        // 递归处理子属性
        return stripNullableUnionsImpl(result);
      }
      if (bNull && !aNull) {
        // [T, null] → T
        const nonNull = a;
        const result = { ...schema };
        delete result[key];
        for (const [k, v] of Object.entries(nonNull)) {
          if (!(k in result)) {
            result[k] = v;
          }
        }
        return stripNullableUnionsImpl(result);
      }
    }
  }

  // 递归处理子属性
  const result: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "properties" && typeof v === "object" && v !== null) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(v as Record<string, unknown>)) {
        props[propName] = stripNullableUnionsImpl(propSchema as JsonSchema);
      }
      result[k] = props;
    } else if (k === "items" && typeof v === "object" && v !== null) {
      result[k] = stripNullableUnionsImpl(v as JsonSchema);
    } else if (Array.isArray(v) && (k === "allOf" || k === "anyOf" || k === "oneOf")) {
      result[k] = v.map((item) => stripNullableUnionsImpl(item as JsonSchema));
    } else {
      result[k] = v;
    }
  }

  return result;
}

/**
 * 剥离顶层组合器。
 * 借鉴 hermes-agent _strip_top_level_combinators：
 *   OpenAI Codex 不支持顶层 allOf/anyOf/oneOf/enum/not。
 */
function stripTopLevelCombinatorsImpl(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== "object") return schema;

  const result = { ...schema };
  for (const key of TOP_LEVEL_FORBIDDEN_KEYS) {
    delete result[key];
  }
  return result;
}

/**
 * 剥离 $ref 旁边的兄弟关键字。
 * 借鉴 hermes-agent _strip_ref_siblings：
 *   Fireworks 不支持 $ref 旁边有 default。
 */
function stripRefSiblingsImpl(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== "object") return schema;

  const result: JsonSchema = {};
  const hasRef = "$ref" in schema;

  for (const [k, v] of Object.entries(schema)) {
    if (hasRef && REF_FORBIDDEN_SIBLINGS.has(k)) {
      // 跳过 $ref 旁边的禁止兄弟
      continue;
    }

    // 递归处理
    if (k === "properties" && typeof v === "object" && v !== null) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(v as Record<string, unknown>)) {
        props[propName] = stripRefSiblingsImpl(propSchema as JsonSchema);
      }
      result[k] = props;
    } else if (k === "items" && typeof v === "object" && v !== null) {
      result[k] = stripRefSiblingsImpl(v as JsonSchema);
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) =>
        typeof item === "object" && item !== null ? stripRefSiblingsImpl(item as JsonSchema) : item,
      );
    } else if (typeof v === "object" && v !== null) {
      result[k] = stripRefSiblingsImpl(v as JsonSchema);
    } else {
      result[k] = v;
    }
  }

  return result;
}

/**
 * 剥离 pattern 和 format。
 * 借鉴 hermes-agent strip_pattern_and_format：
 *   llama.cpp grammar-parse 失败时调用。
 */
function stripPatternAndFormatImpl(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== "object") return schema;

  const result: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "pattern" || k === "format") continue; // 剥离

    // 递归处理
    if (k === "properties" && typeof v === "object" && v !== null) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(v as Record<string, unknown>)) {
        props[propName] = stripPatternAndFormatImpl(propSchema as JsonSchema);
      }
      result[k] = props;
    } else if (k === "items" && typeof v === "object" && v !== null) {
      result[k] = stripPatternAndFormatImpl(v as JsonSchema);
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) =>
        typeof item === "object" && item !== null ? stripPatternAndFormatImpl(item as JsonSchema) : item,
      );
    } else if (typeof v === "object" && v !== null) {
      result[k] = stripPatternAndFormatImpl(v as JsonSchema);
    } else {
      result[k] = v;
    }
  }

  return result;
}

/**
 * 剥离含 / 的 enum。
 * 借鉴 hermes-agent strip_slash_enum：
 *   xAI Responses 不支持含 / 的 enum 值。
 */
function stripSlashEnumImpl(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== "object") return schema;

  const result: JsonSchema = {};

  for (const [k, v] of Object.entries(schema)) {
    if (k === "enum" && Array.isArray(v)) {
      // 过滤掉含 / 的值
      const filtered = v.filter((item) => typeof item !== "string" || !item.includes("/"));
      if (filtered.length > 0) {
        result[k] = filtered;
      }
      // 如果过滤后为空，则不保留 enum
    } else if (k === "properties" && typeof v === "object" && v !== null) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(v as Record<string, unknown>)) {
        props[propName] = stripSlashEnumImpl(propSchema as JsonSchema);
      }
      result[k] = props;
    } else if (k === "items" && typeof v === "object" && v !== null) {
      result[k] = stripSlashEnumImpl(v as JsonSchema);
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) =>
        typeof item === "object" && item !== null ? stripSlashEnumImpl(item as JsonSchema) : item,
      );
    } else if (typeof v === "object" && v !== null) {
      result[k] = stripSlashEnumImpl(v as JsonSchema);
    } else {
      result[k] = v;
    }
  }

  return result;
}

// ── 主函数 ──────────────────────────────────────────────────────────────────

/**
 * 清洗单个工具 schema。
 * 借鉴 hermes-agent _sanitize_single_tool。
 */
function sanitizeSingleTool(tool: ToolSchema, options: SanitizeOptions): ToolSchema {
  const sanitized = deepClone(tool);
  let params = sanitized.function.parameters as JsonSchema;

  if (options.stripNullableUnions) {
    params = stripNullableUnionsImpl(params);
  }
  if (options.stripTopLevelCombinators) {
    params = stripTopLevelCombinatorsImpl(params);
  }
  if (options.stripRefSiblings) {
    params = stripRefSiblingsImpl(params);
  }
  if (options.stripPatternFormat) {
    params = stripPatternAndFormatImpl(params);
  }
  if (options.stripSlashEnum) {
    params = stripSlashEnumImpl(params);
  }

  sanitized.function.parameters = params;
  return sanitized;
}

/**
 * 根据 backend 推断清洗选项。
 */
function inferOptions(backend: BackendType): Required<SanitizeOptions> {
  const base: Required<SanitizeOptions> = {
    backend,
    stripPatternFormat: false,
    stripSlashEnum: false,
    stripTopLevelCombinators: false,
    stripRefSiblings: false,
    stripNullableUnions: false,
  };

  switch (backend) {
    case "anthropic":
      // Anthropic 不支持 anyOf/oneOf
      base.stripNullableUnions = true;
      break;
    case "openai-codex":
      // OpenAI Codex 不支持顶层组合器
      base.stripTopLevelCombinators = true;
      base.stripNullableUnions = true;
      break;
    case "fireworks":
      // Fireworks 不支持 $ref 旁边有 default
      base.stripRefSiblings = true;
      base.stripNullableUnions = true;
      break;
    case "xai":
      // xAI Responses 不支持含 / 的 enum
      base.stripSlashEnum = true;
      base.stripNullableUnions = true;
      break;
    case "llama-cpp":
    case "ollama":
      // llama.cpp grammar-parse 可能失败，剥离 pattern/format
      base.stripPatternFormat = true;
      base.stripNullableUnions = true;
      break;
    case "openai":
    case "google":
    case "generic":
    default:
      // 通用后端，默认不做反应式清洗
      break;
  }

  return base;
}

/**
 * 清洗工具 schema 列表。
 * 借鉴 hermes-agent sanitize_tool_schemas。
 *
 * @param tools 工具 schema 列表
 * @param options 清洗选项（可指定 backend 自动推断）
 */
export function sanitizeToolSchemas(
  tools: ToolSchema[],
  options: SanitizeOptions = {},
): ToolSchema[] {
  if (!tools || tools.length === 0) return tools;

  // 如果指定了 backend 但没有显式指定清洗选项，则自动推断
  let opts: Required<SanitizeOptions>;
  if (options.backend && !options.stripNullableUnions && !options.stripTopLevelCombinators &&
      !options.stripRefSiblings && !options.stripPatternFormat && !options.stripSlashEnum) {
    opts = inferOptions(options.backend);
  } else {
    opts = {
      backend: options.backend || "generic",
      stripPatternFormat: options.stripPatternFormat ?? false,
      stripSlashEnum: options.stripSlashEnum ?? false,
      stripTopLevelCombinators: options.stripTopLevelCombinators ?? false,
      stripRefSiblings: options.stripRefSiblings ?? false,
      stripNullableUnions: options.stripNullableUnions ?? false,
    };
  }

  return tools.map((tool) => sanitizeSingleTool(tool, opts));
}

/**
 * 反应式清洗：当 LLM 返回 grammar-parse 错误时调用。
 * 借鉴 hermes-agent strip_pattern_and_format 的反应式调用模式。
 */
export function reactiveSanitize(
  tools: ToolSchema[],
  errorText: string,
): ToolSchema[] {
  if (!tools || tools.length === 0) return tools;

  // 根据错误文本判断需要哪种清洗
  const lowerError = errorText.toLowerCase();

  if (lowerError.includes("grammar") || lowerError.includes("pattern") || lowerError.includes("format")) {
    // llama.cpp grammar 错误
    return sanitizeToolSchemas(tools, { stripPatternFormat: true });
  }

  if (lowerError.includes("anyof") || lowerError.includes("oneof")) {
    // 组合器不支持
    return sanitizeToolSchemas(tools, { stripNullableUnions: true, stripTopLevelCombinators: true });
  }

  if (lowerError.includes("enum") && lowerError.includes("/")) {
    // enum 含 / 错误
    return sanitizeToolSchemas(tools, { stripSlashEnum: true });
  }

  if (lowerError.includes("$ref") && lowerError.includes("default")) {
    // $ref 兄弟冲突
    return sanitizeToolSchemas(tools, { stripRefSiblings: true });
  }

  // 默认全量清洗
  return sanitizeToolSchemas(tools, {
    stripNullableUnions: true,
    stripTopLevelCombinators: true,
    stripRefSiblings: true,
    stripPatternFormat: true,
    stripSlashEnum: true,
  });
}
