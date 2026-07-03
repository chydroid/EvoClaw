/**
 * FileStateRegistry — 跨 agent 文件状态协调。
 *
 * 对标 Hermes v0.18.0 `tools/file_state.py` 的 `FileStateRegistry`：
 * 多 agent 并发读写同一文件时，避免基于过时内容做决策。
 *
 * 三类 staleness 检测：
 * 1. mtime 变化 — 文件被外部进程修改
 * 2. 内容 hash 不匹配 — 内容已变（即使 mtime 未变，如快速回写）
 * 3. read version 陈旧 — 其他 agent 已写入新版本
 *
 * 设计：
 * - 单例 Registry，跨 agent 共享
 * - per-agent read stamps（每个 agent 独立记录读取时间戳和 hash）
 * - per-path 串行化锁（避免并发写冲突）
 * - 编辑工具调用前强制 checkStale，staleness 命中返回错误
 *
 * 用法：
 * ```ts
 * const registry = FileStateRegistry.getInstance();
 * registry.recordRead("agent-1", "/path/file.ts", hash);
 * // ... 其他 agent 修改了文件 ...
 * const stale = registry.checkStale("agent-1", "/path/file.ts");
 * if (stale.stale) {
 *   throw new Error(`文件已过时: ${stale.reason}，请重读`);
 * }
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/** 文件读取记录 */
interface ReadStamp {
  /** 读取时的 mtime（ms） */
  mtime: number;
  /** 读取时的内容 hash（sha256 前 16 字符） */
  hash: string;
  /** 读取时间戳（ms） */
  readAt: number;
  /** read version（每次写入递增） */
  version: number;
}

/** staleness 检测结果 */
export interface StaleResult {
  /** 是否过时 */
  stale: boolean;
  /** 过时原因 */
  reason: "mtime" | "hash" | "version" | "removed" | null;
  /** 当前 mtime（若文件存在） */
  currentMtime?: number;
  /** 当前 hash（若文件存在） */
  currentHash?: string;
  /** 当前版本号 */
  currentVersion?: number;
  /** 上次读取时的记录 */
  lastRead?: ReadStamp;
}

/** 文件路径状态 */
interface PathState {
  /** 当前版本号（每次写入递增） */
  version: number;
  /** 当前 mtime */
  mtime: number;
  /** 当前 hash */
  hash: string;
  /** 各 agent 的读取记录 */
  readStamps: Map<string, ReadStamp>;
  /** 写入串行化锁 */
  writeLock: Promise<void> | null;
  /** 锁释放函数 */
  lockRelease: (() => void) | null;
}

/**
 * 文件状态注册表（单例）。
 * 跨 agent 共享，协调并发文件读写。
 */
export class FileStateRegistry {
  private static instance: FileStateRegistry | null = null;

  /** path → PathState */
  private states = new Map<string, PathState>();

  /** 是否启用 mtime 检测（默认 true，测试可关闭） */
  private mtimeCheckEnabled = true;

  private constructor() {}

  /** 获取单例 */
  static getInstance(): FileStateRegistry {
    if (!FileStateRegistry.instance) {
      FileStateRegistry.instance = new FileStateRegistry();
    }
    return FileStateRegistry.instance;
  }

  /** 重置单例（测试用） */
  static resetInstance(): void {
    FileStateRegistry.instance = null;
  }

  /** 计算 SHA-256 hash（前 16 字符） */
  static hashContent(content: string | Buffer): string {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
  }

