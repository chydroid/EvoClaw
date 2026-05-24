import { describe, it, expect } from "vitest";
import { createToolDefinition } from "./tool";
import type { ToolParameterSchema } from "./tool";

describe("createToolDefinition", () => {
  const defaultParams: ToolParameterSchema = {
    type: "object",
    properties: {
      url: { type: "string", description: "Target URL" },
    },
    required: ["url"],
  };

  it("should create a basic tool definition", () => {
    const def = createToolDefinition("web_fetch", "Fetch a web page", defaultParams);
    expect(def.name).toBe("web_fetch");
    expect(def.description).toBe("Fetch a web page");
    expect(def.parameters).toEqual(defaultParams);
  });

  it("should set requiresApproval to false by default", () => {
    const def = createToolDefinition("t1", "desc", defaultParams);
    expect(def.requiresApproval).toBe(false);
  });

  it("should set categories to ['custom'] by default", () => {
    const def = createToolDefinition("t1", "desc", defaultParams);
    expect(def.categories).toEqual(["custom"]);
  });

  it("should set sandboxSafe to false by default", () => {
    const def = createToolDefinition("t1", "desc", defaultParams);
    expect(def.sandboxSafe).toBe(false);
  });

  it("should accept optional overrides", () => {
    const def = createToolDefinition("delete_file", "Delete a file", defaultParams, {
      requiresApproval: true,
      categories: ["file_system", "security"],
      sandboxSafe: true,
    });
    expect(def.requiresApproval).toBe(true);
    expect(def.categories).toEqual(["file_system", "security"]);
    expect(def.sandboxSafe).toBe(true);
  });

  it("should handle complex parameter schemas", () => {
    const complexParams: ToolParameterSchema = {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        mode: {
          type: "string",
          enum: ["read", "write", "append"],
          description: "Access mode",
        },
        options: {
          type: "object",
          properties: {
            encoding: { type: "string", default: "utf-8" },
          },
        },
      },
      required: ["path"],
    };
    const def = createToolDefinition("file_op", "File operation", complexParams);
    expect(def.parameters.required).toEqual(["path"]);
    expect(def.parameters.properties!["mode"].enum).toEqual(["read", "write", "append"]);
  });

  it("should preserve parameter metadata", () => {
    const params: ToolParameterSchema = {
      type: "object",
      properties: {
        count: { type: "number", description: "Count", default: 0 },
        enabled: { type: "boolean", default: true },
      },
    };
    const def = createToolDefinition("toggle", "Toggle setting", params);
    const count = def.parameters.properties!["count"];
    expect(count.type).toBe("number");
    expect(count.default).toBe(0);
  });
});