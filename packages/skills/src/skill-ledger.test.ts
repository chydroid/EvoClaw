/**
 * skill-ledger 单测 — 对齐 Hermes tests/tools/test_skill_ledger*.py 契约。
 * 覆盖：blob 往返/去重、瞬态目录排除、delta 增量、rollback fail-closed
 * （blob 缺失/路径逃逸/安全条目失败）、最新编辑回滚、维护裁剪+GC、账本健壮性。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillLedger, type ManifestItem } from "../src/skill-ledger";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

interface Dirs {
  root: string;
  skillsDir: string;
  archiveDir: string;
  storeDir: string;
}

/** 建临时根目录布局。 */
function mkDirs(): Dirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-ledger-"));
  return {
    root,
    skillsDir: path.join(root, "skills"),
    archiveDir: path.join(root, "skills-archive"),
    storeDir: path.join(root, "skill-curator"),
  };
}

/** 写文件并递归建父目录。 */
function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

/** 老化 blob（用于超过 GC 宽限期的测试）。 */
function ageBlob(blobsDir: string, sha256: string, olderThanSec: number): void {
  const p = path.join(blobsDir, sha256);
  const old = (Date.now() / 1000 - olderThanSec) * 1000;
  fs.utimesSync(p, new Date(old), new Date(old));
}

