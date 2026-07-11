/**
 * Profile Manager — 多实例隔离系统
 *
 * 借鉴 hermes-agent 的 Profile 多实例设计：
 * - 每个 profile 拥有独立的 EvoClaw_HOME 数据根目录，实现完全隔离
 * - 所有路径必须通过 getEvoClawHome() 获取
 * - 用户可见消息使用 displayEvoClawHome() 脱敏（替换用户名为 <user>）
 *
 * 特性：
 *  - Profile 注册、切换、创建、删除（归档）
 *  - 持久化到 profiles.json（原子写入）
 *  - Profile 名校验（防路径穿越）
 *  - 并发安全（同名创建返回已存在的 profile）
 */

import * as fs from "fs";
import { mkdir, rename } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

// ── Types ─────────────────────────────────────────────────

export interface ProfileConfig {
  /** Profile 名称（唯一标识） */
  name: string;
  /** 数据根目录（EvoClaw_HOME） */
  dataDir: string;
  /** 创建时间（ISO string） */
  createdAt: string;
  /** 最后使用时间（ISO string） */
  lastUsedAt: string;
  /** 描述信息 */
  description?: string;
  /** 是否为默认 profile */
  isDefault?: boolean;
}

export interface ProfileManagerOptions {
  /** 根数据目录，默认 data/ */
  rootDataDir: string;
  /** 默认 profile 名，默认 "default" */
  defaultProfileName?: string;
}

interface ProfilesFile {
  activeProfile: string | null;
  profiles: ProfileConfig[];
}

// ── Constants ────────────────────────────────────────────

/** Profile 名只允许字母、数字、下划线、连字符 */
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9-_]+$/;

/** Profile 下子目录结构 */
const PROFILE_SUBDIRS = ["skills", "memory", "workspace", "logs", "plugins"];

/** 保留名称（不可作为 profile 名） */
const RESERVED_NAMES = new Set(["profiles-archive"]);

// ── Manager ───────────────────────────────────────────────

export class ProfileManager {
  private readonly rootDataDir: string;
  private readonly defaultProfileName: string;
  private readonly profilesFile: string;
  private readonly profiles = new Map<string, ProfileConfig>();
  private activeProfileName: string | null = null;

  /** 正在创建中的 profile promises，用于并发去重 */
  private readonly createPromises = new Map<string, Promise<ProfileConfig>>();

  constructor(options: ProfileManagerOptions) {
    this.rootDataDir = options.rootDataDir;
    this.defaultProfileName = options.defaultProfileName ?? "default";
    this.profilesFile = path.join(this.rootDataDir, "profiles.json");
    this.load();
  }

  // ── Active Profile ──────────────────────────────────────

  /**
   * 获取当前活跃 profile。
   */
  getActiveProfile(): ProfileConfig | null {
    if (!this.activeProfileName) return null;
    return this.profiles.get(this.activeProfileName) ?? null;
  }

  /**
   * 切换活跃 profile。切换前持久化当前 profile 的 lastUsedAt。
   */
  setActiveProfile(name: string): void {
    const profile = this.profiles.get(name);
    if (!profile) {
      throw new Error(`Profile "${name}" not found`);
    }
    // 更新当前 profile 的 lastUsedAt
    if (this.activeProfileName) {
      const current = this.profiles.get(this.activeProfileName);
      if (current) {
        current.lastUsedAt = new Date().toISOString();
      }
    }
    // 设置新的活跃 profile
    this.activeProfileName = name;
    profile.lastUsedAt = new Date().toISOString();
    this.persist();
  }

  // ── Path Resolution ─────────────────────────────────────

  /**
   * 返回当前 profile 的数据根目录（EvoClaw_HOME）。
   * 所有需要写入 profile 隔离数据的模块都应通过此方法获取路径。
   */
  getEvoClawHome(): string {
    const active = this.getActiveProfile();
    if (!active) {
      throw new Error("No active profile. Create or switch to a profile first.");
    }
    return active.dataDir;
  }

  /**
   * 返回脱敏后的数据根目录（替换用户名为 <user>），用于日志和用户可见消息。
   */
  displayEvoClawHome(): string {
    const home = os.homedir();
    const dataDir = this.getEvoClawHome();
    if (home && dataDir.startsWith(home)) {
      const sep = path.sep;
      const homeParts = home.split(sep);
      homeParts[homeParts.length - 1] = "<user>";
      const sanitizedHome = homeParts.join(sep);
      return sanitizedHome + dataDir.slice(home.length);
    }
    return dataDir;
  }

  // ── Profile CRUD ───────────────────────────────────────

  /**
   * 创建新 profile。如果同名 profile 已存在则返回已有的。
   * 并发创建同名 profile 时，第二个调用返回第一个创建的结果。
   */
  async createProfile(name: string, description?: string): Promise<ProfileConfig> {
    this.validateProfileName(name);

    // 已存在则直接返回
    const existing = this.profiles.get(name);
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
      return existing;
    }

    // 并发去重：如果正在创建中，返回同一个 promise
    const inProgress = this.createPromises.get(name);
    if (inProgress) return inProgress;

