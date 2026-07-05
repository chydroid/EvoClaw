/**
 * LineageStore — 技能版本血缘 DAG 持久化
 *
 * 借鉴 OpenSpace skill_engine/store.py 的 skill_lineage_parents 表：
 *   - 多对多 parent-child 关系
 *   - get_ancestry() 查询祖先链
 *   - get_lineage_tree() 递归构建树
 *
 * EvoClaw 实现：
 *   - 持久化到 data/skill-curator/lineages.json（atomicWriteFile）
 *   - 内存中用 Map<skillId, SkillLineage> 索引
 *   - DAG 环检测：addLineage 时检查
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SkillLineage, LineageTreeNode, LineageQueryResult, EvolutionType } from "./evolution-types";
import { shouldDeactivateParent } from "./evolution-types";

// ── 原子写入 ──────────────────────────────────────────────────

function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  try {
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, content, { encoding: "utf-8" });
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ── 主类 ──────────────────────────────────────────────────────

/**
 * LineageStore
 *
 * 管理技能版本血缘 DAG。
 * 线程安全：所有方法同步执行。
 */
export class LineageStore {
  private storePath: string;
  private lineages = new Map<string, SkillLineage>();
  private nameIndex = new Map<string, string>(); // skillName → skillId
  private loaded = false;

  constructor(dataDir: string) {
    this.storePath = path.join(dataDir, "skill-curator", "lineages.json");
  }