describe("skill-ledger", () => {
  let dirs: Dirs;
  let ledger: SkillLedger;

  beforeEach(() => {
    dirs = mkDirs();
    ledger = new SkillLedger(dirs);
  });

  afterEach(() => {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  });

  describe("blob 存储", () => {
    it("storeBlob/readBlob 往返一致 + sha256 去重", () => {
      const a = ledger.storeBlob(Buffer.from("hello ledger"));
      const b = ledger.storeBlob(Buffer.from("hello ledger")); // 同内容 → 同哈希
      const c = ledger.storeBlob(Buffer.from("different"));
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(c).not.toBe(a);
      expect(ledger.readBlob(a)).toEqual(Buffer.from("hello ledger"));
      expect(ledger.readBlob(c)).toEqual(Buffer.from("different"));
    });

    it("readBlob：缺失/非法哈希 → null（安全上界：路径含 ../ 亦被拒）", () => {
      expect(ledger.readBlob("")).toBeNull();
      expect(ledger.readBlob("../etc/passwd")).toBeNull();
      expect(ledger.readBlob("zzzz")).toBeNull();
      const sha = ledger.storeBlob(Buffer.from("x"));
      fs.rmSync(path.join(dirs.storeDir, "ledger-blobs", sha));
      expect(ledger.readBlob(sha)).toBeNull();
    });
  });

  describe("snapshotPaths", () => {
    it("root 缺失 → []；单文件 root → 该文件", () => {
      expect(ledger.snapshotPaths(path.join(dirs.skillsDir, "nope"))).toEqual([]);
      const file = path.join(dirs.skillsDir, "standalone.md");
      writeFile(file, "S");
      const snap = ledger.snapshotPaths(file);
      expect(snap).toHaveLength(1);
      expect(snap[0].path).toBe(file);
    });

    it("瞬态目录（venv/node_modules/__pycache__/.git）任意深度排除", () => {
      const skill = path.join(dirs.skillsDir, "s");
      writeFile(path.join(skill, "SKILL.md"), "v1");
      writeFile(path.join(skill, "support.txt"), "x");
      writeFile(path.join(skill, "node_modules", "pkg", "index.js"), "big");
      writeFile(path.join(skill, ".venv", "pyvenv.cfg"), "cfg");
      writeFile(path.join(skill, "__pycache__", "mod.pyc"), "pyc");
      const paths = ledger.snapshotPaths(skill).map((i) => path.relative(dirs.skillsDir, i.path));
      expect(paths).toEqual(["s/SKILL.md", "s/support.txt"]);
    });
  });

  describe("delta 记录 + rollback", () => {
    it("条目只存两侧不同的路径；rollback 精确恢复 before+删除 after-only", async () => {
      const skill = path.join(dirs.skillsDir, "big");
      writeFile(path.join(skill, "SKILL.md"), "v1");
      writeFile(path.join(skill, "references", "a.md"), "same");
      writeFile(path.join(skill, "references", "gone.md"), "old");
      // 变异前快照（事件语义：变异开始时抓）。
      const before = ledger.snapshotPaths(skill);
      // 变异：SKILL v1→v2、删除 gone.md、新增 new.md（a.md 不变）。
      writeFile(path.join(skill, "SKILL.md"), "v2");
      fs.rmSync(path.join(skill, "references", "gone.md"));
      writeFile(path.join(skill, "references", "new.md"), "added");
      const entryId = await ledger.appendEntry(
        "patch",
        "big",
        before,
        ledger.snapshotPaths(skill),
        "agent"
      );
      expect(entryId).toBeTruthy();
      const entry = ledger.getEntry(entryId!);
      const names = (items: Array<{ path: string }>) =>
        items.map((i) => path.basename(i.path)).sort();
      expect(names(entry!.before)).toEqual(["SKILL.md", "gone.md"]);
      expect(names(entry!.after)).toEqual(["SKILL.md", "new.md"]);
      expect(names(entry!.before).length).toBe(2); // delta 裁剪：references/a.md 两侧同哈希 → 消失

      const out = await ledger.rollbackEntry(entryId!);
      expect(out.ok).toBe(true);
      expect(fs.readFileSync(path.join(skill, "SKILL.md"), "utf-8")).toBe("v1");
      expect(fs.readFileSync(path.join(skill, "references", "a.md"), "utf-8")).toBe("same");
      expect(fs.readFileSync(path.join(skill, "references", "gone.md"), "utf-8")).toBe("old");
      expect(fs.existsSync(path.join(skill, "references", "new.md"))).toBe(false);
    });

    it("回滚最新编辑（restoreLatestEdit）语义，且健康账本上第二跳同样可用", async () => {
      const skill = path.join(dirs.skillsDir, "s");
      writeFile(path.join(skill, "SKILL.md"), "v1");
      const before1 = ledger.snapshotPaths(skill);
      writeFile(path.join(skill, "SKILL.md"), "v2");
      const id1 = await ledger.appendEntry("edit", "s", before1, ledger.snapshotPaths(skill), "agent");

      writeFile(path.join(skill, "SKILL.md"), "v3");
      const before2 = ledger.snapshotPaths(skill);
      const after2 = ledger.snapshotPaths(skill); // 同状态（未变）→ 条目两条路径同哈希会被 delta 清空
      const id2 = await ledger.appendEntry("edit", "s", before2, after2, "agent");

      // 最新条目 = id2（它 delta 为空——内容没变）。回滚它仍是 no-op。
      let out = await ledger.restoreLatestEdit("s");
      expect(out.ok).toBe(true);
      expect(fs.readFileSync(path.join(skill, "SKILL.md"), "utf-8")).toBe("v3");

      // 回滚 id1 → 撤销 v1→v2 编辑，回到 v1（before 状态；after-only 文件被删除）。
      out = await ledger.rollbackEntry(id1!);
      expect(out.ok).toBe(true);
      expect(fs.readFileSync(path.join(skill, "SKILL.md"), "utf-8")).toBe("v1");

      // 无条目技能 → fail（但已写盘 s，列出 2 条）
      await expect(ledger.restoreLatestEdit("nosuch")).resolves.toMatchObject({ ok: false });
    });

    it("before-blob 缺失 → fail-closed：什么都不改", async () => {
      const skill = path.join(dirs.skillsDir, "s");
      writeFile(path.join(skill, "SKILL.md"), "v1");
      const before = ledger.snapshotPaths(skill);
      writeFile(path.join(skill, "SKILL.md"), "v2");
      const entryId = await ledger.appendEntry("edit", "s", before, ledger.snapshotPaths(skill));

      // 删掉 before 需要恢复的 SKILL.md 对应 blob（v1 的 blob）。
      for (const item of before) fs.rmSync(path.join(dirs.storeDir, "ledger-blobs", item.sha256));

      const out = await ledger.rollbackEntry(entryId!);
      expect(out.ok).toBe(false);
      expect(out.message).toContain("rollback aborted");
      expect(fs.readFileSync(path.join(skill, "SKILL.md"), "utf-8")).toBe("v2"); // 磁盘未动
    });

    it("pre-rollback 安全条目失败（账本禁用）→ 中止，磁盘零改动", async () => {
      const skill = path.join(dirs.skillsDir, "s");
      writeFile(path.join(skill, "SKILL.md"), "v1");
      const before = ledger.snapshotPaths(skill);
      writeFile(path.join(skill, "SKILL.md"), "v2");
      const entryId = await ledger.appendEntry("edit", "s", before, ledger.snapshotPaths(skill));

      // 伪造"禁用"：新建禁用账本指向同一账本文件路径但 enable=false → append 全部 null
      const disabled = new SkillLedger({ ...dirs, ledgerEnabled: false });
      const out = await disabled.rollbackEntry(entryId!);
      expect(out.ok).toBe(false);
      expect(out.message).toContain("safety");
      expect(fs.readFileSync(path.join(skill, "SKILL.md"), "utf-8")).toBe("v2");
    });

    it("条目路径逃逸 → 拒绝回滚（手改账本不可变写原语）", async () => {
      const outside = path.join(dirs.root, "outside.txt");
      writeFile(outside, "evil");
      const fake = {
        id: "evil01",
        ts: new Date().toISOString(),
        actor: "user",
        action: "patch",
        skill: "evil",
        evidence: {},
        before: [{ path: outside, sha256: ledger.storeBlob(Buffer.from("evil")) }],
        after: [],
      };
      writeFile(path.join(dirs.storeDir, "ledger.jsonl"), JSON.stringify(fake) + "\n");

      const out = await ledger.rollbackEntry("evil01");
      expect(out.ok).toBe(false);
      expect(out.message).toContain("refusing");
    });

    it("回滚后追加 rollback 证据条目，rollback_target 指向被回滚条目", async () => {
      const skill = path.join(dirs.skillsDir, "s");
      writeFile(path.join(skill, "SKILL.md"), "v1");
      const before = ledger.snapshotPaths(skill);
      writeFile(path.join(skill, "SKILL.md"), "v2");
      const entryId = await ledger.appendEntry("edit", "s", before, ledger.snapshotPaths(skill));
      await ledger.rollbackEntry(entryId!);

      const entries = ledger.listEntries("s");
      const rollbacks = entries.filter((e) => e.action === "rollback");
      expect(rollbacks.length).toBe(1);
      expect(rollbacks[0].evidence).toMatchObject({ rollback_target: entryId });
      // pre-rollback 安全条目存在且完整记录回滚起点状态
      const safety = entries.find((e) => e.action === "pre-rollback");
      expect(safety).toBeDefined();
      expect(safety!.evidence).toMatchObject({ rollback_target: entryId });
      expect(safety!.before.length).toBeGreaterThan(0);
    });
  });

  describe("账本健壮性", () => {
    it("listEntries：账本缺失 → []（安静）；畸形行跳过；乱序按物理行序但返回最新在前", async () => {
      const id = await ledger.appendEntry("patch", "s", [], [], "agent");
      expect(id).toBeTruthy();
      writeFile(
        path.join(dirs.storeDir, "ledger.jsonl"),
        JSON.stringify({ ...ledger.getEntry(id!)!, id: "mal" }) + "\n" + "not json\n"
      );
      const entries = ledger.listEntries();
      expect(entries.map((e) => e.id)).toEqual(["mal"]); // 畸形行跳过、新在前
    });

    it("compact：已 delta 形态免重写；legacy 全量清单裁成增量（pre-rollback 保留整包）", async () => {
      const skill = path.join(dirs.skillsDir, "big");
      // 技能：SKILL.md(v1) + 5 个两侧完全相同的 refs → delta 应把 refs 全部裁掉。
      writeFile(path.join(skill, "SKILL.md"), "v1");
      const refPath = path.join(skill, "refs");
      for (let i = 0; i < 5; i++) writeFile(path.join(refPath, `r${i}.md`), "same");
      const refs = [0, 1, 2, 3, 4].map((i) => ({ path: path.join(refPath, `r${i}.md`), sha256: ledger.storeBlob(Buffer.from("same")) }));
      const skillV1 = { path: path.join(skill, "SKILL.md"), sha256: ledger.storeBlob(Buffer.from("v1")) };
      const skillV2 = { path: path.join(skill, "SKILL.md"), sha256: ledger.storeBlob(Buffer.from("v2")) };
      const full = [...refs, skillV1]; // 6 项全量清单（safe 条目）
      const legacyBefore = [...refs, skillV1]; // 变异前：5 refs + v1
      const legacyAfter = [...refs, skillV2]; // 变异后：5 refs + v2
      writeFile(
        path.join(dirs.storeDir, "ledger.jsonl"),
        JSON.stringify({
          id: "comp01", ts: new Date().toISOString(), actor: "agent", action: "patch",
          skill: "big", evidence: {}, before: legacyBefore, after: legacyAfter,
        }) + "\n" +
        JSON.stringify({
          id: "safe01", ts: new Date().toISOString(), actor: "user", action: "pre-rollback",
          skill: "big", evidence: { rollback_target: "comp01" }, before: full, after: full,
        }) + "\n" + "garbage line\n"
      );
      const before = fs.statSync(path.join(dirs.storeDir, "ledger.jsonl")).size;
      const { entries, before: rawBefore, after: rawAfter } = await ledger.compactLedger();
      expect(entries).toBe(2); // 畸形行不计入（只计合法 dict 行）
      const comp = ledger.listEntries().find((e) => e.id === "comp01");
      expect(comp!.before).toHaveLength(1); // 5 refs 两侧同哈希 → delta 清空，只剩 SKILL.md
      expect(comp!.before[0].sha256).toBe(ledger.storeBlob(Buffer.from("v1")));
      expect(comp!.after).toHaveLength(1);
      expect(comp!.after[0].sha256).toBe(ledger.storeBlob(Buffer.from("v2")));
      const safe = ledger.listEntries().find((e) => e.id === "safe01");
      expect(safe!.before).toHaveLength(full.length); // 安全条目保留整包
      expect(rawAfter).toBeLessThan(before); // legacy 条目被裁小
      expect(rawBefore).toBe(before);
      // 畸形行原样存活
      const raw = fs.readFileSync(path.join(dirs.storeDir, "ledger.jsonl"), "utf-8");
      expect(raw).toContain("garbage line");
      // 已是 delta：再 compact 免重写（无变化）
      const second = await ledger.compactLedger();
      expect(second.after).toBe(rawAfter);
    });

    it("gB: trim 保留最新条目到低水位；GC 只删引用断裂的旧 blob", async () => {
      const blobsDir = path.join(dirs.storeDir, "ledger-blobs");
      // 逐条追加，每条引用一个独立内容 blob
      for (let i = 0; i < 5; i++) {
        await ledger.appendEntry(
          "patch",
          "s",
          [{ path: path.join(dirs.skillsDir, "s", "f.md"), sha256: ledger.storeBlob(Buffer.from(`v${i}`)) }],
          [{ path: path.join(dirs.skillsDir, "s", "f.md"), sha256: ledger.storeBlob(Buffer.from(`v${i}x`)) }],
          "agent"
        );
      }
      const entries = ledger.listEntries();
      // 老化全部 blob，让 GC 可执行
      for (const e of entries) {
        for (const item of [...e.before, ...e.after]) ageBlob(blobsDir, item.sha256, 7200);
      }
      const trimmed = await ledger.trimOldest(1); // 字节预算 1B → 仅最新行可存（新恒传不变式）
      expect(trimmed).toBeGreaterThan(0);
      const kept = ledger.listEntries();
      expect(kept).toHaveLength(1); // 最新条目恒存
      const keptBlobs = [...kept[0].before, ...kept[0].after].map((i) => i.sha256);
      const result = await ledger.gcBlobs();
      expect(result.deleted).toBeGreaterThan(0);
      for (const sha of keptBlobs) {
        expect(ledger.readBlob(sha)).not.toBeNull(); // 仍被引用
      }
    });

    it("不可解码账本：list 视为空并告警；compact 不失手牌", async () => {
      fs.mkdirSync(dirs.storeDir, { recursive: true });
      fs.writeFileSync(path.join(dirs.storeDir, "ledger.jsonl"), Buffer.from([0xff]));
      expect(ledger.listEntries()).toEqual([]);
      const r = await ledger.compactLedger();
      expect(r).toMatchObject({ entries: 0, before: 1, after: 1 });
      // 文件原地不动
      expect(fs.readFileSync(path.join(dirs.storeDir, "ledger.jsonl"))).toEqual(Buffer.from([0xff]));
    });

    it("追加后账本大小维护：超上限触发 compact+trim，最新条目恒存", async () => {
      // 固定长度清单（不依赖 tmpdir 路径长度）：单行 ≈333B。上限 500：
      // 追加第 1 条（≈333B ≤ 500）→ 维护不动；追加第 2 条（≈666B > 500）→
      // compact（已 delta 无收益）→ trim 到低水位 400 → 丢首条保最新 → 收敛。
      const small = new SkillLedger({ ...dirs, ledgerMaxBytes: 500 });
      const item = (c: string) => ({ path: "s/SKILL.md", sha256: c.repeat(64) });
      const id1 = await small.appendEntry("edit", "s", [item("a")], [item("b")], "agent");
      expect(id1).toBeTruthy();
      expect(small.listEntries()).toHaveLength(1); // 第一条 < 上限：维护不动、无裁剪噪音
      expect(small.ledgerSize()).toBeLessThanOrEqual(500);

      const id2 = await small.appendEntry("edit", "s", [item("b")], [item("c")], "agent");
      expect(id2).toBeTruthy();
      expect(small.ledgerSize()).toBeLessThanOrEqual(500); // 收敛后 ≤ 上限
      const kept = small.listEntries();
      expect(kept).toHaveLength(1); // 第一代被维护裁掉
      expect(kept[0].id).toBe(id2); // 最新条目恒存
      expect(kept[0].before[0].sha256).toBe("b".repeat(64));
    });

    it("recordMutation 变异钩子：beforeRoot 重抓 + after 快照 + 永不抛", async () => {
      const skill = path.join(dirs.skillsDir, "m");
      writeFile(path.join(skill, "SKILL.md"), "x1");
      const entryId = await ledger.recordMutation("patch", "m", skill, null, skill, "agent");
      expect(entryId).toBeTruthy();
      // delta 无差异（before 根 = after 根、内容同）→ 空清单，但条目存在
      const e = ledger.listEntries("m");
      expect(e.length).toBe(1);
      expect(e[0].before).toEqual([]);
      expect(e[0].after).toEqual([]);

      // beforeRoot 不存在 → 不抛
      const id2 = await ledger.recordMutation("create", "ghost", path.join(dirs.skillsDir, "ghost"), null, null, "agent");
      expect(id2).toBeTruthy();
    });

    it("captureBefore 禁用开关 → null", () => {
      const off = new SkillLedger({ ...dirs, ledgerEnabled: false });
      expect(off.captureBefore(dirs.skillsDir)).toBeNull();
      expect(off.storeBlob(Buffer.from("x"))).toMatch(/^[0-9a-f]{64}$/); // storeBlob 不读开关
    });

    it("appendEntry：字符串形态脏 before/after（旧账本中间版本数据）→ 不抛，归一化空清单", async () => {
      const id = await ledger.appendEntry(
        "edit",
        "s",
        "legacy-dirty" as unknown as ManifestItem[],
        "dirty2" as unknown as ManifestItem[]
      );
      expect(id).toBeTruthy();
      const entries = ledger.listEntries("s");
      expect(entries).toHaveLength(1);
      expect(entries[0].before).toEqual([]);
      expect(entries[0].after).toEqual([]);
    });

    it("compact：字符串形态 before/after 脏行 → delta 归一化不抛（compacted 后变空清单）", async () => {
      const line = JSON.stringify({
        id: "dirty1",
        ts: new Date().toISOString(),
        actor: "curator",
        action: "edit",
        skill: "s",
        evidence: {},
        before: "not-a-list",
        after: "not-a-list",
      });
      fs.mkdirSync(dirs.storeDir, { recursive: true });
      fs.writeFileSync(path.join(dirs.storeDir, "ledger.jsonl"), line + "\n");
      const r = await ledger.compactLedger();
      expect(r.entries).toBe(1);
      const e = ledger.listEntries("s");
      expect(e).toHaveLength(1);
      expect(Array.isArray(e[0].before)).toBe(true);
      expect(Array.isArray(e[0].after)).toBe(true);
    });
  });
});
