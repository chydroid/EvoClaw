import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/**
 * 技能完整性校验模块（Round 7：信任链建设）
 *
 * 设计参考 openclaw-main 的 origin.json / lock.json 双向校验：
 * - origin.json：每个技能目录内的来源与哈希清单
 * - lock.json：技能根目录的依赖锁定文件，汇总所有已安装技能
 *
 * 信任链：
 *   安装时：写 origin.json → 更新 lock.json
 *   加载时：读 origin.json → 校验当前文件哈希 → 比对 lock.json
 *
 * 哈希算法：sha256（与 npm package-lock.json 一致）
 */

/** origin.json 结构：记录单个技能的来源与文件哈希 */
export interface SkillOrigin {
  /** 文件格式版本 */
  format: 1;
  /** 技能 ID */
  skillId: string;
  /** 技能名称 */
  name: string;
  /** 技能版本 */
  version: string;
  /** 来源类型 */
  source: "marketplace" | "bundled" | "local" | "workshop" | "import";
  /** 来源 URL 或路径（marketplace 时为 registry URL） */
  sourceUrl?: string;
  /** 安装时间（ISO 字符串） */
  installedAt: string;
  /** 安装者（用户名或 'system'） */
  installedBy?: string;
  /** 文件哈希清单：相对路径 → sha256 */
  files: Record<string, string>;
  /** 整体签名（registry 提供时记录，可选） */
  signature?: string;
  /** 签名算法 */
  signatureAlgorithm?: "sha256-rsa" | "sha256-ed25519";
  /** 公钥指纹（用于验签） */
  signerKeyFingerprint?: string;
}

/** lock.json 结构：技能根目录的依赖锁定 */
export interface SkillLockfile {
  /** 文件格式版本 */
  format: 1;
  /** 生成时间（ISO 字符串） */
  generatedAt: string;
  /** 已锁定技能列表 */
  skills: Array<{
    skillId: string;
    name: string;
    version: string;
    /** 技能目录相对路径（相对于 skills root） */
    dir: string;
    /** origin.json 的 sha256（用于双向校验） */
    originHash: string;
    /** SKILL.md 的 sha256 */
    skillMdHash: string;
    /** 来源 */
    source: SkillOrigin["source"];
  }>;
}

/** 校验结果 */
export interface IntegrityVerificationResult {
  ok: boolean;
  /** 缺失的 origin.json（true 表示技能未受信任链保护） */
  missingOrigin: boolean;
  /** 缺失的文件 */
  missingFiles: string[];
  /** 哈希不匹配的文件 */
  mismatchedFiles: Array<{ file: string; expected: string; actual: string }>;
  /** 与 lock.json 不一致的项 */
  lockMismatches: string[];
  /** 错误信息 */
  errors: string[];
}

const EMPTY_RESULT: IntegrityVerificationResult = {
  ok: true,
  missingOrigin: false,
  missingFiles: [],
  mismatchedFiles: [],
  lockMismatches: [],
  errors: [],
};

/** origin.json 文件名 */
export const ORIGIN_FILENAME = "origin.json";
/** lock.json 文件名 */
export const LOCK_FILENAME = "evoclaw-skill-lock.json";

/**
 * 计算字符串的 sha256 哈希。
 */
export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * 计算文件的 sha256 哈希。文件不存在时返回 null。
 */
export function hashFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return sha256(content);
  } catch {
    return null;
  }
}

/**
 * 原子写入文件：temp + fsync + rename，遵循项目 atomicWriteFile 约定。
 */
