import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillEvolver, parseFilesBlock, extractChangeSummary, type EvolverSkill } from "./skill-evolver";
import { LineageStore, readSkillIdSidecar } from "@evoclaw/skills";
import type { EvolutionSuggestion } from "@evoclaw/skills";

const SKILL_MD = `---
name: demo
description: Demo skill
triggers:
  - demo
version: 1.0.0
---

# Demo

Run pdftotext on the input file.
`;

function fixSuggestion(reason = "pdftotext fails on layout"): EvolutionSuggestion {
  return {
    type: "fix",
    targetSkillIds: ["demo"],
    reason,
    proposedChange: reason,
    triggeredBy: "post-analysis",
    llmConfirmed: false,
    createdAt: Date.now(),
  };
}

class FakeSkillManager {
  skills: EvolverSkill[];
  installCalls: string[] = [];
  reloadCalls: string[] = [];

  constructor(skills: EvolverSkill[]) {
    this.skills = skills;
  }

  async listSkills(): Promise<EvolverSkill[]> {
    return this.skills;
  }

  async installSkill(skillPath: string): Promise<EvolverSkill> {
    this.installCalls.push(skillPath);
    const name = /name:\s*(.+)/.exec(fs.readFileSync(skillPath, "utf-8"))?.[1]?.trim() || "new";
    const skill = { id: `id-${this.skills.length}`, name, installPath: skillPath };
    this.skills.push(skill);
    return skill;
  }

  async reloadSkillFromDisk(idOrPath: string): Promise<void> {
    this.reloadCalls.push(idOrPath);
  }
}

function patchResponse(): string {
  return `CHANGE_SUMMARY: use -layout

*** Begin Patch
*** Update File: SKILL.md
@@ -1 +1 @@
-Run pdftotext on the input file.
+Run pdftotext -layout on the input file.
*** End Patch

<EVOLUTION_COMPLETE>`;
}

function capturedResponse(): string {
  return `CHANGE_SUMMARY: capture pdf table workflow

*** Begin Files
*** File: SKILL.md
---
name: pdf-table-pipeline
description: Extract tables from PDFs
triggers:
  - pdf
---

# PDF Table Pipeline

1. pdftotext -layout
*** End Files

<EVOLUTION_COMPLETE>`;
}

describe("SkillEvolver FIX", () => {
  let dataDir: string;
  let skillDir: string;
  let skillMd: string;
  let manager: FakeSkillManager;
  let lineage: LineageStore;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-evolver-"));
    skillDir = path.join(dataDir, "skills", "demo");
    fs.mkdirSync(skillDir, { recursive: true });
    skillMd = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillMd, SKILL_MD);
    manager = new FakeSkillManager([{ id: "demo-id", name: "demo", installPath: skillMd }]);
    lineage = new LineageStore(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("应用补丁、备份原文件、刷新 SkillManager、记录 FIX 血缘并失活父版本", async () => {
    const parentId = fs.existsSync(path.join(skillDir, ".skill_id"))
      ? readSkillIdSidecar(skillDir)
      : null;
    const complete = vi.fn().mockResolvedValue(patchResponse());
    const evolver = new SkillEvolver({
      skillsRoot: path.join(dataDir, "skills"),
      dataDir,
      complete,
      lineageStore: lineage,
      skillManager: manager,
    });

    const result = await evolver.evolve(fixSuggestion());
    expect(result).not.toBeNull();
    expect(result!.evolutionType).toBe("fix");
    expect(fs.readFileSync(skillMd, "utf-8")).toContain("pdftotext -layout");

    // 备份目录存在原内容
    const backupRoot = path.join(dataDir, "skill-curator", "evolver-backups", "demo");
    expect(fs.existsSync(backupRoot)).toBe(true);
    const backups = fs.readdirSync(backupRoot);
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupRoot, backups[0]), "utf-8")).toContain(
      "Run pdftotext on the input file.",
    );

    // 刷新 + 血缘
    expect(manager.reloadCalls).toContain(skillMd);
    const child = lineage.getLineage(result!.skillId);
    expect(child?.evolutionType).toBe("fix");
    expect(child?.parentIds).toHaveLength(1);
    if (parentId) {
      expect(child?.parentIds[0]).toBe(parentId);
      expect(lineage.getLineage(parentId)?.isActive).toBe(false);
    }
  });

  it("首次补丁失败时回灌错误并重试（≤3 次）", async () => {
    const bad = `CHANGE_SUMMARY: bad

*** Begin Patch
*** Update File: SKILL.md
@@ -1 +1 @@
-DOES NOT EXIST
+whatever
*** End Patch`;
    const complete = vi.fn()
      .mockResolvedValueOnce(bad)
      .mockResolvedValueOnce(patchResponse());
    const evolver = new SkillEvolver({
      skillsRoot: path.join(dataDir, "skills"),
      dataDir,
      complete,
      lineageStore: lineage,
      skillManager: manager,
    });

    const result = await evolver.evolve(fixSuggestion());
    expect(result).not.toBeNull();
    expect(complete).toHaveBeenCalledTimes(2);
    expect((complete.mock.calls[1][0] as { prompt: string }).prompt).toContain("Previous attempts failed");
    expect(fs.readFileSync(skillMd, "utf-8")).toContain("pdftotext -layout");
  });

  it("LLM 自评失败令牌 → 不修改文件", async () => {
    const complete = vi.fn().mockResolvedValue("<EVOLUTION_FAILED>\nReason: too vague");
    const evolver = new SkillEvolver({
      skillsRoot: path.join(dataDir, "skills"),
      dataDir,
      complete,
      lineageStore: lineage,
      skillManager: manager,
    });
    expect(await evolver.evolve(fixSuggestion())).toBeNull();
    expect(fs.readFileSync(skillMd, "utf-8")).toBe(SKILL_MD);
  });

  it("补丁路径逃逸被拒绝，技能目录外不产生文件", async () => {
    const escape = `CHANGE_SUMMARY: escape

*** Begin Patch
*** Add File: ../evil.md
+owned
*** End Patch`;
    const evolver = new SkillEvolver({
      skillsRoot: path.join(dataDir, "skills"),
      dataDir,
      complete: vi.fn().mockResolvedValue(escape),
      lineageStore: lineage,
      skillManager: manager,
      maxAttempts: 1,
    });
    expect(await evolver.evolve(fixSuggestion())).toBeNull();
    expect(fs.existsSync(path.join(dataDir, "skills", "evil.md"))).toBe(false);
    expect(fs.readFileSync(skillMd, "utf-8")).toBe(SKILL_MD);
  });
});

