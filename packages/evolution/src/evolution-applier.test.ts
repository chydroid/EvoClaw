import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ServiceRegistry, EventBus, type EvolutionCandidate, type EvolutionCycle, type Skill } from "@evoclaw/core";
import { EvolutionApplier } from "../src/evolution-applier";
import { SkillAutoGenerator } from "../src/skill-auto-generator";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function makeCandidate(overrides: Partial<EvolutionCandidate> = {}): EvolutionCandidate {
  return {
    id: "candidate-1",
    type: "skill_update",
    proposedChanges: {
      description: "Add retry with exponential backoff for transient network errors",
      codeChanges: [],
      configChanges: {},
    },
    codeArtifacts: [
      {
        name: "retry.ts",
        language: "typescript",
        source: "export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> { return fn(); }",
        tests: "",
        dependencies: [],
      },
    ],
    risk: { level: "low", factors: ["transient"], mitigation: "sandbox" },
    generatedAt: new Date(),
    ...overrides,
  };
}

function makeCycle(overrides: Partial<EvolutionCycle> = {}): EvolutionCycle {
  return {
    id: "cycle-1",
    status: "publishing",
    source: "task_failure",
    targetSkill: null,
    input: {
      triggerEvent: "task_failure",
      context: {},
      failureLogs: [],
      successRate: 0,
      relatedSkills: [],
    },
    candidates: [],
    selectedCandidate: null,
    evaluation: null,
    feedback: null,
    startedAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

interface MockSkillManager {
  installSkill: (p: string, force?: boolean) => Promise<Skill>;
  getSkill: (id: string) => Promise<Skill | undefined>;
  listSkills: () => Promise<Skill[]>;
  installed: string[];
  skills: Map<string, Skill>;
}

function makeSkillManager(skillsDir: string): MockSkillManager {
  const installed: string[] = [];
  const skills = new Map<string, Skill>();
  return {
    installed,
    skills,
    async installSkill(p: string) {
      installed.push(p);
      const name = path.basename(path.dirname(p));
      const skill = {
        id: `skill-${name}`,
        name,
        version: "1.0.0",
        installPath: p,
        lifecycle: { version: "1.0.0", lastUpdated: new Date(), status: "active" as const },
      } as unknown as Skill;
      skills.set(skill.id, skill);
      return skill;
    },
    async getSkill(id: string) {
      return skills.get(id);
    },
    async listSkills() {
      return Array.from(skills.values());
    },
  };
}

describe("EvolutionApplier", () => {
  let tmpDir: string;
  let storeDir: string;
  let skillsDir: string;
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let appliedEvents: Array<{ mode: string; detail: string }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-applier-"));
    storeDir = path.join(tmpDir, "evolution");
    skillsDir = path.join(tmpDir, "skills");
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    appliedEvents = [];
    eventBus.subscribe("evolution.applied", async (e) => {
      appliedEvents.push({ mode: (e.data as { mode: string }).mode, detail: (e.data as { detail: string }).detail });
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeApplier() {
    return new EvolutionApplier(
      registry,
      eventBus,
      storeDir,
      new SkillAutoGenerator(path.join(tmpDir, "skill-auto-gen"))
    );
  }

  it("new_skill: 生成 SKILL.md 并 installSkill", async () => {
    const mgr = makeSkillManager(skillsDir);
    registry.registerService("skillManager", mgr);
    const applier = makeApplier();

    const candidate = makeCandidate({
      id: "candidate-new",
      type: "new_skill",
      proposedChanges: {
        description: "Fetch latest stock prices from yahoo finance api and compute daily moving averages",
        codeChanges: [],
        configChanges: {},
      },
    });
    const cycle = makeCycle({ candidates: [candidate], selectedCandidate: candidate.id });

    const result = await applier.applyCandidate(cycle, candidate);

    expect(result.applied).toBe(true);
    expect(result.mode).toBe("installed");
    expect(mgr.installed).toHaveLength(1);
    expect(fs.existsSync(result.target!)).toBe(true);
    expect(result.target!.endsWith("SKILL.md")).toBe(true);
    expect(appliedEvents[0]?.mode).toBe("installed");
  });

  it("skill_update: 追加补丁 + 版本递增 + 备份", async () => {
    const mgr = makeSkillManager(skillsDir);
    registry.registerService("skillManager", mgr);
    // 预置一个技能目录
    const skillDir = path.join(skillsDir, "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillMd = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillMd, "---\nname: my-skill\nversion: 1.0.0\n---\n\n# my-skill\n", "utf-8");
    fs.writeFileSync(path.join(skillDir, "_meta.json"), JSON.stringify({ name: "my-skill", version: "1.0.0" }), "utf-8");
    const skill = await mgr.installSkill(skillMd);

    const applier = makeApplier();
    const candidate = makeCandidate();
    const cycle = makeCycle({ targetSkill: skill.id, candidates: [candidate], selectedCandidate: candidate.id });

    const result = await applier.applyCandidate(cycle, candidate);

    expect(result.applied).toBe(true);
    expect(result.mode).toBe("skill_updated");

    const updated = fs.readFileSync(skillMd, "utf-8");
    expect(updated).toContain(`evolution-patch:${candidate.id}`);
    expect(updated).toContain("Evolution Patch");
    expect(updated).toMatch(/version:\s*1\.0\.1/);

    // 备份存在
    const backups = fs.readdirSync(path.join(storeDir, "backups", skill.id));
    expect(backups.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(storeDir, "backups", skill.id, backups[0]), "utf-8")).not.toContain("Evolution Patch");

    // _meta.json 版本同步
    const meta = JSON.parse(fs.readFileSync(path.join(skillDir, "_meta.json"), "utf-8"));
    expect(meta.version).toBe("1.0.1");
  });

  it("skill_update: 重复补丁跳过", async () => {
    const mgr = makeSkillManager(skillsDir);
    registry.registerService("skillManager", mgr);
    const skillDir = path.join(skillsDir, "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillMd = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillMd, "---\nname: my-skill\nversion: 1.0.0\n---\n", "utf-8");
    const skill = await mgr.installSkill(skillMd);

    const applier = makeApplier();
    const candidate = makeCandidate();
    const cycle = makeCycle({ targetSkill: skill.id, candidates: [candidate], selectedCandidate: candidate.id });

    expect((await applier.applyCandidate(cycle, candidate)).mode).toBe("skill_updated");
    const second = await applier.applyCandidate(cycle, candidate);
    expect(second.applied).toBe(false);
    expect(second.mode).toBe("skipped");
  });

  it("code_patch 无目标技能: 归档产物 + manifest", async () => {
    registry.registerService("skillManager", makeSkillManager(skillsDir));
    const applier = makeApplier();
    const candidate = makeCandidate({ type: "code_patch" });
    const cycle = makeCycle({ candidates: [candidate], selectedCandidate: candidate.id });

    const result = await applier.applyCandidate(cycle, candidate);

    expect(result.applied).toBe(true);
    expect(result.mode).toBe("archived");
    const manifestPath = path.join(storeDir, "applied", cycle.id, `${candidate.id}.manifest.json`);
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.candidateId).toBe(candidate.id);
    expect(manifest.source).toBe("task_failure");
    expect(fs.existsSync(path.join(storeDir, "applied", cycle.id, `${candidate.id}.ts`))).toBe(true);
  });

  it("config_change: 写入 config-pending，不自动应用", async () => {
    registry.registerService("skillManager", makeSkillManager(skillsDir));
    const applier = makeApplier();
    const candidate = makeCandidate({
      id: "candidate-cfg",
      type: "config_change",
      proposedChanges: { description: "Raise max concurrency", codeChanges: [], configChanges: { maxConcurrency: 8 } },
      codeArtifacts: [],
    });
    const cycle = makeCycle({ candidates: [candidate], selectedCandidate: candidate.id });

    const result = await applier.applyCandidate(cycle, candidate);

    expect(result.applied).toBe(false);
    expect(result.mode).toBe("config_pending");
    expect(fs.existsSync(result.target!)).toBe(true);
  });

  it("rollback: 从备份恢复原 SKILL.md", async () => {
    const mgr = makeSkillManager(skillsDir);
    registry.registerService("skillManager", mgr);
    const skillDir = path.join(skillsDir, "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillMd = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillMd, "---\nname: my-skill\nversion: 1.0.0\n---\n\n# my-skill\n", "utf-8");
    const skill = await mgr.installSkill(skillMd);

    const applier = makeApplier();
    const candidate = makeCandidate();
    const cycle = makeCycle({ targetSkill: skill.id, candidates: [candidate], selectedCandidate: candidate.id });
    await applier.applyCandidate(cycle, candidate);

    expect(fs.readFileSync(skillMd, "utf-8")).toContain("Evolution Patch");

    await applier.handleHotReload({ skillId: skill.id, action: "rollback", strategy: "immediate" });

    const restored = fs.readFileSync(skillMd, "utf-8");
    expect(restored).not.toContain("Evolution Patch");
    expect(restored).toContain("# my-skill");
  });

  it("hotreload install: 路径存在时调用 installSkill", async () => {
    const mgr = makeSkillManager(skillsDir);
    registry.registerService("skillManager", mgr);
    const applier = makeApplier();

    const skillDir = path.join(skillsDir, "hot-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillMd = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillMd, "---\nname: hot-skill\nversion: 1.0.0\n---\n", "utf-8");

    await applier.handleHotReload({ skillId: skillMd, action: "install", strategy: "graceful" });

    expect(mgr.installed).toContain(skillMd);
  });

  it("hotreload remove: 不删除（archive-only 原则）", async () => {
    registry.registerService("skillManager", makeSkillManager(skillsDir));
    const applier = makeApplier();

    const skillDir = path.join(skillsDir, "keep-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillMd = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillMd, "---\nname: keep-skill\nversion: 1.0.0\n---\n", "utf-8");

    await applier.handleHotReload({ skillId: skillMd, action: "remove", strategy: "immediate" });

    expect(fs.existsSync(skillMd)).toBe(true);
  });
});
