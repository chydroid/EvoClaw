/**
 * skill-ledger × SkillCurator 集成测试 — ledger 编辑级回滚的真实链路接线验证：
 *   - persistSkillUpdate（白盒）→ edit 条目 → rollback 撤销版本改写
 *   - archiveSkill（生产路径）→ archive 整包快照条目 → rollback 恢复原目录 + 清归档副本
 * 单文件独立运行（避免长 curator 测试文件叠加 onTaskUpdate RPC 截止抖动）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ServiceRegistry, EventBus, type Skill } from "@evoclaw/core";
import { SkillCurator, type SkillEvolutionEntry } from "../src/skill-curator";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("skill-ledger × SkillCurator 集成", () => {
  let tmpRoot: string;

  function setup() {
    const skillsDir = path.join(tmpRoot, "skills");
    const archiveDir = path.join(tmpRoot, "skills-archive");
    const dataDir = path.join(tmpRoot, "skill-curator");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    registry.registerService("eventBus", eventBus);
    const curator = new SkillCurator(
      registry,
      eventBus,
      skillsDir,
      archiveDir,
      dataDir,
      path.join(tmpRoot, "logs", "curator")
    );
    return { curator, skillsDir, archiveDir };
  }

  function seedSkillDir(skillsDir: string, name: string): string {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\nversion: 1.0.0\n---\n# ${name}\nInstructions here.\n`
    );
    return dir;
  }

  describe("persistSkillUpdate → edit 条目 → rollback", () => {
    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-ledger-curator-"));
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("账本集成（白盒）：persistSkillUpdate 记录 edit 条目；rollback 撤销版本改写", async () => {
      const { curator, skillsDir } = setup();
      const skillName = "ledger-edit-skill";
      const skillDir = seedSkillDir(skillsDir, skillName);
      const skillMd = path.join(skillDir, "SKILL.md");
      expect(fs.readFileSync(skillMd, "utf-8")).toContain("version: 1.0.0");

      // 白盒调用私有 persistSkillUpdate（Hermes skill_manage 编辑语义等价体）：
      // 触发版本改写 + before/after 账本遥测链路。
      const cast = curator as unknown as {
        persistSkillUpdate(skill: Skill, entry: SkillEvolutionEntry): Promise<void>;
      };
      const skillId = seedEvolutionEntryId(skillName);
      await cast.persistSkillUpdate(
        { installPath: skillMd, version: "1.1.0" } as unknown as Skill,
        { skillId } as unknown as SkillEvolutionEntry
      );

      // 磁盘：frontmatter 版本被改写 1.0.0 → 1.1.0
      expect(fs.readFileSync(skillMd, "utf-8")).toContain("version: 1.1.0");

      // 账本：一条 edit 条目，before=v1 blob / after=v1.1 blob
      const entries = curator.listLedgerEntries(skillName);
      const edit = entries.find((e) => e.action === "edit");
      expect(edit).toBeDefined();
      expect(edit!.skill).toBe(skillName);
      expect(edit!.evidence).toMatchObject({ version: "1.1.0" });

      // rollback → 恢复 before 快照（1.0.0）
      const out = await curator.rollbackLedgerEntry(edit!.id);
      expect(out.ok).toBe(true);
      expect(fs.readFileSync(skillMd, "utf-8")).toContain("version: 1.0.0");

      // pre-rollback 安全条目落账本
      expect(
        curator.listLedgerEntries(skillName).some((e) => e.action === "pre-rollback")
      ).toBe(true);

      curator.dispose();
    });

    it("installPath 缺失/不存在 → persistSkillUpdate 零账本条目（仓库遍历回归钉）", async () => {
      const { curator } = setup();
      const cast = curator as unknown as {
        persistSkillUpdate(skill: Skill, entry: SkillEvolutionEntry): Promise<void>;
      };
      // 旧实现：installPath "" → dirname "." → ledgerCapture 全仓遍历（28.9s/次 +
      // skill:"." 全仓快照条目）。修复后：不写文件、不记账本、不抛。
      await cast.persistSkillUpdate(
        { installPath: "", version: "1.1.0" } as unknown as Skill,
        { skillId: "test-skill-id" } as unknown as SkillEvolutionEntry
      );
      await cast.persistSkillUpdate(
        {
          installPath: path.join(tmpRoot, "skills", "ghost", "SKILL.md"),
          version: "1.1.0",
        } as unknown as Skill,
        { skillId: "test-skill-id" } as unknown as SkillEvolutionEntry
      );
      expect(curator.listLedgerEntries()).toEqual([]);
      curator.dispose();
    });
  });

  describe("archiveSkill → archive 条目 → rollback", () => {
    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-ledger-archive-"));
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("账本集成：archive 记录整包快照；rollback 恢复原目录且清理归档副本", async () => {
      const { curator, skillsDir, archiveDir } = setup();
      const skillName = "ledger-archive-skill";
      const skillDir = seedSkillDir(skillsDir, skillName);

      await curator.archiveSkill(skillName);
      expect(fs.existsSync(skillDir)).toBe(false);

      // 账本：archive 条目 before 为归档前整包（completePackage）
      const archive = curator.listLedgerEntries(skillName).find((e) => e.action === "archive");
      expect(archive).toBeDefined();
      expect(archive!.before.length).toBeGreaterThan(0);

      // rollback archive 条目 → 原始技能目录恢复
      const out = await curator.rollbackLedgerEntry(archive!.id);
      expect(out.ok).toBe(true);
      expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
      expect(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")).toContain("Instructions here.");

      // 归档副本（after-only 路径）被清理——无 SKILL.md 残留
      const archiveHasSkillMd = (function walk(dir: string): boolean {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          if (fs.statSync(p).isDirectory()) {
            if (walk(p)) return true;
          } else if (name === "SKILL.md") return true;
        }
        return false;
      })(archiveDir);
      expect(archiveHasSkillMd).toBe(false);

      curator.dispose();
    });
  });
});

/** seedEvolutionEntry 的最小替身（仅供白盒调用签名占位）。 */
function seedEvolutionEntryId(_skillName: string): string {
  return "test-skill-id";
}
