import { describe, it, expect } from "vitest";
import { SkillValidator } from "./skill-validator";
import type {
  SKILLmdDocument,
  SkillInstallSpec,
  OpenClawSkillMeta,
} from "@evoclaw/core";

function makeDoc(overrides: Partial<SKILLmdDocument> = {}): SKILLmdDocument {
  return {
    meta: {
      name: "sample-skill",
      version: "1.0.0",
      description: "Sample skill for testing install spec validation.",
      author: "evoclaw-official",
      triggers: [{ type: "keyword", pattern: "sample", description: "triggers" }],
      requires: [],
      config: {},
      ...overrides.meta,
    },
    instructions: "## Instructions\n\n1. Run the skill\n2. Return result",
    scripts: {},
    examples: [],
    hooks: {},
    ...overrides,
  };
}

function withOpenClaw(oc: OpenClawSkillMeta, doc: SKILLmdDocument = makeDoc()): SKILLmdDocument {
  return {
    ...doc,
    meta: {
      ...doc.meta,
      metadata: { openclaw: oc },
    },
  };
}

describe("SkillValidator — validateInstallSpecs", () => {
  const validator = new SkillValidator();

  it("合法 install 数组（brew + apt，对齐 openclaw-main github 规范）", () => {
    const install: SkillInstallSpec[] = [
      { id: "brew", kind: "brew", formula: "gh", bins: ["gh"], label: "Install GitHub CLI (brew)" },
      { id: "apt", kind: "apt", package: "gh", bins: ["gh"], label: "Install GitHub CLI (apt)" },
    ];
    const result = validator.validateInstallSpecs(install);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("支持 npm 和 cargo kind", () => {
    const install: SkillInstallSpec[] = [
      { id: "npm", kind: "npm", package: "typescript", bins: ["tsc"] },
      { id: "cargo", kind: "cargo", package: "ripgrep", bins: ["rg"] },
    ];
    const result = validator.validateInstallSpecs(install);
    expect(result.errors).toEqual([]);
  });

  it("拒绝缺少 id 的 install 项", () => {
    const install = [
      { id: "ok", kind: "brew" as const, formula: "gh" },
      { kind: "brew" as const, formula: "gh" },
    ];
    const result = validator.validateInstallSpecs(install as SkillInstallSpec[]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("id is required"))).toBe(true);
  });

  it("拒绝非法 kind", () => {
    const install = [{ id: "x", kind: "snap" as unknown as "brew", package: "foo" }];
    const result = validator.validateInstallSpecs(install as SkillInstallSpec[]);
    expect(result.errors.some((e) => e.includes("invalid kind"))).toBe(true);
  });

  it("拒绝 brew/apt/npm/cargo/pip 同时缺少 formula/package/bins/module", () => {
    const cases: Array<{ kind: SkillInstallSpec["kind"]; spec: SkillInstallSpec }> = [
      { kind: "brew", spec: { id: "a", kind: "brew" } },
      { kind: "apt", spec: { id: "b", kind: "apt" } },
      { kind: "npm", spec: { id: "c", kind: "npm" } },
      { kind: "cargo", spec: { id: "d", kind: "cargo" } },
      { kind: "pip", spec: { id: "e", kind: "pip" } },
    ];
    for (const { spec } of cases) {
      const result = validator.validateInstallSpecs([spec]);
      expect(result.errors.some((e) => e.includes("must provide at least one of"))).toBe(true);
    }
  });

  it("download kind 必须有 url", () => {
    const install: SkillInstallSpec[] = [
      { id: "dl", kind: "download", archive: "x.tar.gz" },
    ];
    const result = validator.validateInstallSpecs(install);
    expect(result.errors.some((e) => e.includes("requires a non-empty \"url\""))).toBe(true);
  });

  it("download kind 有 url 时通过", () => {
    const install: SkillInstallSpec[] = [
      { id: "dl", kind: "download", url: "https://example.com/x.tar.gz" },
    ];
    const result = validator.validateInstallSpecs(install);
    expect(result.errors).toEqual([]);
  });

  it("重复 id 仅警告，不报错", () => {
    const install: SkillInstallSpec[] = [
      { id: "dup", kind: "brew", formula: "gh" },
      { id: "dup", kind: "apt", package: "gh" },
    ];
    const result = validator.validateInstallSpecs(install);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("duplicate id"))).toBe(true);
  });

  it("拒绝 bins 数组中包含非字符串", () => {
    const install = [
      { id: "a", kind: "brew" as const, formula: "gh", bins: ["gh", 123 as unknown as string] },
    ];
    const result = validator.validateInstallSpecs(install as SkillInstallSpec[]);
    expect(result.errors.some((e) => e.includes("bins entries must be non-empty strings"))).toBe(true);
  });

  it("string install 不报错，空字符串报错", () => {
    expect(validator.validateInstallSpecs("npm install lodash").errors).toEqual([]);
    expect(validator.validateInstallSpecs("   ").errors.length).toBeGreaterThan(0);
  });

  it("undefined install 不报错", () => {
    expect(validator.validateInstallSpecs(undefined).errors).toEqual([]);
  });
});

describe("SkillValidator — validateRequiresBins", () => {
  const validator = new SkillValidator();

  it("undefined 不报错", () => {
    expect(validator.validateRequiresBins(undefined).errors).toEqual([]);
  });

  it("空数组是合法的显式声明，不产生警告", () => {
    // 按项目约定：openclaw.requires.bins: [] 是有效的显式声明，不应触发警告
    const result = validator.validateRequiresBins([]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("非空字符串数组通过", () => {
    const result = validator.validateRequiresBins(["gh", "rg"]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("数组包含空字符串报错", () => {
    const result = validator.validateRequiresBins(["gh", ""]);
    expect(result.errors.some((e) => e.includes("must be a non-empty string"))).toBe(true);
  });

  it("非数组类型报错", () => {
    const result = validator.validateRequiresBins("gh" as unknown as string[]);
    expect(result.errors.some((e) => e.includes("must be an array"))).toBe(true);
  });
});

describe("SkillValidator — validate 集成 install/requires.bins 校验", () => {
  const validator = new SkillValidator();

  it("合法的 openclaw.install + requires.bins 通过 validate", () => {
    const doc = withOpenClaw({
      emoji: "🐙",
      requires: { bins: ["gh"] },
      install: [
        { id: "brew", kind: "brew", formula: "gh", bins: ["gh"] },
        { id: "apt", kind: "apt", package: "gh", bins: ["gh"] },
      ],
    });
    const result = validator.validate(doc);
    expect(result.valid).toBe(true);
    expect(result.errors.filter((e) => e.includes("install") || e.includes("bins"))).toEqual([]);
  });

  it("非法 install 项使 validate 失败", () => {
    const doc = withOpenClaw({
      install: [{ id: "bad", kind: "snap" as unknown as "brew", package: "x" }],
    });
    const result = validator.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("invalid kind"))).toBe(true);
  });

  it("requires.bins 含空字符串使 validate 失败", () => {
    const doc = withOpenClaw({
      requires: { bins: ["gh", ""] },
    });
    const result = validator.validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("must be a non-empty string"))).toBe(true);
  });

  it("requires.bins 空数组是合法声明，validate 通过且无警告", () => {
    const doc = withOpenClaw({
      requires: { bins: [] },
    });
    const result = validator.validate(doc);
    expect(result.valid).toBe(true);
    // 按项目约定：空数组是显式声明"无 binary 需求"，不应产生警告
    expect(result.warnings.filter((w) => w.includes("is empty"))).toEqual([]);
  });
});
