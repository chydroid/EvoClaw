import { describe, it, expect } from "vitest";
import { SKILLmdParser } from "./skill-md-parser";
import { readFile } from "fs/promises";
import * as path from "path";
import type { SkillInstallSpec } from "@evoclaw/core";

const BUNDLED_DIR = path.join(__dirname, "..", "bundled");

// 复用 openclaw-main 的 github SKILL.md frontmatter 形态作为黄金样本。
const GITHUB_STYLE_FRONTMATTER = `---
name: github
version: 1.0.0
description: "GitHub CLI for issues, PRs, CI checks."
author: evoclaw-official
metadata:
  openclaw:
    emoji: "🐙"
    requires:
      bins: ["gh"]
    install:
      - id: brew
        kind: brew
        formula: gh
        bins: ["gh"]
        label: "Install GitHub CLI (brew)"
      - id: apt
        kind: apt
        package: gh
        bins: ["gh"]
        label: "Install GitHub CLI (apt)"
---

# GitHub

Use \`gh\` for GitHub.

## Instructions

1. List PRs
2. View PR checks

\`\`\`bash
gh pr list
\`\`\`
`;

describe("SKILLmdParser — openclaw.install 字段", () => {
  it("解析 install 数组并保留所有合法字段", async () => {
    const parser = new SKILLmdParser();
    const doc = await parser.parse(GITHUB_STYLE_FRONTMATTER);

    const oc = doc.meta.metadata?.openclaw;
    expect(oc).toBeDefined();
    expect(oc?.install).toBeDefined();
    expect(Array.isArray(oc?.install)).toBe(true);

    const specs = oc?.install as SkillInstallSpec[];
    expect(specs).toHaveLength(2);

    expect(specs[0]).toMatchObject({
      id: "brew",
      kind: "brew",
      formula: "gh",
      bins: ["gh"],
      label: "Install GitHub CLI (brew)",
    });
    expect(specs[1]).toMatchObject({
      id: "apt",
      kind: "apt",
      package: "gh",
      bins: ["gh"],
      label: "Install GitHub CLI (apt)",
    });
  });

  it("支持新增的 npm 和 cargo kind", async () => {
    const md = `---
name: npm-cargo-sample
version: 1.0.0
description: "Sample skill exercising npm and cargo install kinds."
author: evoclaw-official
metadata:
  openclaw:
    emoji: "📦"
    requires:
      bins: []
    install:
      - id: npm
        kind: npm
        package: typescript
        bins: ["tsc"]
        label: "Install TypeScript (npm)"
      - id: cargo
        kind: cargo
        package: ripgrep
        bins: ["rg"]
        label: "Install ripgrep (cargo)"
---

# Sample

## Instructions

1. Use tsc
2. Use rg
`;
    const parser = new SKILLmdParser();
    const doc = await parser.parse(md);

    const specs = doc.meta.metadata?.openclaw?.install as SkillInstallSpec[];
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({ id: "npm", kind: "npm", package: "typescript", bins: ["tsc"] });
    expect(specs[1]).toMatchObject({ id: "cargo", kind: "cargo", package: "ripgrep", bins: ["rg"] });
  });

  it("保留历史 node/go/uv/download kind（向后兼容）", async () => {
    const md = `---
name: legacy-kinds
version: 1.0.0
description: "Test legacy install kinds remain supported."
author: evoclaw-official
metadata:
  openclaw:
    install:
      - id: node
        kind: node
        package: prettier
      - id: go
        kind: go
        module: github.com/foo/bar
      - id: download
        kind: download
        url: https://example.com/bin.tar.gz
        archive: bin.tar.gz
        extract: true
        stripComponents: 1
---

# Legacy
`;
    const parser = new SKILLmdParser();
    const doc = await parser.parse(md);

    const specs = doc.meta.metadata?.openclaw?.install as SkillInstallSpec[];
    expect(specs).toHaveLength(3);
    expect(specs[0]).toMatchObject({ id: "node", kind: "node", package: "prettier" });
    expect(specs[1]).toMatchObject({ id: "go", kind: "go", module: "github.com/foo/bar" });
    expect(specs[2]).toMatchObject({
      kind: "download",
      url: "https://example.com/bin.tar.gz",
      archive: "bin.tar.gz",
      extract: true,
      stripComponents: 1,
    });
  });

  it("丢弃缺少 id 或非法 kind 的 install 项", async () => {
    const md = `---
name: dirty-install
version: 1.0.0
description: "Test malformed install entries are filtered out."
author: evoclaw-official
metadata:
  openclaw:
    install:
      - id: valid
        kind: brew
        formula: gh
      - kind: brew
        formula: missing-id
      - id: bad-kind
        kind: snap
        package: foo
      - "string-entry-should-be-dropped"
---

# Dirty
`;
    const parser = new SKILLmdParser();
    const doc = await parser.parse(md);

    const specs = doc.meta.metadata?.openclaw?.install as SkillInstallSpec[];
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ id: "valid", kind: "brew", formula: "gh" });
  });

  it("字符串 install（历史形态）原样保留", async () => {
    const md = `---
name: string-install
version: 1.0.0
description: "Test legacy string install script is preserved."
author: evoclaw-official
metadata:
  openclaw:
    install: "npm install --no-save lodash"
---

# String
`;
    const parser = new SKILLmdParser();
    const doc = await parser.parse(md);

    expect(doc.meta.metadata?.openclaw?.install).toBe("npm install --no-save lodash");
  });

  it("解析 requires.bins 与 emoji 字段", async () => {
    const parser = new SKILLmdParser();
    const doc = await parser.parse(GITHUB_STYLE_FRONTMATTER);

    const oc = doc.meta.metadata?.openclaw;
    expect(oc?.emoji).toBe("🐙");
    expect(oc?.requires?.bins).toEqual(["gh"]);
  });

  it("解析空 requires.bins 数组（不报错）", async () => {
    const md = `---
name: empty-bins
version: 1.0.0
description: "Test empty requires.bins array parses cleanly."
author: evoclaw-official
metadata:
  openclaw:
    requires:
      bins: []
---

# Empty
`;
    const parser = new SKILLmdParser();
    const doc = await parser.parse(md);

    expect(doc.meta.metadata?.openclaw?.requires?.bins).toEqual([]);
  });

  // ── 端到端：验证 bundled skills 真实文件能被正确解析 ──

  it("bundled/uuid-generator 的 install 字段含 npm kind", async () => {
    const file = path.join(BUNDLED_DIR, "uuid-generator", "SKILL.md");
    const content = await readFile(file, "utf-8");
    const parser = new SKILLmdParser();
    const doc = await parser.parse(content);

    const oc = doc.meta.metadata?.openclaw;
    expect(oc).toBeDefined();
    expect(oc?.install).toBeDefined();
    const specs = oc?.install as SkillInstallSpec[];
    const npmSpec = specs.find((s) => s.kind === "npm");
    expect(npmSpec).toBeDefined();
    expect(npmSpec?.package).toBe("uuid");
    expect(npmSpec?.bins).toEqual(["uuid"]);
  });

  it("bundled/timestamp-converter 含 brew 和 apt 两种安装方式", async () => {
    const file = path.join(BUNDLED_DIR, "timestamp-converter", "SKILL.md");
    const content = await readFile(file, "utf-8");
    const parser = new SKILLmdParser();
    const doc = await parser.parse(content);

    const specs = doc.meta.metadata?.openclaw?.install as SkillInstallSpec[];
    expect(specs).toHaveLength(2);
    const kinds = specs.map((s) => s.kind).sort();
    expect(kinds).toEqual(["apt", "brew"]);
  });

  it("bundled/hash-computer 不声明 install 字段（无外部依赖）", async () => {
    const file = path.join(BUNDLED_DIR, "hash-computer", "SKILL.md");
    const content = await readFile(file, "utf-8");
    const parser = new SKILLmdParser();
    const doc = await parser.parse(content);

    expect(doc.meta.metadata?.openclaw?.install).toBeUndefined();
  });

  it("bundled/base64-codec 的 install 声明 coreutils（brew + apt）", async () => {
    const file = path.join(BUNDLED_DIR, "base64-codec", "SKILL.md");
    const content = await readFile(file, "utf-8");
    const parser = new SKILLmdParser();
    const doc = await parser.parse(content);

    const specs = doc.meta.metadata?.openclaw?.install as SkillInstallSpec[];
    expect(specs).toHaveLength(2);
    expect(specs.every((s) => s.formula === "coreutils" || s.package === "coreutils")).toBe(true);
  });

  it("bundled/regex-tester 不声明 install 字段", async () => {
    const file = path.join(BUNDLED_DIR, "regex-tester", "SKILL.md");
    const content = await readFile(file, "utf-8");
    const parser = new SKILLmdParser();
    const doc = await parser.parse(content);

    expect(doc.meta.metadata?.openclaw?.install).toBeUndefined();
    expect(doc.meta.metadata?.openclaw?.requires?.bins).toEqual([]);
  });
});