  /** 读取文件并计算 hash */
  static readFileAndHash(filePath: string): { content: string; hash: string; mtime: number } {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      content,
      hash: FileStateRegistry.hashContent(content),
      mtime: stat.mtimeMs,
    };
  }

  /**
   * 记录 agent 读取文件。
   * 应在每次读取文件后调用。
   *
   * @param agentId agent 标识
   * @param filePath 文件绝对路径
   * @param hash 文件内容 hash（可选，不传则自动读取计算）
   */
  recordRead(agentId: string, filePath: string, hash?: string): void {
    const absPath = path.resolve(filePath);
    let state = this.states.get(absPath);

    let mtime: number;
    let actualHash: string;

    if (hash) {
      // 调用方提供了 hash
      try {
        const stat = fs.statSync(absPath);
        mtime = stat.mtimeMs;
      } catch {
        mtime = Date.now();
      }
      actualHash = hash;
    } else {
      // 自动读取并计算
      try {
        const info = FileStateRegistry.readFileAndHash(absPath);
        mtime = info.mtime;
        actualHash = info.hash;
      } catch {
        // 文件不存在，不记录
        return;
      }
    }

    if (!state) {
      state = {
        version: 1,
        mtime,
        hash: actualHash,
        readStamps: new Map(),
        writeLock: null,
        lockRelease: null,
      };
      this.states.set(absPath, state);
    } else {
      // 更新当前状态（但不递增 version，version 仅在 recordWrite 时递增）
      state.mtime = mtime;
      state.hash = actualHash;
    }

    state.readStamps.set(agentId, {
      mtime,
      hash: actualHash,
      readAt: Date.now(),
      version: state.version,
    });
  }

  /**
   * 记录 agent 写入文件。
   * 递增 version，清除其他 agent 的 read stamp 有效性。
   *
   * @param agentId agent 标识
   * @param filePath 文件绝对路径
   * @param content 写入的内容（用于计算 hash）
   */
  recordWrite(agentId: string, filePath: string, content: string | Buffer): void {
    const absPath = path.resolve(filePath);
    let state = this.states.get(absPath);

    const hash = FileStateRegistry.hashContent(content);
    let mtime: number;
    try {
      const stat = fs.statSync(absPath);
      mtime = stat.mtimeMs;
    } catch {
      mtime = Date.now();
    }

    if (!state) {
      state = {
        version: 1,
        mtime,
        hash,
        readStamps: new Map(),
        writeLock: null,
        lockRelease: null,
      };
      this.states.set(absPath, state);
    }

    // 递增版本号
    state.version++;
    state.mtime = mtime;
    state.hash = hash;

    // 更新写入 agent 的 read stamp（写入者知道自己写了什么）
    state.readStamps.set(agentId, {
      mtime,
      hash,
      readAt: Date.now(),
      version: state.version,
    });
  }

  /**
   * 检查 agent 对文件的读取是否过时。
   *
   * @param agentId agent 标识
   * @param filePath 文件绝对路径
   * @returns staleness 检测结果
   */
  checkStale(agentId: string, filePath: string): StaleResult {
    const absPath = path.resolve(filePath);
    const state = this.states.get(absPath);

    if (!state) {
      // 无记录：不视为过时（首次读取）
      return { stale: false, reason: null };
    }

    const stamp = state.readStamps.get(agentId);
    if (!stamp) {
      // 该 agent 未读取过：不视为过时
      return { stale: false, reason: null };
    }

    // 1. version 检测（最可靠）
    if (stamp.version < state.version) {
      return {
        stale: true,
        reason: "version",
        currentVersion: state.version,
        currentHash: state.hash,
        currentMtime: state.mtime,
        lastRead: stamp,
      };
    }

    // 2. 文件系统检测
    let currentMtime: number;
    let currentHash: string;
    try {
      const info = FileStateRegistry.readFileAndHash(absPath);
      currentMtime = info.mtime;
      currentHash = info.hash;
    } catch (err) {
      // 文件被删除
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          stale: true,
          reason: "removed",
          currentVersion: state.version,
          lastRead: stamp,
        };
      }
      // 其他读取错误（权限等）：不视为过时，避免误报
      return { stale: false, reason: null };
    }

    // 3. mtime 检测
    if (this.mtimeCheckEnabled && currentMtime > stamp.mtime) {
      return {
        stale: true,
        reason: "mtime",
        currentMtime,
        currentHash,
        currentVersion: state.version,
        lastRead: stamp,
      };
    }

    // 4. hash 检测（mtime 未变但内容变了，如快速回写）
    if (currentHash !== stamp.hash) {
      return {
        stale: true,
        reason: "hash",
        currentMtime,
        currentHash,
        currentVersion: state.version,
        lastRead: stamp,
      };
    }

    return {
      stale: false,
      reason: null,
      currentMtime,
      currentHash,
      currentVersion: state.version,
      lastRead: stamp,
    };
  }

  /**
   * 获取 per-path 写入锁。
   * 返回一个 Promise，resolve 后表示获得锁，调用返回的 release 函数释放。
   *
   * @param filePath 文件绝对路径
   * @returns [lockPromise, releaseFn]
   */
  acquireWriteLock(filePath: string): [Promise<void>, () => void] {
    const absPath = path.resolve(filePath);
    let state = this.states.get(absPath);
    if (!state) {
      state = {
        version: 0,
        mtime: 0,
        hash: "",
        readStamps: new Map(),
        writeLock: null,
        lockRelease: null,
      };
      this.states.set(absPath, state);
    }

    // 若已有锁，等待前一个释放
    const prevLock = state.writeLock;
    let releaseFn: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    const wrappedLock = prevLock
      ? prevLock.then(() => newLock)
      : newLock;

    state.writeLock = wrappedLock;
    state.lockRelease = releaseFn!;

    // 返回立即 resolve 的锁（等待链已建立）+ 释放函数
    // 调用方 await 返回的 Promise 即可，但实际锁是 wrappedLock
    // 这里简化：直接返回 wrappedLock 和 releaseFn
    return [wrappedLock, releaseFn!];
  }

  /**
   * 在写入锁保护下执行函数。
   *
   * @param filePath 文件绝对路径
   * @param fn 要在锁内执行的函数
   */
  async withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const [lock, release] = this.acquireWriteLock(filePath);
    await lock;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 清除指定 agent 的所有读取记录（agent 销毁时调用） */
  clearAgent(agentId: string): number {
    let cleared = 0;
    for (const state of this.states.values()) {
      if (state.readStamps.delete(agentId)) cleared++;
    }
    return cleared;
  }

  /** 清除指定文件的状态记录 */
  clearFile(filePath: string): boolean {
    const absPath = path.resolve(filePath);
    return this.states.delete(absPath);
  }

  /** 清除所有状态（测试用） */
  clearAll(): void {
    this.states.clear();
  }

  /** 获取所有被追踪的文件路径 */
  listTrackedFiles(): string[] {
    return Array.from(this.states.keys());
  }

  /** 获取文件当前版本号 */
  getVersion(filePath: string): number {
    const absPath = path.resolve(filePath);
    return this.states.get(absPath)?.version ?? 0;
  }

  /** 禁用/启用 mtime 检测（测试用） */
  setMtimeCheckEnabled(enabled: boolean): void {
    this.mtimeCheckEnabled = enabled;
  }
}

/**
 * 便捷函数：检查文件是否过时，若是则抛出错误。
 * 用于编辑工具调用前的守卫。
 */
export function assertNotStale(agentId: string, filePath: string): void {
  const result = FileStateRegistry.getInstance().checkStale(agentId, filePath);
  if (result.stale) {
    const reason = result.reason;
    let msg: string;
    if (reason === "removed") {
      msg = `文件 ${filePath} 已被删除，请重新读取`;
    } else if (reason === "version") {
      msg = `文件 ${filePath} 已被其他 agent 修改（版本 ${result.lastRead?.version} → ${result.currentVersion}），请重新读取`;
    } else if (reason === "mtime") {
      msg = `文件 ${filePath} 的修改时间已变（${new Date(result.lastRead!.mtime).toISOString()} → ${new Date(result.currentMtime!).toISOString()}），请重新读取`;
    } else {
      msg = `文件 ${filePath} 的内容 hash 不匹配，请重新读取`;
    }
    throw new Error(`FileStaleError: ${msg}`);
  }
}
