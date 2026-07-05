import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LineageStore, writeSkillIdSidecar, readSkillIdSidecar, ensureSkillIdSidecar, generateSkillId } from "./lineage-store";
import type { SkillLineage } from "./evolution-types";

// ═══════════════════════════════════════════════════════════
// 测试套件：LineageStore（版本血缘 DAG）
// ═══════════════════════════════════════════════════════════

describe("LineageStore", () => {
  let tmpDir: string;
  let store: LineageStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-test-"));
    store = new LineageStore(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function makeLineage(id: string, parentIds: string[] = [], type: SkillLineage["evolutionType"] = "captured"): SkillLineage {
    return {
      skillId: id,
      parentIds,
      evolutionType: type,
      evolvedAt: Date.now(),
      reason: "test",
      isActive: true,
    };
  }

  it("addLineage + getLineage", () => {
    store.addLineage(makeLineage("skill-1"), "skill-name-1");
    const lineage = store.getLineage("skill-1");
    expect(lineage).not.toBeNull();
    expect(lineage?.skillId).toBe("skill-1");
  });

  it("getSkillIdByName 通过名称查询", () => {
    store.addLineage(makeLineage("skill-1"), "my-skill");
    expect(store.getSkillIdByName("my-skill")).toBe("skill-1");
    expect(store.getSkillIdByName("unknown")).toBeNull();
  });

  it("FIX 演化 deactivate 父版本", () => {
    store.addLineage(makeLineage("parent", [], "captured"), "parent");
    store.addLineage(makeLineage("child", ["parent"], "fix"), "child");

    const parent = store.getLineage("parent");
    expect(parent?.isActive).toBe(false);

    const child = store.getLineage("child");
    expect(child?.isActive).toBe(true);
  });

  it("DERIVED 演化保留父版本 active", () => {
    store.addLineage(makeLineage("parent", [], "captured"), "parent");
    store.addLineage(makeLineage("child", ["parent"], "derived"), "child");

    const parent = store.getLineage("parent");
    expect(parent?.isActive).toBe(true);
  });

  it("环检测：拒绝形成环的 lineage", () => {
    store.addLineage(makeLineage("a", [], "captured"), "a");
    store.addLineage(makeLineage("b", ["a"], "derived"), "b");
    store.addLineage(makeLineage("c", ["b"], "derived"), "c");

    // c → a → c 会形成环
    expect(() => {
      store.addLineage(makeLineage("a", ["c"], "derived"), "a");
    }).toThrow(/cycle/i);
  });

  it("getAncestry 查询祖先链", () => {
    store.addLineage(makeLineage("root", [], "captured"), "root");
    store.addLineage(makeLineage("mid", ["root"], "derived"), "mid");
    store.addLineage(makeLineage("leaf", ["mid"], "derived"), "leaf");

    const ancestors = store.getAncestry("leaf");
    expect(ancestors.length).toBe(2);
    const ids = ancestors.map((a) => a.skillId);
    expect(ids).toContain("root");
    expect(ids).toContain("mid");
  });

  it("getDescendants 查询后代", () => {
    store.addLineage(makeLineage("root", [], "captured"), "root");
    store.addLineage(makeLineage("child1", ["root"], "derived"), "child1");
    store.addLineage(makeLineage("child2", ["root"], "derived"), "child2");
    store.addLineage(makeLineage("grandchild", ["child1"], "derived"), "grandchild");

    const descendants = store.getDescendants("root");
    expect(descendants.length).toBe(3);
    const ids = descendants.map((d) => d.skillId);
    expect(ids).toContain("child1");
    expect(ids).toContain("child2");
    expect(ids).toContain("grandchild");
  });

  it("buildTree 构建血缘树", () => {
    store.addLineage(makeLineage("root", [], "captured"), "root");
    store.addLineage(makeLineage("child1", ["root"], "derived"), "child1");
    store.addLineage(makeLineage("child2", ["root"], "derived"), "child2");

    const tree = store.buildTree("root");
    expect(tree).not.toBeNull();
    expect(tree?.skillId).toBe("root");
    expect(tree?.children.length).toBe(2);
  });

  it("多父 DERIVED 合并", () => {
    store.addLineage(makeLineage("parentA", [], "captured"), "parentA");
    store.addLineage(makeLineage("parentB", [], "captured"), "parentB");
    store.addLineage(makeLineage("merged", ["parentA", "parentB"], "derived"), "merged");

    const ancestors = store.getAncestry("merged");
    expect(ancestors.length).toBe(2);
    const ids = ancestors.map((a) => a.skillId);
    expect(ids).toContain("parentA");
    expect(ids).toContain("parentB");
  });

  it("持久化到磁盘后重新加载", () => {
    store.addLineage(makeLineage("skill-1", [], "captured"), "skill-1");

    // 创建新 store 实例，从同一目录加载
    const store2 = new LineageStore(tmpDir);
    const lineage = store2.getLineage("skill-1");
    expect(lineage).not.toBeNull();
    expect(lineage?.skillId).toBe("skill-1");
  });

  it("getRoots 返回无父节点", () => {
    store.addLineage(makeLineage("root1", [], "captured"), "root1");
    store.addLineage(makeLineage("root2", [], "captured"), "root2");
    store.addLineage(makeLineage("child", ["root1"], "derived"), "child");

    const roots = store.getRoots();
    expect(roots.length).toBe(2);
    const ids = roots.map((r) => r.skillId);
    expect(ids).toContain("root1");
    expect(ids).toContain("root2");
  });
});

// ═══════════════════════════════════════════════════════════
// 测试套件：SkillIdSidecar
// ═══════════════════════════════════════════════════════════

describe("SkillIdSidecar", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("writeSkillIdSidecar + readSkillIdSidecar", () => {
    writeSkillIdSidecar(tmpDir, "abc12345");
    expect(readSkillIdSidecar(tmpDir)).toBe("abc12345");
  });

  it("readSkillIdSidecar 不存在时返回 null", () => {
    expect(readSkillIdSidecar(tmpDir)).toBeNull();
  });

  it("ensureSkillIdSidecar 已存在时返回现有 ID", () => {
    writeSkillIdSidecar(tmpDir, "existing1");
    const id = ensureSkillIdSidecar(tmpDir);
    expect(id).toBe("existing1");
  });

  it("ensureSkillIdSidecar 不存在时生成新 ID", () => {
    const id = ensureSkillIdSidecar(tmpDir);
    expect(id).not.toBeNull();
    expect(id.length).toBeGreaterThan(0);
    // 再次读取应一致
    expect(readSkillIdSidecar(tmpDir)).toBe(id);
  });

  it("generateSkillId 生成不同 ID", () => {
    const id1 = generateSkillId();
    const id2 = generateSkillId();
    expect(id1).not.toBe(id2);
  });
});
