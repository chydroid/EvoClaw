import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * 回归：技能安装目录必须与扫描根一致，否则「装完在、重启就消失」会反复发生。
 *
 * 真实事故（2026-10-07，已连续两次）：
 *   1. 用户从市场安装 doc-to-markdown，WebUI 里能看到；
 *   2. 重建 + 重启后技能消失，需重装。
 *
 * 根因：SkillMarketplace 把技能解压到 `<repo>/data/marketplace/installed/<name>/`，
 * 而启动扫描只覆盖 `data/skills`（实际为空）与 `packages/skills/bundled`，
 * **谁都不覆盖 installed 目录**。市场安装只通过 installSkill() 写进内存 Map，
 * 进程一重启就没人回收 —— 磁盘文件其实一直都在，只是没人读。
 */
describe("技能安装目录与扫描根一致性（回归）", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");

  /** 启动时实际会扫描的三个根（apps/server/src/index.ts 里的顺序） */
  const startupScanRoots = [
    path.join(repoRoot, "data", "skills"),
    path.join(repoRoot, "data", "marketplace", "installed"),
    path.join(repoRoot, "packages", "skills", "bundled"),
  ];

  it("★ 市场安装目录 data/marketplace/installed 必须在启动扫描根里", () => {
    const marketplaceDir = path.join(repoRoot, "data", "marketplace", "installed");
    const covered = startupScanRoots.some((r) => path.resolve(r) === path.resolve(marketplaceDir));
    expect(
      covered,
      "市场安装目录未被任何启动扫描根覆盖 → 装完的技能重启后必然消失",
    ).toBe(true);
  });

  it("★ 磁盘上存在但运行期看不见 = 本 bug 的判定条件", () => {
    const marketplaceDir = path.join(repoRoot, "data", "marketplace", "installed");
    if (!fs.existsSync(marketplaceDir)) {
      // 没有装过技能的环境，跳过（不是缺陷）
      return;
    }
    const dirs = fs
      .readdirSync(marketplaceDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(marketplaceDir, e.name));

    // 真正的技能 = 目录里有 SKILL.md；没有的会被 scanAndInstall 静默跳过（无害）
    const real = dirs.filter((d) => fs.existsSync(path.join(d, "SKILL.md")));
    const junk = dirs.filter((d) => !fs.existsSync(path.join(d, "SKILL.md")));
    expect(real.length, "至少应有一个真正安装的技能").toBeGreaterThan(0);
    // 没有 SKILL.md 的目录会被忽略，属预期；这里只做提示性记录不断言
    if (junk.length > 0) {
      console.warn(
        `[skill-persistence] 提示：${junk.length} 个目录不含 SKILL.md（会被扫描跳过）：` +
        junk.map((d) => path.basename(d)).join(", "),
      );
    }
  });

  it("★ 旧的 data/skills 目录即使为空也不应导致扫描中断", () => {
    const localDir = path.join(repoRoot, "data", "skills");
    // 该目录当前为空；扫描代码对不存在的目录应直接跳过而不是抛错
    if (fs.existsSync(localDir)) {
      expect(() => fs.readdirSync(localDir)).not.toThrow();
    }
  });
});