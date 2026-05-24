import { describe, it, expect } from "vitest";
import { createConfigExtension, createValidator } from "./config";

describe("createConfigExtension", () => {
  it("should create a config extension with schema and defaults", () => {
    const schema = { type: "object", properties: { apiKey: { type: "string" } } };
    const defaults = { apiKey: "" };
    const ext = createConfigExtension(schema, defaults);

    expect(ext.schema).toEqual(schema);
    expect(ext.defaults).toEqual(defaults);
  });

  it("should use default validator that always passes when no validate provided", () => {
    const ext = createConfigExtension({}, {});
    const result = ext.validate({ any: "thing" });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("should use custom validate function when provided", () => {
    const ext = createConfigExtension({}, {}, (data) => ({
      valid: false,
      errors: ["custom error"],
      warnings: ["custom warning"],
    }));
    const result = ext.validate({});
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["custom error"]);
    expect(result.warnings).toEqual(["custom warning"]);
  });

  it("should preserve schema reference", () => {
    const schema = { type: "array" };
    const ext = createConfigExtension(schema, {});
    expect(ext.schema).toBe(schema);
  });
});

describe("createValidator", () => {
  it("should return valid when all required fields present", () => {
    const validator = createValidator(["name", "email"]);
    const result = validator({ name: "Alice", email: "a@b.com" });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("should return invalid when a required field is missing", () => {
    const validator = createValidator(["name", "email"]);
    const result = validator({ name: "Alice" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required field: email");
  });

  it("should return invalid when a field is null", () => {
    const validator = createValidator(["name"]);
    const result = validator({ name: null });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required field: name");
  });

  it("should return invalid when all required fields are missing", () => {
    const validator = createValidator(["a", "b", "c"]);
    const result = validator({});
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
    expect(result.errors).toContain("Missing required field: a");
    expect(result.errors).toContain("Missing required field: b");
    expect(result.errors).toContain("Missing required field: c");
  });

  it("should return valid for empty required fields array", () => {
    const validator = createValidator([]);
    const result = validator({});
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should ignore extra fields not in required list", () => {
    const validator = createValidator(["name"]);
    const result = validator({ name: "Bob", extra: true });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should validate undefined values as missing", () => {
    const validator = createValidator(["key"]);
    const result = validator({ key: undefined });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required field: key");
  });

  it("should accept 0, false, and empty string as valid values", () => {
    const validator = createValidator(["count", "active", "name"]);
    const result = validator({ count: 0, active: false, name: "" });
    expect(result.valid).toBe(true);
  });
});