function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {
    // 目录可能已被并发创建
  }
  const tmpPath = filePath + ".tmp." + process.pid;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, content, { encoding: "utf-8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 为技能目录写入 origin.json。
 * 自动哈希目录内的 SKILL.md、_meta.json 和 scripts/、assets/ 子目录文件。
 */
export function writeOriginJson(
  skillDir: string,
  origin: Omit<SkillOrigin, "format" | "files">
): SkillOrigin {
  const files: Record<string, string> = {};

  // 哈希主要文件
  const primaryFiles = ["SKILL.md", "_meta.json", "config.json", "README.md"];
  for (const name of primaryFiles) {
    const fullPath = path.join(skillDir, name);
    const h = hashFile(fullPath);
    if (h) files[name] = h;
  }

  // 哈希 scripts/ 子目录
  const scriptsDir = path.join(skillDir, "scripts");
  if (fs.existsSync(scriptsDir) && fs.statSync(scriptsDir).isDirectory()) {
    for (const entry of fs.readdirSync(scriptsDir)) {
      const fullPath = path.join(scriptsDir, entry);
      if (fs.statSync(fullPath).isFile()) {
        const h = hashFile(fullPath);
        if (h) files[`scripts/${entry}`] = h;
      }
    }
  }

  // 哈希 assets/ 子目录
  const assetsDir = path.join(skillDir, "assets");
  if (fs.existsSync(assetsDir) && fs.statSync(assetsDir).isDirectory()) {
    for (const entry of fs.readdirSync(assetsDir)) {
      const fullPath = path.join(assetsDir, entry);
      if (fs.statSync(fullPath).isFile()) {
        const h = hashFile(fullPath);
        if (h) files[`assets/${entry}`] = h;
      }
    }
  }

  const full: SkillOrigin = {
    format: 1,
    files,
    ...origin,
  };

  const originPath = path.join(skillDir, ORIGIN_FILENAME);
  atomicWriteFile(originPath, JSON.stringify(full, null, 2) + "\n");
  return full;
}

/**
 * 读取技能目录的 origin.json。不存在或损坏时返回 null。
 */
export function readOriginJson(skillDir: string): SkillOrigin | null {
  const originPath = path.join(skillDir, ORIGIN_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(originPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SkillOrigin;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.format !== 1) return null;
    if (!parsed.skillId || !parsed.name || !parsed.files) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 校验技能目录与 origin.json 的一致性。
 * - 缺失 origin.json：返回 missingOrigin=true（不视为错误，仅提示未受保护）
 * - 文件缺失或哈希不匹配：返回对应字段并 ok=false
 */
export function verifySkillOrigin(skillDir: string): IntegrityVerificationResult {
  const result: IntegrityVerificationResult = {
    ok: true,
    missingOrigin: false,
    missingFiles: [],
    mismatchedFiles: [],
    lockMismatches: [],
    errors: [],
  };

  const origin = readOriginJson(skillDir);
  if (!origin) {
    result.missingOrigin = true;
    return result;
  }

  for (const [relPath, expectedHash] of Object.entries(origin.files)) {
    const fullPath = path.join(skillDir, relPath);
    const actualHash = hashFile(fullPath);
    if (actualHash === null) {
      result.missingFiles.push(relPath);
      result.ok = false;
    } else if (actualHash !== expectedHash) {
      result.mismatchedFiles.push({ file: relPath, expected: expectedHash, actual: actualHash });
      result.ok = false;
    }
  }

  if (!result.ok) {
    result.errors.push(
      `Skill "${origin.name}" integrity check failed: ` +
      `${result.missingFiles.length} missing, ${result.mismatchedFiles.length} mismatched`
    );
  }

  return result;
}

/**
 * 计算 origin.json 自身的 sha256（用于 lock.json 的双向校验）。
 */
export function hashOriginJson(skillDir: string): string | null {
  const originPath = path.join(skillDir, ORIGIN_FILENAME);
  return hashFile(originPath);
}

/**
 * 写入 lock.json 到 skills 根目录。
 * entries 由调用方从所有已安装技能汇总而来。
 */
export function writeLockJson(
  skillsRoot: string,
  entries: Array<{
    skillId: string;
    name: string;
    version: string;
    dir: string;
    source: SkillOrigin["source"];
  }>
): SkillLockfile {
  const skills: SkillLockfile["skills"] = [];

  for (const entry of entries) {
    const absDir = path.isAbsolute(entry.dir) ? entry.dir : path.join(skillsRoot, entry.dir);
    const originHash = hashOriginJson(absDir);
    const skillMdHash = hashFile(path.join(absDir, "SKILL.md"));
    if (!originHash || !skillMdHash) {
      // 缺少 origin.json 或 SKILL.md，跳过（不写入 lock）
      continue;
    }
    skills.push({
      skillId: entry.skillId,
      name: entry.name,
      version: entry.version,
      dir: path.isAbsolute(entry.dir) ? path.relative(skillsRoot, entry.dir) : entry.dir,
      originHash,
      skillMdHash,
      source: entry.source,
    });
  }

  const lock: SkillLockfile = {
    format: 1,
    generatedAt: new Date().toISOString(),
    skills,
  };

  const lockPath = path.join(skillsRoot, LOCK_FILENAME);
  atomicWriteFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
  return lock;
}

/**
 * 读取 skills 根目录的 lock.json。不存在或损坏时返回 null。
 */
export function readLockJson(skillsRoot: string): SkillLockfile | null {
  const lockPath = path.join(skillsRoot, LOCK_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SkillLockfile;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.format !== 1) return null;
    if (!Array.isArray(parsed.skills)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 校验 skills 根目录与 lock.json 的一致性。
 * 检查每个 lock 项的 origin.json 和 SKILL.md 哈希是否仍匹配。
 */
export function verifyLockIntegrity(skillsRoot: string): IntegrityVerificationResult {
  const result: IntegrityVerificationResult = {
    ok: true,
    missingOrigin: false,
    missingFiles: [],
    mismatchedFiles: [],
    lockMismatches: [],
    errors: [],
  };

  const lock = readLockJson(skillsRoot);
  if (!lock) {
    // 没有 lock.json 不视为错误，仅返回空结果
    return result;
  }

  for (const entry of lock.skills) {
    const absDir = path.join(skillsRoot, entry.dir);
    if (!fs.existsSync(absDir)) {
      result.lockMismatches.push(`Skill directory missing: ${entry.dir} (${entry.name})`);
      result.ok = false;
      continue;
    }

    const originHash = hashOriginJson(absDir);
    if (originHash === null) {
      result.lockMismatches.push(`origin.json missing for: ${entry.name}`);
      result.ok = false;
      continue;
    }
    if (originHash !== entry.originHash) {
      result.lockMismatches.push(`origin.json hash mismatch for: ${entry.name}`);
      result.ok = false;
    }

    const skillMdHash = hashFile(path.join(absDir, "SKILL.md"));
    if (skillMdHash === null) {
      result.lockMismatches.push(`SKILL.md missing for: ${entry.name}`);
      result.ok = false;
    } else if (skillMdHash !== entry.skillMdHash) {
      result.lockMismatches.push(`SKILL.md hash mismatch for: ${entry.name}`);
      result.ok = false;
    }
  }

  if (!result.ok) {
    result.errors.push(`Lockfile integrity check failed: ${result.lockMismatches.length} mismatches`);
  }

  return result;
}

/**
 * 删除技能目录的 origin.json（卸载时清理）。
 */
export function removeOriginJson(skillDir: string): boolean {
  const originPath = path.join(skillDir, ORIGIN_FILENAME);
  try {
    fs.unlinkSync(originPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除 skills 根目录的 lock.json（重置信任链时使用）。
 */
export function removeLockJson(skillsRoot: string): boolean {
  const lockPath = path.join(skillsRoot, LOCK_FILENAME);
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export { EMPTY_RESULT };
