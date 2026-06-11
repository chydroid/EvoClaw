/**
 * Structured Output System for EvoClaw
 *
 * Ensures LLM outputs conform to a specified JSON schema.
 * Inspired by OpenAI's structured output feature and OpenClaw.
 *
 * Provides:
 * - SchemaRegistry: register and retrieve named JSON schemas
 * - StructuredOutputParser: parse, validate, and repair LLM JSON outputs
 * - Simplified JSON Schema validation (type, required, enum, array items, numeric ranges)
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface OutputSchema {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface StructuredOutputResult<T> {
  success: boolean;
  data?: T;
  raw: string;
  errors?: string[];
  attempts: number;
}

export interface StructuredOutputConfig {
  enabled: boolean;
  maxParseAttempts: number;
  strictMode: boolean;
  repairMalformedJson: boolean;
}

// ── Schema Registry ───────────────────────────────────────────────────────────

const BUILTIN_SCHEMAS: OutputSchema[] = [
  {
    name: "task-result",
    description: "A structured task execution result",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Brief summary of the task result" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", description: "Action taken" },
              result: { type: "string", description: "Result of the action" },
            },
            required: ["action", "result"],
          },
          description: "Steps taken during task execution",
        },
        success: { type: "boolean", description: "Whether the task succeeded" },
      },
      required: ["summary", "steps", "success"],
    },
  },
  {
    name: "analysis",
    description: "A structured analysis result",
    schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic being analyzed" },
        findings: {
          type: "array",
          items: { type: "string" },
          description: "Key findings from the analysis",
        },
        confidence: {
          type: "number",
          description: "Confidence level (0-1)",
          minimum: 0,
          maximum: 1,
        },
        recommendation: { type: "string", description: "Recommended next step" },
      },
      required: ["topic", "findings", "confidence", "recommendation"],
    },
  },
  {
    name: "code-review",
    description: "A structured code review result",
    schema: {
      type: "object",
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["info", "warning", "error"] },
              line: { type: "number", description: "Line number of the issue" },
              message: { type: "string", description: "Description of the issue" },
            },
            required: ["severity", "message"],
          },
          description: "Issues found during code review",
        },
        summary: { type: "string", description: "Overall review summary" },
        approved: { type: "boolean", description: "Whether the code is approved" },
      },
      required: ["issues", "summary", "approved"],
    },
  },
];

export class SchemaRegistry {
  private schemas = new Map<string, OutputSchema>();

  constructor() {
    for (const schema of BUILTIN_SCHEMAS) {
      this.schemas.set(schema.name, schema);
    }
  }

  register(schema: OutputSchema): void {
    this.schemas.set(schema.name, schema);
  }

  get(name: string): OutputSchema | undefined {
    return this.schemas.get(name);
  }

  list(): string[] {
    return Array.from(this.schemas.keys());
  }
}

// ── Simplified JSON Schema Validation ─────────────────────────────────────────

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  // Type check
  const schemaType = schema["type"] as string | undefined;
  if (schemaType) {
    if (!checkType(value, schemaType)) {
      errors.push(`At ${path}: expected type "${schemaType}", got "${typeof value}"`);
      return;
    }
  }

  // Enum check
  const enumValues = schema["enum"] as unknown[] | undefined;
  if (enumValues) {
    if (!enumValues.includes(value)) {
      errors.push(
        `At ${path}: value ${JSON.stringify(value)} not in enum [${enumValues.map((v) => JSON.stringify(v)).join(", ")}]`,
      );
      return;
    }
  }

  // Numeric range checks
  if (typeof value === "number") {
    const minimum = schema["minimum"] as number | undefined;
    const maximum = schema["maximum"] as number | undefined;
    if (minimum !== undefined && value < minimum) {
      errors.push(`At ${path}: value ${value} is less than minimum ${minimum}`);
    }
    if (maximum !== undefined && value > maximum) {
      errors.push(`At ${path}: value ${value} is greater than maximum ${maximum}`);
    }
  }

  // Object validation
  if (schemaType === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
    const required = schema["required"] as string[] | undefined;

    // Required fields
    if (required) {
      for (const reqField of required) {
        if (!(reqField in obj)) {
          errors.push(`At ${path}: missing required field "${reqField}"`);
        }
      }
    }

    // Validate each property that has a schema and exists in the value
    if (properties) {
      for (const [propName, propSchema] of Object.entries(properties)) {
        if (propName in obj) {
          validateValue(obj[propName], propSchema, `${path}.${propName}`, errors);
        }
      }
    }
  }

  // Array validation
  if (schemaType === "array" && Array.isArray(value)) {
    const items = schema["items"] as Record<string, unknown> | undefined;
    if (items) {
      for (let i = 0; i < value.length; i++) {
        validateValue(value[i], items, `${path}[${i}]`, errors);
      }
    }
  }
}

function checkType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

// ── JSON Repair ───────────────────────────────────────────────────────────────

function repairJson(raw: string): string {
  let result = raw;

  // Fix single quotes to double quotes (outside of already double-quoted strings)
  // Simple approach: replace single-quoted keys/values with double-quoted ones
  result = result.replace(/'([^']*)'(\s*:)/g, '"$1"$2'); // keys
  result = result.replace(/:\s*'([^']*)'/g, ': "$1"');   // string values

  // Fix unquoted keys: word characters followed by colon
  result = result.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');

  // Fix trailing commas before closing brackets
  result = result.replace(/,\s*([}\]])/g, "$1");

  // Fix missing closing braces/brackets
  const openBraces = (result.match(/{/g) || []).length;
  const closeBraces = (result.match(/}/g) || []).length;
  const openBrackets = (result.match(/\[/g) || []).length;
  const closeBrackets = (result.match(/]/g) || []).length;

  for (let i = 0; i < openBraces - closeBraces; i++) {
    result += "}";
  }
  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    result += "]";
  }

  return result;
}

// ── Parse Strategies ──────────────────────────────────────────────────────────

function tryDirectParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function tryCodeBlockParse(raw: string): unknown | null {
  const match = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {
      // Try repairing the extracted JSON
      try {
        return JSON.parse(repairJson(match[1]));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function tryBraceExtraction(raw: string): unknown | null {
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const extracted = raw.substring(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(extracted);
    } catch {
      try {
        return JSON.parse(repairJson(extracted));
      } catch {
        return null;
      }
    }
  }

  // Also try array extraction
  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const extracted = raw.substring(firstBracket, lastBracket + 1);
    try {
      return JSON.parse(extracted);
    } catch {
      try {
        return JSON.parse(repairJson(extracted));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function tryKeyValueExtraction(raw: string, schema: OutputSchema): unknown | null {
  const properties = (schema.schema["properties"] as Record<string, Record<string, unknown>>) ?? {};
  const result: Record<string, unknown> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    const propType = propSchema["type"] as string | undefined;
    // Match patterns like key: value, "key": value, key=value
    const patterns = [
      new RegExp(`(?:["']?)${escapeRegExp(key)}(?:["']?)\\s*[:=]\\s*(.+?)(?:[,\\n}]|$)`, "i"),
    ];

    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match) {
        let val: unknown = match[1].trim();
        // Remove trailing punctuation
        val = (val as string).replace(/[,;]+$/, "").trim();

        if (propType === "number" || propType === "integer") {
          const num = Number(val);
          if (!isNaN(num)) {
            result[key] = propType === "integer" ? Math.floor(num) : num;
          }
        } else if (propType === "boolean") {
          result[key] = (val as string).toLowerCase() === "true";
        } else if (propType === "array") {
          // Try to parse as JSON array
          try {
            result[key] = JSON.parse(val as string);
          } catch {
            // Split by comma as fallback
            result[key] = (val as string)
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          }
        } else {
          // String: strip surrounding quotes if present
          result[key] = (val as string).replace(/^["']|["']$/g, "");
        }
        break;
      }
    }
  }

  // Only return if we extracted at least one field
  if (Object.keys(result).length > 0) {
    return result;
  }
  return null;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Structured Output Parser ──────────────────────────────────────────────────

export class StructuredOutputParser {
  private config: StructuredOutputConfig;

  constructor(config?: Partial<StructuredOutputConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      maxParseAttempts: config?.maxParseAttempts ?? 3,
      strictMode: config?.strictMode ?? false,
      repairMalformedJson: config?.repairMalformedJson ?? true,
    };
  }

  /**
   * Parse and validate raw LLM output against a schema.
   * Tries multiple parse strategies in order.
   */
  parse<T>(raw: string, schema: OutputSchema): StructuredOutputResult<T> {
    if (!this.config.enabled) {
      return { success: false, raw, attempts: 0, errors: ["Structured output is disabled"] };
    }

    const errors: string[] = [];
    let attempts = 0;
    let parsed: unknown | null = null;

    // Strategy a: Direct JSON parse
    attempts++;
    parsed = tryDirectParse(raw);
    if (parsed !== null) {
      const validationErrors = this.validate(parsed, schema);
      if (validationErrors.length === 0) {
        return { success: true, data: parsed as T, raw, attempts };
      }
      errors.push(...validationErrors);
    }

    // Strategy b: Extract JSON from markdown code block
    if (parsed === null || errors.length > 0) {
      attempts++;
      if (attempts <= this.config.maxParseAttempts) {
        const codeBlockResult = tryCodeBlockParse(raw);
        if (codeBlockResult !== null) {
          const validationErrors = this.validate(codeBlockResult, schema);
          if (validationErrors.length === 0) {
            return { success: true, data: codeBlockResult as T, raw, attempts };
          }
          // Better than previous attempt — use these errors instead
          if (parsed === null || validationErrors.length < errors.length) {
            errors.length = 0;
            errors.push(...validationErrors);
            parsed = codeBlockResult;
          }
        }
      }
    }

    // Strategy c: Extract JSON from text (first { to last })
    if (parsed === null || errors.length > 0) {
      attempts++;
      if (attempts <= this.config.maxParseAttempts) {
        const braceResult = tryBraceExtraction(raw);
        if (braceResult !== null) {
          const validationErrors = this.validate(braceResult, schema);
          if (validationErrors.length === 0) {
            return { success: true, data: braceResult as T, raw, attempts };
          }
          if (parsed === null || validationErrors.length < errors.length) {
            errors.length = 0;
            errors.push(...validationErrors);
            parsed = braceResult;
          }
        }
      }
    }

    // Strategy d: Key-value extraction (for simple flat schemas)
    if (parsed === null || errors.length > 0) {
      attempts++;
      if (attempts <= this.config.maxParseAttempts) {
        const kvResult = tryKeyValueExtraction(raw, schema);
        if (kvResult !== null) {
          const validationErrors = this.validate(kvResult, schema);
          if (validationErrors.length === 0) {
            return { success: true, data: kvResult as T, raw, attempts };
          }
          if (parsed === null || validationErrors.length < errors.length) {
            errors.length = 0;
            errors.push(...validationErrors);
            parsed = kvResult;
          }
        }
      }
    }

    // If we have parsed data but with validation errors, return partial success
    // in non-strict mode
    if (parsed !== null && !this.config.strictMode && !schema.strict) {
      return { success: false, data: parsed as T, raw, errors, attempts };
    }

    return { success: false, raw, errors, attempts };
  }

  /**
   * Validate a parsed value against an OutputSchema.
   * Returns an array of validation error messages (empty if valid).
   */
  validate(data: unknown, schema: OutputSchema): string[] {
    const errors: string[] = [];
    validateValue(data, schema.schema, "$", errors);
    return errors;
  }

  /**
   * Attempt to repair malformed JSON from LLM output.
   */
  repair(raw: string, _schema: OutputSchema): string {
    return repairJson(raw);
  }

  /**
   * Format a schema as a prompt instruction for the LLM.
   * Generates a clear instruction telling the model to respond with JSON
   * matching the schema, including field descriptions and examples.
   */
  formatSchemaForPrompt(schema: OutputSchema): string {
    const properties = (schema.schema["properties"] as Record<string, Record<string, unknown>>) ?? {};
    const required = (schema.schema["required"] as string[]) ?? [];

    let instruction = `Respond with a JSON object matching this schema: ${schema.name}\n`;
    instruction += `Description: ${schema.description}\n\n`;
    instruction += `JSON structure:\n{\n`;

    const fieldLines: string[] = [];
    for (const [key, propSchema] of Object.entries(properties)) {
      const isRequired = required.includes(key);
      const type = propSchema["type"] as string ?? "any";
      const desc = propSchema["description"] as string | undefined;
      const enumVals = propSchema["enum"] as string[] | undefined;

      let line = `  "${key}": `;

      if (type === "array") {
        const items = propSchema["items"] as Record<string, unknown> | undefined;
        if (items?.["type"] === "object" && items?.["properties"]) {
          const itemProps = items["properties"] as Record<string, Record<string, unknown>>;
          const itemRequired = (items["required"] as string[]) ?? [];
          const innerFields = Object.entries(itemProps)
            .map(([ik, iv]) => {
              const iType = iv["type"] as string;
              const iEnum = iv["enum"] as string[] | undefined;
              const iRequired = itemRequired.includes(ik);
              return `"${ik}": ${iEnum ? iEnum.map((v) => `"${v}"`).join("|") : iType}${iRequired ? "" : " (optional)"}`;
            })
            .join(", ");
          line += `[{ ${innerFields} }, ...]`;
        } else {
          const itemType = (items?.["type"] as string) ?? "any";
          line += `[${itemType}, ...]`;
        }
      } else if (enumVals) {
        line += enumVals.map((v) => `"${v}"`).join(" | ");
      } else {
        line += type;
      }

      if (desc) {
        line += ` // ${desc}`;
      }
      if (!isRequired) {
        line += " (optional)";
      }

      fieldLines.push(line);
    }

    instruction += fieldLines.join(",\n");
    instruction += `\n}\n\n`;

    // Add example
    instruction += `Example:\n${JSON.stringify(buildExample(schema), null, 2)}\n\n`;
    instruction += `IMPORTANT: Respond ONLY with valid JSON matching this schema. No markdown, no extra text.`;

    return instruction;
  }
}