    const promise = this.doCreateProfile(name, description);
    this.createPromises.set(name, promise);
    try {
      return await promise;
    } finally {
      this.createPromises.delete(name);
    }
  }

  private async doCreateProfile(
    name: string,
    description?: string,
  ): Promise<ProfileConfig> {
    // Double-check（可能在 await 期间被另一个调用创建）
    const existing = this.profiles.get(name);
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
      return existing;
    }

    const dataDir = path.join(this.rootDataDir, name);
    // 创建目录结构
    await Promise.all(
      PROFILE_SUBDIRS.map((subdir) =>
        mkdir(path.join(dataDir, subdir), { recursive: true }),
      ),
    );

    const profile: ProfileConfig = {
      name,
      dataDir,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      description,
      isDefault: name === this.defaultProfileName,
    };

    this.profiles.set(name, profile);
    this.persist();
    return profile;
  }

  /**
   * 删除 profile（归档不删除）。
   * 不允许删除 default profile。
   * 将数据目录移动到 <rootDataDir>/profiles-archive/<name>-<timestamp>。
   */
  async deleteProfile(name: string): Promise<void> {
    if (name === this.defaultProfileName) {
      throw new Error(`Cannot delete the default profile "${this.defaultProfileName}"`);
    }

    const profile = this.profiles.get(name);
    if (!profile) {
      throw new Error(`Profile "${name}" not found`);
    }

    // 如果删除的是当前活跃 profile，切换回 default
    const wasActive = this.activeProfileName === name;

    // 归档目录：<rootDataDir>/profiles-archive/<name>-<timestamp>-<short-uuid>
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const shortId = randomUUID().slice(0, 8);
    const archiveDir = path.join(
      this.rootDataDir,
      "profiles-archive",
      `${name}-${timestamp}-${shortId}`,
    );

    // 确保归档父目录存在
    await mkdir(path.dirname(archiveDir), { recursive: true });

    // 移动数据目录到归档位置
    await rename(profile.dataDir, archiveDir);

    // 从 profiles map 中移除
    this.profiles.delete(name);

    if (wasActive) {
      this.activeProfileName = this.defaultProfileName;
      const defaultProfile = this.profiles.get(this.defaultProfileName);
      if (defaultProfile) {
        defaultProfile.lastUsedAt = new Date().toISOString();
      }
    }

    this.persist();
  }

  /**
   * 列出所有 profile。
   */
  listProfiles(): ProfileConfig[] {
    return Array.from(this.profiles.values());
  }

  /**
   * 获取指定名称的 profile。
   */
  getProfile(name: string): ProfileConfig | null {
    return this.profiles.get(name) ?? null;
  }

  // ── Persistence ────────────────────────────────────────

  /**
   * 持久化 profiles 到 profiles.json（原子写入）。
   */
  persist(): void {
    this.ensureRootDirSync();
    const data: ProfilesFile = {
      activeProfile: this.activeProfileName,
      profiles: this.listProfiles(),
    };
    this.atomicWriteFileSync(this.profilesFile, JSON.stringify(data, null, 2));
  }

  /**
   * 从 profiles.json 加载。如果文件不存在则创建默认 profile。
   */
  load(): void {
    if (!fs.existsSync(this.profilesFile)) {
      this.initDefaultProfile();
      return;
    }

    try {
      const content = fs.readFileSync(this.profilesFile, "utf-8");
      const data = JSON.parse(content) as ProfilesFile;
      this.profiles.clear();
      for (const p of data.profiles) {
        this.profiles.set(p.name, p);
      }
      // 恢复活跃 profile
      if (data.activeProfile && this.profiles.has(data.activeProfile)) {
        this.activeProfileName = data.activeProfile;
      } else {
        this.activeProfileName = this.defaultProfileName;
      }
    } catch {
      // profiles.json 损坏 — 重新初始化默认 profile
      this.profiles.clear();
      this.activeProfileName = null;
      this.initDefaultProfile();
    }

    // 确保 default profile 存在
    if (!this.profiles.has(this.defaultProfileName)) {
      this.initDefaultProfile();
    }
  }

  // ── Private Helpers ────────────────────────────────────

  /**
   * 初始化默认 profile（同步创建目录 + 注册 + 持久化）。
   */
  private initDefaultProfile(): void {
    const dataDir = path.join(this.rootDataDir, this.defaultProfileName);
    for (const subdir of PROFILE_SUBDIRS) {
      fs.mkdirSync(path.join(dataDir, subdir), { recursive: true });
    }

    const now = new Date().toISOString();
    const profile: ProfileConfig = {
      name: this.defaultProfileName,
      dataDir,
      createdAt: now,
      lastUsedAt: now,
      isDefault: true,
    };

    this.profiles.set(this.defaultProfileName, profile);
    if (!this.activeProfileName) {
      this.activeProfileName = this.defaultProfileName;
    }
    this.persist();
  }

  /**
   * 校验 profile 名：只允许 [a-zA-Z0-9-_]，禁止保留名称。
   */
  private validateProfileName(name: string): void {
    if (!name || typeof name !== "string") {
      throw new Error("Profile name must be a non-empty string");
    }
    if (!PROFILE_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid profile name "${name}": only alphanumeric, hyphen, and underscore are allowed`,
      );
    }
    if (RESERVED_NAMES.has(name)) {
      throw new Error(`Profile name "${name}" is reserved`);
    }
  }

  private ensureRootDirSync(): void {
    if (!fs.existsSync(this.rootDataDir)) {
      fs.mkdirSync(this.rootDataDir, { recursive: true });
    }
  }

  /**
   * 同步原子写入（temp + fsync + rename），保证 profiles.json 不被截断损坏。
   * 借鉴 @evoclaw/infrastructure 的 atomicWriteFile 和 config-lkg.ts 的 atomicWriteFileSync。
   */
  private atomicWriteFileSync(targetPath: string, content: string): void {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${targetPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, content, "utf-8");
      fs.fsyncSync(fd);
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
    fs.closeSync(fd);
    // 保留原文件权限位
    try {
      if (fs.existsSync(targetPath)) {
        const st = fs.statSync(targetPath);
        fs.chmodSync(tmpPath, st.mode);
      }
    } catch {
      // 权限复制失败不阻断写入
    }
    try {
      fs.renameSync(tmpPath, targetPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
}
