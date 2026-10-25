/**
 * blueprint-skill-bridge.test — 技能前端标记桥接测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseBlueprintFromSkillMd,
  blueprintToJobSpec,
  exportBlueprintToSkillMd,
  listSkillBlueprints,
  parseBlueprintFromFile,
  BlueprintParseError,
  type BlueprintSpec,
} from "./blueprint-skill-bridge";
import type { ScheduleManager } from "./schedule-manager";

// ── 测试辅助 ──────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bp-bridge-test-"));
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
}

// ── parseBlueprintFromSkillMd ─────────────────────────

describe("parseBlueprintFromSkillMd", () => {
  it("解析完整的蓝图声明", () => {
    const md = `---
name: my-skill
description: A test skill
metadata:
  hermes:
    blueprint:
      schedule: "0 9 * * *"
      deliver: "notify"
      prompt: "Do something useful"
      no_agent: false
      model: "claude-sonnet"
      provider: "anthropic"
      enabled_toolsets: ["file", "web"]
---
# My Skill

Content here.
`;
    const spec = parseBlueprintFromSkillMd(md);
    expect(spec).not.toBeNull();
    expect(spec!.skillName).toBe("my-skill");
    expect(spec!.schedule).toBe("0 9 * * *");
    expect(spec!.deliver).toBe("notify");
    expect(spec!.prompt).toBe("Do something useful");
    expect(spec!.noAgent).toBe(false);
    expect(spec!.model).toBe("claude-sonnet");
    expect(spec!.provider).toBe("anthropic");
    expect(spec!.enabledToolsets).toEqual(["file", "web"]);
  });

  it("没有 frontmatter 时返回 null", () => {
    const md = `# My Skill

No frontmatter here.
`;
    expect(parseBlueprintFromSkillMd(md)).toBeNull();
  });

  it("有 frontmatter 但没有 blueprint 时返回 null", () => {
    const md = `---
name: my-skill
description: A test skill
---
# My Skill
`;
    expect(parseBlueprintFromSkillMd(md)).toBeNull();
  });

  it("有 blueprint 但没有 schedule 时返回 null", () => {
    const md = `---
name: my-skill
metadata:
  hermes:
    blueprint:
      prompt: "Do something"
---
# My Skill
`;
    expect(parseBlueprintFromSkillMd(md)).toBeNull();
  });

  it("schedule 为空字符串时返回 null", () => {
    const md = `---
name: my-skill
metadata:
  hermes:
    blueprint:
      schedule: ""
      prompt: "Do something"
---
# My Skill
`;
    expect(parseBlueprintFromSkillMd(md)).toBeNull();
  });

  it("使用默认值（deliver 默认 notify，noAgent 默认 false）", () => {
    const md = `---
name: my-skill
metadata:
  hermes:
    blueprint:
      schedule: "*/5 * * * *"
      prompt: "Check something"
---
# My Skill
`;
    const spec = parseBlueprintFromSkillMd(md);
    expect(spec).not.toBeNull();
    expect(spec!.deliver).toBe("notify");
    expect(spec!.noAgent).toBe(false);
    expect(spec!.prompt).toBe("Check something");
  });

  it("解析 no_agent: true", () => {
    const md = `---
name: my-skill
metadata:
  hermes:
    blueprint:
      schedule: "0 0 * * *"
      prompt: "Run directly"
      no_agent: true
---
# My Skill
`;
    const spec = parseBlueprintFromSkillMd(md);
    expect(spec).not.toBeNull();
    expect(spec!.noAgent).toBe(true);
  });

  it("解析块标量 prompt（多行）", () => {
    const md = `---
name: my-skill
metadata:
  hermes:
    blueprint:
      schedule: "0 9 * * *"
      prompt: |
        First line
        Second line
        Third line
---
# My Skill
`;
    const spec = parseBlueprintFromSkillMd(md);
    expect(spec).not.toBeNull();
    expect(spec!.prompt).toBe("First line\nSecond line\nThird line");
  });

  it("name 缺失时使用 'unknown'", () => {
    const md = `---
metadata:
  hermes:
    blueprint:
      schedule: "0 9 * * *"
      prompt: "Test"