  // ── 持久化 ──────────────────────────────────────────────

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const content = fs.readFileSync(this.storePath, "utf-8");
      const data = JSON.parse(content) as { lineages?: SkillLineage[]; nameIndex?: Array<[string, string]> };
      // 运行时校验：避免损坏数据导致后续 parentIds 等访问崩溃
      const lineages = Array.isArray(data?.lineages) ? data.lineages : [];
      const nameIndex = Array.isArray(data?.nameIndex) ? data.nameIndex : [];
      for (const lineage of lineages) {
        if (lineage && typeof lineage.skillId === "string" && Array.isArray(lineage.parentIds)) {
          this.lineages.set(lineage.skillId, lineage);
        }
      }
      for (const entry of nameIndex) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
          this.nameIndex.set(entry[0], entry[1]);
        }
      }
    } catch (err) {
      // 文件不存在或解析失败：空状态启动（记录原因便于排查）
      process.stderr.write(`[LineageStore] load failed: ${err}\n`);
    }
  }

  /**
   * 持久化到磁盘。
   * @throws 写入失败时抛出错误（持久化层不静默吞错）
   */
  private persist(): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const data = {
      lineages: Array.from(this.lineages.values()),
      nameIndex: Array.from(this.nameIndex.entries()),
    };
    atomicWriteFileSync(this.storePath, JSON.stringify(data, null, 2));
  }

  // ── 写入 ────────────────────────────────────────────────

  /**
   * 记录一次演化。
   * @param lineage 血缘记录
   * @param skillName 技能名（用于 nameIndex）
   * @throws 如果检测到环
   */
  addLineage(lineage: SkillLineage, skillName?: string): void {
    this.ensureLoaded();

    // 环检测：确保新节点的父链不会形成环
    for (const parentId of lineage.parentIds) {
      if (this.wouldCreateCycle(parentId, lineage.skillId)) {
        throw new Error(`Cycle detected: adding ${lineage.skillId} with parent ${parentId} would create a cycle`);
      }
    }

    this.lineages.set(lineage.skillId, lineage);
    if (skillName) {
      this.nameIndex.set(skillName, lineage.skillId);
    }

    // FIX 演化：deactivate 父版本
    if (shouldDeactivateParent(lineage.evolutionType)) {
      for (const parentId of lineage.parentIds) {
        const parent = this.lineages.get(parentId);
        if (parent && parent.isActive) {
          parent.isActive = false;
        }
      }
    }

    this.persist();
  }

  /**
   * 更新技能名索引（技能改名时调用）。
   */
  updateNameIndex(oldName: string | null, newName: string, skillId: string): void {
    this.ensureLoaded();
    if (oldName) {
      this.nameIndex.delete(oldName);
    }
    this.nameIndex.set(newName, skillId);
    this.persist();
  }

  /**
   * 标记技能为激活/非激活。
   */
  setActive(skillId: string, isActive: boolean): void {
    this.ensureLoaded();
    const lineage = this.lineages.get(skillId);
    if (lineage) {
      lineage.isActive = isActive;
      this.persist();
    }
  }

  // ── 查询 ────────────────────────────────────────────────

  /** 获取技能的血缘记录 */
  getLineage(skillId: string): SkillLineage | null {
    this.ensureLoaded();
    return this.lineages.get(skillId) ?? null;
  }

  /** 按技能名查询 ID */
  getSkillIdByName(name: string): string | null {
    this.ensureLoaded();
    return this.nameIndex.get(name) ?? null;
  }

  /** 获取所有血缘记录 */
  getAllLineages(): SkillLineage[] {
    this.ensureLoaded();
    return Array.from(this.lineages.values());
  }

  /** 获取激活的技能 ID 列表 */
  getActiveSkillIds(): string[] {
    this.ensureLoaded();
    return Array.from(this.lineages.values()).filter((l) => l.isActive).map((l) => l.skillId);
  }

  /**
   * 查询祖先链（从直接父到根）。
   */
  getAncestry(skillId: string): SkillLineage[] {
    this.ensureLoaded();
    const ancestors: SkillLineage[] = [];
    const visited = new Set<string>([skillId]);

    const queue = [skillId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const lineage = this.lineages.get(current);
      if (!lineage) continue;

      for (const parentId of lineage.parentIds) {
        if (visited.has(parentId)) continue;
        visited.add(parentId);
        const parent = this.lineages.get(parentId);
        if (parent) {
          ancestors.push(parent);
          queue.push(parentId);
        }
      }
    }

    return ancestors;
  }

  /**
   * 查询后代。
   */
  getDescendants(skillId: string): SkillLineage[] {
    this.ensureLoaded();
    const descendants: SkillLineage[] = [];
    const visited = new Set<string>([skillId]);

    // 构建反索引：parent → children
    const childrenIndex = new Map<string, string[]>();
    for (const lineage of this.lineages.values()) {
      for (const parentId of lineage.parentIds) {
        const children = childrenIndex.get(parentId) ?? [];
        children.push(lineage.skillId);
        childrenIndex.set(parentId, children);
      }
    }

    const queue = [skillId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = childrenIndex.get(current) ?? [];
      for (const childId of children) {
        if (visited.has(childId)) continue;
        visited.add(childId);
        const child = this.lineages.get(childId);
        if (child) {
          descendants.push(child);
          queue.push(childId);
        }
      }
    }

    return descendants;
  }

  /**
   * 完整血缘查询。
   */
  queryLineage(skillId: string): LineageQueryResult {
    this.ensureLoaded();
    return {
      skillId,
      ancestors: this.getAncestry(skillId),
      descendants: this.getDescendants(skillId),
      tree: this.buildTree(skillId),
    };
  }

  /**
   * 构建血缘树（从指定节点向下）。
   */
  buildTree(skillId: string, maxDepth = 10): LineageTreeNode | null {
    this.ensureLoaded();
    const lineage = this.lineages.get(skillId);
    if (!lineage) return null;

    // 构建反索引
    const childrenIndex = new Map<string, string[]>();
    for (const l of this.lineages.values()) {
      for (const parentId of l.parentIds) {
        const children = childrenIndex.get(parentId) ?? [];
        children.push(l.skillId);
        childrenIndex.set(parentId, children);
      }
    }

    const buildNode = (id: string, depth: number, visited: Set<string>): LineageTreeNode | null => {
      if (depth > maxDepth || visited.has(id)) return null;
      visited.add(id);

      const l = this.lineages.get(id);
      if (!l) return null;

      const childIds = childrenIndex.get(id) ?? [];
      const children: LineageTreeNode[] = [];
      for (const childId of childIds) {
        const childNode = buildNode(childId, depth + 1, visited);
        if (childNode) children.push(childNode);
      }

      return {
        skillId: id,
        skillName: "", // 由 caller 填充
        evolutionType: l.evolutionType,
        isActive: l.isActive,
        evolvedAt: l.evolvedAt,
        reason: l.reason,
        children,
        depth,
      };
    };

    return buildNode(skillId, 0, new Set());
  }

  /**
   * 获取根节点（无父的技能）。
   */
  getRoots(): SkillLineage[] {
    this.ensureLoaded();
    return Array.from(this.lineages.values()).filter((l) => l.parentIds.length === 0);
  }

  // ── 内部 ────────────────────────────────────────────────

  /**
   * 检测添加 parent → child 是否会形成环。
   * 算法：从 child 出发遍历祖先链，如果能到达 parent，则形成环。
   */
  private wouldCreateCycle(parentId: string, childId: string): boolean {
    if (parentId === childId) return true;

    // 从 parentId 向上遍历，如果能到达 childId，说明 childId 是 parentId 的祖先
    // 那么 parentId → childId 会形成环
    const visited = new Set<string>();
    const queue = [parentId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === childId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const lineage = this.lineages.get(current);
      if (lineage) {
        queue.push(...lineage.parentIds);
      }
    }

    return false;
  }

  /** 清空所有血缘记录（用于测试） */
  clear(): void {
    this.lineages.clear();
    this.nameIndex.clear();
    this.loaded = true;
    try { fs.unlinkSync(this.storePath); } catch { /* ignore */ }
  }
}