describe("SkillEvolver CAPTURED", () => {
  let dataDir: string;
  let manager: FakeSkillManager;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-evolver-new-"));
    manager = new FakeSkillManager([]);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("解析 *** Begin Files 块、写入 evolved 目录并安装", async () => {
    const evolver = new SkillEvolver({
      skillsRoot: path.join(dataDir, "skills"),
      dataDir,
      complete: vi.fn().mockResolvedValue(capturedResponse()),
      lineageStore: new LineageStore(dataDir),
      skillManager: manager,
    });
    const suggestion: EvolutionSuggestion = {
      type: "captured",
      targetSkillIds: [],
      reason: "extract pdf tables",
      proposedChange: "extract pdf tables",
      category: "workflow",
      triggeredBy: "post-analysis",
      llmConfirmed: false,
      createdAt: Date.now(),
    };

    const result = await evolver.evolve(suggestion);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("pdf-table-pipeline");
    expect(result!.parentIds).toEqual([]);
    expect(result!.skillDir).toContain(path.join("skills", "evolved"));
    expect(fs.existsSync(result!.path)).toBe(true);
    expect(manager.installCalls).toEqual([result!.path]);
    expect(readSkillIdSidecar(result!.skillDir)).toBe(result!.skillId);
  });

  it("无合法 frontmatter 时重试并在耗尽后返回 null", async () => {
    const evolver = new SkillEvolver({
      skillsRoot: path.join(dataDir, "skills"),
      dataDir,
      complete: vi.fn().mockResolvedValue("CHANGE_SUMMARY: nope\n\nnot a skill"),
      skillManager: manager,
      maxAttempts: 2,
    });
    const suggestion: EvolutionSuggestion = {
      type: "captured",
      targetSkillIds: [],
      reason: "x",
      proposedChange: "x",
      triggeredBy: "post-analysis",
      llmConfirmed: false,
      createdAt: Date.now(),
    };
    expect(await evolver.evolve(suggestion)).toBeNull();
  });
});

describe("SkillEvolver parsers", () => {
  it("extractChangeSummary / parseFilesBlock", () => {
    expect(extractChangeSummary("CHANGE_SUMMARY: hello world\nrest")).toBe("hello world");
    const files = parseFilesBlock("*** Begin Files\n*** File: a.md\nA\n*** File: b/c.md\nB\n*** End Files");
    expect(files.get("a.md")).toBe("A");
    expect(files.get("b/c.md")).toBe("B");
  });
});
