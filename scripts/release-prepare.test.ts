import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bumpPatch, validateChangelog, prepare, atomicWrite } from "./release-prepare.mjs";

describe("release-prepare（P3-6 发布流水线本地阶段）", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeFixture(version: string, changelogBody: string) {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "evoclaw", version }, null, 2) + "\n");
    fs.writeFileSync(path.join(tmp, "CHANGELOG.md"), changelogBody);
  }

  describe("bumpPatch", () => {
    it("patch 位递增，minor/major 不动", () => {
      expect(bumpPatch("0.92.1")).toBe("0.92.2");
      expect(bumpPatch("1.0.0")).toBe("1.0.1");
    });
    it("非法版本号抛错", () => {
      expect(() => bumpPatch("v1.0")).toThrow();
      expect(() => bumpPatch("1.0")).toThrow();
    });
  });

  describe("validateChangelog", () => {
    const goodEntry = (v: string, d: string) =>
      `# Changelog\n\n## [${v}] - ${d}\n\n**摘要**\n\n### 根因与改动\n\n说明问题的根因与对应修法，足够长以通过最小正文长度限制。\n\n### 验证\n\n跑测试全绿，真实链路复测通过。\n`;

    it("完整条目通过", () => {
      const r = validateChangelog(goodEntry("0.92.2", "2026-10-14"), "0.92.2", "2026-10-14");
      expect(r.ok).toBe(true);
    });

    it("缺头条失败", () => {
      const r = validateChangelog("# Changelog\n", "0.92.2", "2026-10-14");
      expect(r.ok).toBe(false);
      expect(r.reasons[0]).toContain("缺少条目头");
    });

    it("缺验证小节失败", () => {
      const body = `# C\n\n## [0.92.2] - 2026-10-14\n\n### 根因与改动\n\n只有修法说明没有任何检查记录，而且内容要足够长凑够八十字符以上的长度限制要求。\n`;
      const r = validateChangelog(body, "0.92.2", "2026-10-14");
      expect(r.ok).toBe(false);
      expect(r.reasons.join()).toContain("验证");
    });

    it("缺根因类内容失败", () => {
      const body = `# C\n\n## [0.92.2] - 2026-10-14\n\n### 验证\n\n跑了一遍测试全都通过了，这段内容也足够长以通过最短长度的限制检查逻辑。\n`;
      const r = validateChangelog(body, "0.92.2", "2026-10-14");
      expect(r.ok).toBe(false);
      expect(r.reasons.join()).toContain("根因");
    });
  });

  describe("prepare 集成", () => {
    const valid = (v: string, d: string) =>
      `# Changelog\n\n## [${v}] - ${d}\n\n**摘要**\n\n### 根因与改动\n\n内容。\n\n### 验证\n\n通过。\n` + "x".repeat(80);

    it("校验通过后写入 package.json 新版本", () => {
      writeFixture("0.92.1", valid("0.92.2", "2026-10-14"));
      const r = prepare({ cwd: tmp, today: "2026-10-14" });
      expect(r.ok).toBe(true);
      expect(r.written).toBe(true);
      expect(r.target).toBe("0.92.2");
      const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf-8"));
      expect(pkg.version).toBe("0.92.2");
    });

    it("dry-run 校验通过但不写盘", () => {
      writeFixture("0.92.1", valid("0.92.2", "2026-10-14"));
      const r = prepare({ cwd: tmp, dryRun: true, today: "2026-10-14" });
      expect(r.ok).toBe(true);
      expect(r.written).toBe(false);
      const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf-8"));
      expect(pkg.version).toBe("0.92.1");
    });

    it("缺 changelog 条目时不写盘并返回原因", () => {
      writeFixture("0.92.1", "# Changelog\n\n## [0.92.1] - 2026-10-11\n\n旧条目。\n");
      const r = prepare({ cwd: tmp, today: "2026-10-14" });
      expect(r.ok).toBe(false);
      expect(r.written).toBe(false);
      expect(r.reasons.join()).toContain("0.92.2");
      const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf-8"));
      expect(pkg.version).toBe("0.92.1");
    });

    it("显式 --version 支持 minor 升级", () => {
      writeFixture("0.92.1", valid("0.93.0", "2026-10-14"));
      const r = prepare({ cwd: tmp, version: "0.93.0", today: "2026-10-14" });
      expect(r.ok).toBe(true);
      expect(r.target).toBe("0.93.0");
    });
  });

  describe("atomicWrite", () => {
    it("覆盖写入且无 tmp 残留", () => {
      const f = path.join(tmp, "state.json");
      atomicWrite(f, '{"a":1}');
      atomicWrite(f, '{"a":2}');
      expect(fs.readFileSync(f, "utf-8")).toBe('{"a":2}');
      const leftovers = fs.readdirSync(tmp).filter((n) => n.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    });
  });
});