---
# My Skill
`;
    const spec = parseBlueprintFromSkillMd(md);
    expect(spec).not.toBeNull();
    expect(spec!.skillName).toBe("unknown");
  });
});

// ── blueprintToJobSpec ───────────────────────────────

describe("blueprintToJobSpec", () => {
  it("转换蓝图到 job spec", () => {
    const spec: BlueprintSpec = {
      skillName: "my-skill",
      schedule: "0 9 * * *",
      deliver: "notify",
      prompt: "Do something",
      noAgent: false,
      model: "claude-sonnet",
      provider: "anthropic",
      enabledToolsets: ["file", "web"],
    };
    const jobSpec = blueprintToJobSpec(spec);
    expect(jobSpec.name).toBe("my-skill");
    expect(jobSpec.cronExpression).toBe("0 9 * * *");
    expect(jobSpec.handlerType).toBe("custom");
    expect(jobSpec.handlerConfig).toBeDefined();
    expect(jobSpec.handlerConfig!.prompt).toBe("Do something");
    expect(jobSpec.handlerConfig!.model).toBe("claude-sonnet");
    expect(jobSpec.handlerConfig!.provider).toBe("anthropic");
    expect(jobSpec.handlerConfig!.enabledToolsets).toEqual(["file", "web"]);
  });

  it("noAgent 为 true 时在 handlerConfig 中设置 noAgent", () => {
    const spec: BlueprintSpec = {
      skillName: "my-skill",
      schedule: "0 0 * * *",
      deliver: "notify",
      prompt: "Run directly",
      noAgent: true,
    };
    const jobSpec = blueprintToJobSpec(spec);
    expect(jobSpec.handlerConfig!.noAgent).toBe(true);
  });

  it("可选字段缺失时不设置", () => {
    const spec: BlueprintSpec = {
      skillName: "my-skill",
      schedule: "0 9 * * *",
      deliver: "notify",
      prompt: "Test",
      noAgent: false,
    };
    const jobSpec = blueprintToJobSpec(spec);
    expect(jobSpec.handlerConfig!.model).toBeUndefined();
    expect(jobSpec.handlerConfig!.provider).toBeUndefined();
    expect(jobSpec.handlerConfig!.enabledToolsets).toBeUndefined();
    expect(jobSpec.handlerConfig!.noAgent).toBeUndefined();
  });
});

// ── exportBlueprintToSkillMd ─────────────────────────

describe("exportBlueprintToSkillMd", () => {
  it("导出蓝图到 SKILL.md 格式", () => {
    const spec: BlueprintSpec = {
      skillName: "exported-skill",
      schedule: "0 9 * * *",
      deliver: "notify",
      prompt: "Do something",
      noAgent: false,
      model: "claude-sonnet",
      provider: "anthropic",
      enabledToolsets: ["file", "web"],
    };
    const task = { description: "Test task" } as any;
    const md = exportBlueprintToSkillMd(task, spec);

    expect(md).toContain("name: exported-skill");
    expect(md).toContain('schedule: "0 9 * * *"');
    expect(md).toContain('deliver: "notify"');
    expect(md).toContain("model: \"claude-sonnet\"");
    expect(md).toContain("provider: \"anthropic\"");
    expect(md).toContain('enabled_toolsets: ["file", "web"]');
    expect(md).toContain("# exported-skill");
  });

  it("导出后可被 parseBlueprintFromSkillMd 重新解析", () => {
    const original: BlueprintSpec = {
      skillName: "roundtrip-skill",
      schedule: "0 9 * * *",
      deliver: "notify",
      prompt: "Roundtrip test",
      noAgent: false,
    };
    const task = { description: "Test task" } as any;
    const md = exportBlueprintToSkillMd(task, original);
    const parsed = parseBlueprintFromSkillMd(md);

    expect(parsed).not.toBeNull();
    expect(parsed!.skillName).toBe("roundtrip-skill");
    expect(parsed!.schedule).toBe("0 9 * * *");
    expect(parsed!.deliver).toBe("notify");
    expect(parsed!.prompt).toBe("Roundtrip test");
  });

  it("noAgent 为 true 时导出 no_agent: true", () => {
    const spec: BlueprintSpec = {
      skillName: "direct-skill",
      schedule: "0 0 * * *",
      deliver: "notify",
      prompt: "Run directly",
      noAgent: true,
    };
    const task = { description: "Test" } as any;
    const md = exportBlueprintToSkillMd(task, spec);
    expect(md).toContain("no_agent: true");
  });
});

// ── listSkillBlueprints ───────────────────────────────

describe("listSkillBlueprints", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it("扫描目录发现携带蓝图的技能", () => {
    // 创建一个携带蓝图的技能
    const skillDir = path.join(tempDir, "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: my-skill
metadata:
  hermes:
    blueprint:
      schedule: "0 9 * * *"
      prompt: "Test"
---
# My Skill
`);

    // 创建一个不携带蓝图的技能
    const plainDir = path.join(tempDir, "plain-skill");
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, "SKILL.md"), `---
name: plain-skill
description: No blueprint
---
# Plain Skill
`);

    const blueprints = listSkillBlueprints(tempDir);
    expect(blueprints.length).toBe(1);
    expect(blueprints[0].skillName).toBe("my-skill");
  });

  it("空目录返回空数组", () => {
    expect(listSkillBlueprints(tempDir)).toEqual([]);
  });

  it("不存在的目录返回空数组", () => {
    expect(listSkillBlueprints("/nonexistent/path")).toEqual([]);
  });
});

// ── parseBlueprintFromFile ───────────────────────────

describe("parseBlueprintFromFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it("从文件解析蓝图", () => {
    const filePath = path.join(tempDir, "SKILL.md");
    fs.writeFileSync(filePath, `---
name: file-skill
metadata:
  hermes:
    blueprint:
      schedule: "0 9 * * *"
      prompt: "Test"
---
# File Skill
`);
    const spec = parseBlueprintFromFile(filePath);
    expect(spec).not.toBeNull();
    expect(spec!.skillName).toBe("file-skill");
  });

  it("文件不存在时返回 null", () => {
    expect(parseBlueprintFromFile("/nonexistent/SKILL.md")).toBeNull();
  });
});

// ── BlueprintParseError ───────────────────────────────

describe("BlueprintParseError", () => {
  it("是一个 Error 子类", () => {
    const err = new BlueprintParseError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BlueprintParseError");
  });
});
