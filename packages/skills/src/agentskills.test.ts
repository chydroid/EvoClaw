import { describe, it, expect } from "vitest";
import { AgentSkillsStdValidator, extractAgentSkillsMeta } from "./agentskills";
import { SKILLmdParser } from "./skill-md-parser";

/**
 * agentskills.io 公开标准兼容层测试
 * 规范：https://agentskills.io/specification.md
 */
describe("AgentSkillsStdValidator — frontmatter", () => {
  const v = new AgentSkillsStdValidator();

  it("最小合规 frontmatter（name + description）", () => {
    const r = v.validateFrontmatter({ name: "pdf-processing", description: "Extracts text from PDFs." });
    expect(r.specValid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("name 缺失误判", () => {
    const r = v.validateFrontmatter({ description: "ok" });
    expect(r.specValid).toBe(false);
    expect(r.errors.join(" ")).toContain("name");
  });

  it("description 为空判误", () => {
    const r = v.validateFrontmatter({ name: "ok-skill", description: "" });
    expect(r.specValid).toBe(false);
  });

  it("name 大写判误", () => {
    const r = v.validateFrontmatter({ name: "PDF-Processing", description: "d" });
    expect(r.specValid).toBe(false);
    expect(r.errors.join(" ")).toContain("name");
  });

  it("name 首尾/连续连字符判误", () => {
    expect(v.validateFrontmatter({ name: "-pdf", description: "d" }).specValid).toBe(false);
    expect(v.validateFrontmatter({ name: "pdf-", description: "d" }).specValid).toBe(false);
    expect(v.validateFrontmatter({ name: "pdf--processing", description: "d" }).specValid).toBe(false);
  });

  it("name 超长（>64）判误", () => {
    const r = v.validateFrontmatter({ name: "a".repeat(65), description: "d" });
    expect(r.specValid).toBe(false);
  });

  it("description 超长（>1024）判误", () => {
    const r = v.validateFrontmatter({ name: "ok-skill", description: "a".repeat(1025) });
    expect(r.specValid).toBe(false);
  });

  it("compatibility 超长（>500）判误 / 空值判警告", () => {
    expect(v.validateFrontmatter({ name: "ok-skill", description: "d", compatibility: "x".repeat(501) }).specValid).toBe(false);
    const empty = v.validateFrontmatter({ name: "ok-skill", description: "d", compatibility: "  " });
    expect(empty.specValid).toBe(true);
    expect(empty.warnings.join(" ")).toContain("compatibility");
  });

  it("metadata 必须是 string→string 映射", () => {
    const bad = v.validateFrontmatter({
      name: "ok-skill",
      description: "d",
      metadata: { version: 1.0, author: "org" },
    });
    expect(bad.specValid).toBe(false);
    expect(bad.errors.join(" ")).toContain('metadata["version"]');
  });

  it("allowed-tools 数组形态判警告（非标准，兼容 OpenClaw 私标习惯）", () => {
    const r = v.validateFrontmatter({
      name: "ok-skill",
      description: "d",
      "allowed-tools": ["Bash(git:*)", "Read"],
    });
    expect(r.specValid).toBe(true);
    expect(r.warnings.join(" ")).toContain("allowed-tools");
  });

  it("name 与父目录同名检查（含归一化降级）", () => {
    // 完全一致
    expect(v.validateFrontmatter({ name: "pdf-processing", description: "d" }, { dirName: "pdf-processing" }).specValid).toBe(true);
    // 不一致判误
    expect(v.validateFrontmatter({ name: "pdf-processing", description: "d" }, { dirName: "other" }).specValid).toBe(false);
    // 目录名带下划线：归一化后可匹配 → 警告不判误
    const warn = v.validateFrontmatter({ name: "pdf_processing", description: "d" }, { dirName: "pdf_processing" });
    // 说明：pdf_processing 含下划线本身不合 name 规范，应判误
    expect(warn.specValid).toBe(false);
    const normalized = v.validateFrontmatter({ name: "pdf-processing", description: "d" }, { dirName: "pdf_processing" });
    expect(normalized.specValid).toBe(true);
    expect(normalized.warnings.join(" ")).toContain("normalization");
  });
});

describe("AgentSkillsStdValidator — body（渐进式披露）", () => {
  const v = new AgentSkillsStdValidator();

  it("短正文合规", () => {
    const r = v.validateBody("## Steps\n\n1. Do a\n2. Do b");
    expect(r.specValid).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("正文超 500 行判警告（不阻断）", () => {
    const body = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    const r = v.validateBody(body);
    expect(r.specValid).toBe(true);
    expect(r.warnings.join(" ")).toContain("exceeds the recommended 500 lines");
  });

  it("深层嵌套文件引用判警告", () => {
    const r = v.validateBody("See [ref](a/b/c/REFERENCE.md) for details.");
    expect(r.specValid).toBe(true);
    expect(r.warnings.join(" ")).toContain("one level deep");
  });
});

describe("extractAgentSkillsMeta — 归一化", () => {
  it("非字符串 metadata 值转 JSON 字符串", () => {
    const meta = extractAgentSkillsMeta({
      metadata: { author: "org", version: 2, tags: ["a", "b"] },
      compatibility: "Requires git and docker",
    });
    expect(meta.metadata?.author).toBe("org");
    expect(meta.metadata?.version).toBe("2");
    expect(meta.metadata?.tags).toBe('["a","b"]');
    expect(meta.compatibility).toBe("Requires git and docker");
  });

  it("空数据不产出字段", () => {
    const meta = extractAgentSkillsMeta({});
    expect(meta.metadata).toBeUndefined();
    expect(meta.compatibility).toBeUndefined();
  });
});

describe("SKILLmdParser — agentskills.io 字段解析", () => {
  const parser = new SKILLmdParser();

  it("解析 frontmatter 中的 metadata/compatibility 进 meta", async () => {
    const content = `---
name: pdf-processing
description: Extracts text and tables from PDF files. Use when handling PDFs.
license: Apache-2.0
compatibility: Requires git, docker, jq, and access to the internet
metadata:
  author: example-org
  version: "1.0"
---

## Steps

1. Run scripts/extract.py
2. Return the result
`;
    const doc = await parser.parse(content);
    expect(doc.meta.name).toBe("pdf-processing");
    expect(doc.meta.license).toBe("Apache-2.0");
    expect(doc.meta.compatibility).toContain("docker");
    expect(doc.meta.agentskillsMetadata?.author).toBe("example-org");
    expect(doc.meta.agentskillsMetadata?.version).toBe("1.0");
  });

  it("OpenClaw 私标与 agentskills 公开标准并存不冲突", async () => {
    const content = `---
name: dual-standard-skill
description: A skill carrying both OpenClaw private and agentskills.io public fields.
metadata:
  openclaw:
    emoji: "🔧"
    requires:
      env: [MY_KEY]
---

## Usage

Run the thing.
`;
    const doc = await parser.parse(content);
    // OpenClaw 私标走 metadata.openclaw
    expect(doc.meta.metadata?.openclaw?.emoji).toBe("🔧");
    // agentskills.io 的 metadata 顶层为 openclaw 映射（非 string 值）被归一化
    expect(doc.meta.agentskillsMetadata?.openclaw).toBeDefined();
  });
});
