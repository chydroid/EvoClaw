import { describe, it, expect } from "vitest";
import { validateManifest, createManifest } from "./plugin";

describe("validateManifest", () => {
  it("should return true for a valid manifest", () => {
    const m = { id: "test-plugin", name: "Test", version: "1.0.0" };
    expect(validateManifest(m)).toBe(true);
  });

  it("should return true for a manifest with extra fields", () => {
    const m = {
      id: "test-plugin",
      name: "Test",
      version: "1.0.0",
      description: "A test plugin",
      author: "test",
    };
    expect(validateManifest(m)).toBe(true);
  });

  it("should return false for null", () => {
    expect(validateManifest(null)).toBe(false);
  });

  it("should return false for undefined", () => {
    expect(validateManifest(undefined)).toBe(false);
  });

  it("should return false for a string", () => {
    expect(validateManifest("not-an-object")).toBe(false);
  });

  it("should return false when id is missing", () => {
    const m = { name: "Test", version: "1.0.0" };
    expect(validateManifest(m)).toBe(false);
  });

  it("should return false when name is missing", () => {
    const m = { id: "test", version: "1.0.0" };
    expect(validateManifest(m)).toBe(false);
  });

  it("should return false when version is missing", () => {
    const m = { id: "test", name: "Test" };
    expect(validateManifest(m)).toBe(false);
  });

  it("should return false when id is not a string", () => {
    const m = { id: 123, name: "Test", version: "1.0.0" };
    expect(validateManifest(m)).toBe(false);
  });

  it("should return false for an empty object", () => {
    expect(validateManifest({})).toBe(false);
  });

  it("should return false for an array", () => {
    expect(validateManifest([])).toBe(false);
  });
});

describe("createManifest", () => {
  it("should create a basic manifest with required fields", () => {
    const m = createManifest("my-plugin", "My Plugin", "2.0.0");
    expect(m.id).toBe("my-plugin");
    expect(m.name).toBe("My Plugin");
    expect(m.version).toBe("2.0.0");
    expect(m.description).toBe("");
  });

  it("should include optional fields when provided", () => {
    const m = createManifest("my-plugin", "My Plugin", "2.0.0", {
      description: "A cool plugin",
      author: "dev",
      license: "MIT",
    });
    expect(m.description).toBe("A cool plugin");
    expect(m.author).toBe("dev");
    expect(m.license).toBe("MIT");
  });

  it("should propagate all extra options", () => {
    const m = createManifest("p1", "P1", "1.0.0", {
      description: "desc",
      author: "auth",
      license: "Apache-2.0",
      evoclawVersion: ">=0.4.0",
      categories: ["tool"],
      homepage: "https://example.com",
    });
    expect(m.evoclawVersion).toBe(">=0.4.0");
    expect(m.categories).toEqual(["tool"]);
    expect(m.homepage).toBe("https://example.com");
  });

  it("should generate unique manifests with different IDs", () => {
    const m1 = createManifest("a", "A", "1.0.0");
    const m2 = createManifest("b", "B", "1.0.0");
    expect(m1.id).not.toBe(m2.id);
  });
});