// ── .skill_id sidecar ─────────────────────────────────────────

/**
 * SkillIdSidecar — .skill_id sidecar 文件管理
 *
 * 借鉴 OpenSpace registry.py write_skill_id()：
 *   - 在技能目录下写 .skill_id 文件（uuid8 格式）
 *   - 读取时优先从 sidecar 取身份
 *   - 目录改名/移动不丢失身份
 */

const SKILL_ID_FILENAME = ".skill_id";

/**
 * 为技能目录写入 .skill_id sidecar。
 * @throws 写入失败时抛出错误（调用方应处理，避免身份丢失）
 */
export function writeSkillIdSidecar(skillDir: string, skillId: string): void {
  const sidecarPath = path.join(skillDir, SKILL_ID_FILENAME);
  atomicWriteFileSync(sidecarPath, skillId);
}

/**
 * 读取技能目录的 .skill_id sidecar。
 * @returns skillId 或 null（如果 sidecar 不存在）
 */
export function readSkillIdSidecar(skillDir: string): string | null {
  try {
    const sidecarPath = path.join(skillDir, SKILL_ID_FILENAME);
    return fs.readFileSync(sidecarPath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * 确保 .skill_id 存在；如果不存在则生成新 ID 并写入。
 */
export function ensureSkillIdSidecar(skillDir: string, existingId?: string): string {
  const existing = readSkillIdSidecar(skillDir);
  if (existing) return existing;

  // 生成新 ID：8 位 uuid 前缀
  const newId = existingId ?? generateSkillId();
  writeSkillIdSidecar(skillDir, newId);
  return newId;
}

/**
 * 生成技能 ID（8 位 base36 格式）。
 *
 * 使用 crypto.randomBytes 保证足够的随机性，避免 Math.random() 短随机分量导致的碰撞。
 */
export function generateSkillId(): string {
  // 4 字节随机数 → base36，取 8 位
  const random = crypto.randomBytes(4).readUInt32BE(0);
  return random.toString(36).padStart(8, "0").slice(0, 8);
}