// ── Example Builder ───────────────────────────────────────────────────────────

function buildExample(schema: OutputSchema): Record<string, unknown> {
  const properties = (schema.schema["properties"] as Record<string, Record<string, unknown>>) ?? {};
  const required = (schema.schema["required"] as string[]) ?? [];
  const example: Record<string, unknown> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    if (!required.includes(key)) continue;
    example[key] = buildExampleValue(propSchema);
  }

  return example;
}

function buildExampleValue(propSchema: Record<string, unknown>): unknown {
  const type = propSchema["type"] as string;
  const enumVals = propSchema["enum"] as string[] | undefined;

  if (enumVals && enumVals.length > 0) {
    return enumVals[0];
  }

  switch (type) {
    case "string":
      return "example";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return true;
    case "array": {
      const items = propSchema["items"] as Record<string, unknown> | undefined;
      if (items) {
        return [buildExampleValue(items)];
      }
      return [];
    }
    case "object": {
      const objProps = propSchema["properties"] as Record<string, Record<string, unknown>> | undefined;
      const objRequired = (propSchema["required"] as string[]) ?? [];
      if (objProps) {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(objProps)) {
          if (objRequired.includes(k)) {
            obj[k] = buildExampleValue(v);
          }
        }
        return obj;
      }
      return {};
    }
    default:
      return null;
  }
}
