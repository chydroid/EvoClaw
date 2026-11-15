import { describe, it, expect, beforeEach } from "vitest";
import {
  sanitizeToolSchemas,
  reactiveSanitize,
  getSchemaSanitizerStats,
  resetSchemaSanitizerStats,
  type ToolSchema,
} from "./schema-sanitizer";

function makeTool(parameters: Record<string, unknown>): ToolSchema {
  return {
    type: "function",
    function: { name: "demo", description: "demo tool", parameters },
  };
}

/**
 * 主链路在 buildOpenAITools 之后调用 sanitizeToolSchemas；失败后按 provider
 * 错误文本反应式清洗。这里锁定「真的清洗 + 真的计数」两件事。
 */
describe("SchemaSanitizer", () => {
  beforeEach(() => resetSchemaSanitizerStats());

  it("openai-codex 后端剥离顶层组合器", () => {
    const tools = [makeTool({
      type: "object",
      properties: { value: { type: "string" } },
      anyOf: [{ type: "string" }, { type: "number" }],
      enum: ["a", "b"],
    })];

    const [sanitized] = sanitizeToolSchemas(tools, { backend: "openai-codex" });
    expect(sanitized.function.parameters.anyOf).toBeUndefined();
    expect(sanitized.function.parameters.enum).toBeUndefined();

    const stats = getSchemaSanitizerStats();
    expect(stats.calls).toBe(1);
    expect(stats.toolsSanitized).toBe(1);
    expect(stats.byBackend["openai-codex"]).toBe(1);
  });

  it("anthropic 后端折叠可空联合类型", () => {
    const tools = [makeTool({
      type: "object",
      properties: {
        name: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    })];

    const [sanitized] = sanitizeToolSchemas(tools, { backend: "anthropic" });
    const properties = sanitized.function.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.name.type).toBe("string");
    expect(properties.name.anyOf).toBeUndefined();
  });

  it("reactiveSanitize 按 grammar 错误剥离 pattern/format 并计数", () => {
    const tools = [makeTool({
      type: "object",
      properties: { id: { type: "string", pattern: "^[a-z]+$", format: "uuid" } },
    })];

    const [sanitized] = reactiveSanitize(tools, "grammar parse error near pattern");
    const properties = sanitized.function.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.id.pattern).toBeUndefined();
    expect(properties.id.format).toBeUndefined();
    expect(getSchemaSanitizerStats().reactiveCalls).toBe(1);
    expect(getSchemaSanitizerStats().calls).toBe(1);
  });

  it("未指定后端时不做破坏性清洗", () => {
    const tools = [makeTool({
      type: "object",
      properties: { value: { type: "string" } },
      anyOf: [{ type: "string" }, { type: "number" }],
    })];

    const [sanitized] = sanitizeToolSchemas(tools);
    expect(sanitized.function.parameters.anyOf).toBeDefined();
    expect(getSchemaSanitizerStats().byBackend.generic).toBe(1);
  });
});
