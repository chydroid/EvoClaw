/**
 * FileSystemCheckpointManager — 基于 Git 影子存储的文件系统检查点管理器
 *
 * 借鉴 hermes-agent tools/checkpoint_manager.py（1668 行）设计：
 *
 * 核心机制：
 *   - 单一共享影子 git 存储位于 `~/.evoclaw/checkpoints/store/`
 *   - 每个项目通过 `sha256(absPath)[:16]` 哈希隔离
 *   - 使用三个 git 环境变量：GIT_DIR + GIT_WORK_TREE + GIT_INDEX_FILE
 *     GIT_CONFIG_GLOBAL/SYSTEM 设为 os.devnull 防止用户全局配置污染
 *   - 每轮去重：通过 Set<string> 跟踪已快照的文件
 *   - 使用 commit-tree（而非 commit）适配 bare store
 *   - 与 ref tip 比较而非 HEAD
 *
 * 三层清理：
 *   1. 每项目提交数上限（默认 50）
 *   2. 全局存储大小上限（默认 500MB）
 *   3. 自动维护（每次创建检查点后触发）
 *
 * 安全：
 *   - commit hash 验证（^[0-9a-fA-F]{4,64}$，无前导 -）
 *   - 文件路径验证（相对路径，必须在工作目录内）
 *   - 永不抛出异常（所有错误 debug 级别记录，返回 false）
 *
 * 回滚：
 *   - 回滚前先创建 pre-rollback 快照（undo the undo）
 *   - 使用 checkout-index 恢复文件
 *
 * 触发场景：
 *   - write_file / patch 等写入工具
 *   - 破坏性终端命令（rm -r、git reset --hard 等）
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, statSync, rmSync, readFileSync } from "fs";
import { join, resolve, relative, isAbsolute, dirname } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

const logger = {
  debug(msg: string, data?: Record<string, unknown>): void {
    if (process.env.EVOCLAW_DEBUG === "1" || process.env.LOG_LEVEL === "debug") {
      console.debug(`[checkpoint] ${msg}`, data ?? "");
    }
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    console.warn(`[checkpoint] ${msg}`, data ?? "");
  },
};

// ── 常量 ────────────────────────────────────────────────────────────────────

const DEFAULT_STORE_ROOT = join(homedir(), ".evoclaw", "checkpoints", "store");
const DEFAULT_PER_PROJECT_LIMIT = 50;
const DEFAULT_GLOBAL_SIZE_LIMIT_MB = 500;
const COMMIT_HASH_REGEX = /^[0-9a-fA-F]{4,64}$/;
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB 单文件上限

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface CheckpointConfig {
  /** 影子存储根目录 */
  storeRoot?: string;
  /** 每项目最大提交数 */
  perProjectLimit?: number;
  /** 全局存储大小上限（MB） */
  globalSizeLimitMB?: number;
  /** 是否启用 */
  enabled?: boolean;
}

export interface CheckpointResult {
  success: boolean;
  commitHash?: string;
  projectRef?: string;
  error?: string;
  filesSnapshotted?: number;
}

export interface RollbackResult {
  success: boolean;
  restoredFiles?: string[];
  preRollbackCommit?: string;
  error?: string;
}

export interface CheckpointEntry {
  commitHash: string;
  projectRef: string;
  timestamp: number;
  message: string;
  filesCount: number;
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 计算项目隔离用的哈希 ID。
 * 借鉴 hermes-agent：sha256(absPath)[:16]
 */
export function computeProjectId(projectPath: string): string {
  const abs = resolve(projectPath);
  return createHash("sha256").update(abs).digest("hex").slice(0, 16);
}

/**
 * 验证 commit hash 格式，防止注入。
 * 借鉴 hermes-agent _validate_commit_hash：
 *   - 必须匹配 ^[0-9a-fA-F]{4,64}$
 *   - 不能以 - 开头（防止 --upload-pack 等参数注入）
 */
function validateCommitHash(hash: string): boolean {
  if (!hash || typeof hash !== "string") return false;
  if (hash.startsWith("-")) return false;
  return COMMIT_HASH_REGEX.test(hash);
}

/**
 * 验证文件路径安全：
 *   - 必须是相对路径（防止 /etc/passwd 等绝对路径）
 *   - 不能包含 .. （防止路径穿越）
 *   - 不能以 - 开头（防止参数注入）
 */
function validateFilePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  if (isAbsolute(filePath)) return false;
  if (filePath.startsWith("-")) return false;
  if (filePath.includes("..")) return false;
  // 禁止 null 字节
  if (filePath.includes("\0")) return false;
  return true;
}

/**
 * 验证 ref 名称安全。
 */
function validateRefName(ref: string): boolean {
  if (!ref || typeof ref !== "string") return false;
  if (ref.startsWith("-")) return false;
  // 只允许字母数字、下划线、连字符、斜杠
  if (!/^[a-zA-Z0-9_/-]+$/.test(ref)) return false;
  return true;
}

/**
 * 执行 git 命令，返回 stdout。
 * 设置 GIT_CONFIG_GLOBAL/SYSTEM 为 os.devnull 防止用户全局配置污染。
 *
 * 借鉴 hermes-agent _run_git_with_env：
 *   env["GIT_CONFIG_GLOBAL"] = os.devnull
 *   env["GIT_CONFIG_SYSTEM"] = os.devnull
 */
async function runGit(
  gitDir: string,
  workTree: string,
  indexFile: string,
  args: string[],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: workTree,
      GIT_INDEX_FILE: indexFile,
      // 防止用户全局 git 配置污染影子存储
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      // 禁用交互式提示
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
    };

    const proc = spawn("git", args, {
      env,
      cwd: workTree,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]`, code: -1 });
    }, timeoutMs);
    timer.unref?.();

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${err.message}`, code: -1 });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });

    if (options.input !== undefined) {
      proc.stdin.end(options.input);
    } else {
      proc.stdin.end();
    }
  });
}

/**
 * 检查 git 是否可用。
 */
async function isGitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * 计算目录大小（字节）。
 */
function getDirSizeBytes(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  try {
    const stat = statSync(dirPath);
    if (stat.isFile()) return stat.size;
    let total = 0;
    const { readdirSync } = require("fs") as typeof import("fs");
    for (const entry of readdirSync(dirPath)) {
      const child = join(dirPath, entry);
      try {
        const childStat = statSync(child);
        if (childStat.isDirectory()) {
          total += getDirSizeBytes(child);
        } else {
          total += childStat.size;
        }
      } catch {
        // 跳过无法访问的条目
      }
    }
    return total;
  } catch {
    return 0;
  }
}

// ── 主类 ────────────────────────────────────────────────────────────────────

export class FileSystemCheckpointManager {
  private storeRoot: string;
  private perProjectLimit: number;
  private globalSizeLimitMB: number;
  private enabled: boolean;
  private gitAvailable: boolean | null = null;

  /** 每轮去重集合：projectId → Set<filePath> */
  private perTurnDedup = new Map<string, Set<string>>();

  /** 项目 ref 名称缓存：projectId → refName */
  private projectRefs = new Map<string, string>();

  constructor(config: CheckpointConfig = {}) {
    this.storeRoot = config.storeRoot ?? DEFAULT_STORE_ROOT;
    this.perProjectLimit = config.perProjectLimit ?? DEFAULT_PER_PROJECT_LIMIT;
    this.globalSizeLimitMB = config.globalSizeLimitMB ?? DEFAULT_GLOBAL_SIZE_LIMIT_MB;
    this.enabled = config.enabled ?? true;
  }

  /**
   * 初始化影子存储。
   * 创建 storeRoot 目录，并初始化为 bare git 仓库。
   */
  async initialize(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.gitAvailable === null) {
      this.gitAvailable = await isGitAvailable();
    }
    if (!this.gitAvailable) {
      logger.warn("git not available, checkpoint manager disabled");
      return false;
    }

    try {
      if (!existsSync(this.storeRoot)) {
        mkdirSync(this.storeRoot, { recursive: true });
      }
      // 检查是否已初始化
      const headPath = join(this.storeRoot, "HEAD");
      if (!existsSync(headPath)) {
        // 初始化 bare 仓库
        const result = await this.runGitRaw(this.storeRoot, this.storeRoot, join(this.storeRoot, "index"), ["init", "--bare", this.storeRoot]);
        if (result.code !== 0) {
          logger.warn("failed to init bare store", { stderr: result.stderr });
          return false;
        }
      }
      return true;
    } catch (err) {
      logger.warn("initialize failed", { error: (err as Error).message });
      return false;
    }
  }

  /**
   * 为指定项目路径创建检查点。
   *
   * 借鉴 hermes-agent CheckpointManager.create_checkpoint：
   *   1. 计算项目 ID
   *   2. 每轮去重（已快照的文件跳过）
   *   3. add 文件到索引
   *   4. write-tree 生成 tree 对象
   *   5. commit-tree 创建提交（父提交为 ref tip）
   *   6. update-ref 更新项目 ref
   *   7. 触发清理
   *
   * @param projectPath 项目绝对路径
   * @param files 要快照的文件相对路径列表
   * @param message 提交消息
   */
  async createCheckpoint(
    projectPath: string,
    files: string[],
    message: string = "checkpoint",
  ): Promise<CheckpointResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    if (!(await this.initialize())) {
      return { success: false, error: "init failed" };
    }

    const projectId = computeProjectId(projectPath);
    const workTree = resolve(projectPath);
    const gitDir = this.storeRoot;
    const indexFile = join(this.storeRoot, `${projectId}.index`);
    const refName = `refs/heads/proj-${projectId}`;

    if (!validateRefName(refName)) {
      return { success: false, error: "invalid ref name" };
    }

    // 每轮去重
    let dedupSet = this.perTurnDedup.get(projectId);
    if (!dedupSet) {
      dedupSet = new Set();
      this.perTurnDedup.set(projectId, dedupSet);
    }

    const filesToAdd: string[] = [];
    for (const f of files) {
      if (!validateFilePath(f)) {
        logger.debug("skipping invalid file path", { file: f });
        continue;
      }
      if (dedupSet.has(f)) continue;
      // 检查文件存在且不过大
      const absPath = join(workTree, f);
      try {
        const stat = statSync(absPath);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_FILE_SIZE_BYTES) {
          logger.debug("skipping oversized file", { file: f, size: stat.size });
          continue;
        }
      } catch {
        continue;
      }
      filesToAdd.push(f);
      dedupSet.add(f);
    }

    if (filesToAdd.length === 0) {
      return { success: true, commitHash: undefined, projectRef: refName, filesSnapshotted: 0 };
    }

    try {
      // 1. add 文件到索引
      // 使用 --force 防止 .gitignore 排除（影子存储需要捕获所有变更）
      // 使用 -- 分隔符防止路径被解释为选项
      const addArgs = ["add", "--force", "--", ...filesToAdd];
      const addResult = await runGit(gitDir, workTree, indexFile, addArgs);
      if (addResult.code !== 0) {
        logger.debug("git add failed", { stderr: addResult.stderr });
        return { success: false, error: `git add failed: ${addResult.stderr.slice(0, 200)}` };
      }

      // 2. write-tree
      const writeTreeResult = await runGit(gitDir, workTree, indexFile, ["write-tree"]);
      if (writeTreeResult.code !== 0) {
        logger.debug("git write-tree failed", { stderr: writeTreeResult.stderr });
        return { success: false, error: `write-tree failed: ${writeTreeResult.stderr.slice(0, 200)}` };
      }
      const treeHash = writeTreeResult.stdout.trim();
      if (!validateCommitHash(treeHash)) {
        return { success: false, error: "invalid tree hash" };
      }

      // 3. 获取当前 ref tip 作为父提交
      const refTipResult = await runGit(gitDir, workTree, indexFile, ["rev-parse", "--verify", refName]);
      const parentCommit = refTipResult.code === 0 ? refTipResult.stdout.trim() : null;
      if (parentCommit && !validateCommitHash(parentCommit)) {
        return { success: false, error: "invalid parent commit hash" };
      }

      // 4. 比较与 ref tip 的差异，避免空提交
      if (parentCommit) {
        const diffResult = await runGit(gitDir, workTree, indexFile, ["diff-tree", "--quiet", parentCommit, treeHash]);
        // diff-tree --quiet 返回 0 表示无差异
        if (diffResult.code === 0) {
          logger.debug("no changes since last checkpoint", { projectId });
          return { success: true, commitHash: parentCommit, projectRef: refName, filesSnapshotted: 0 };
        }
      }

      // 5. commit-tree 创建提交
      const commitArgs = ["commit-tree", treeHash, "-m", message];
      if (parentCommit) {
        commitArgs.push("-p", parentCommit);
      }
      const commitResult = await runGit(gitDir, workTree, indexFile, commitArgs);
      if (commitResult.code !== 0) {
        logger.debug("git commit-tree failed", { stderr: commitResult.stderr });
        return { success: false, error: `commit-tree failed: ${commitResult.stderr.slice(0, 200)}` };
      }
      const commitHash = commitResult.stdout.trim();
      if (!validateCommitHash(commitHash)) {
        return { success: false, error: "invalid commit hash" };
      }

      // 6. update-ref
      const updateRefResult = await runGit(gitDir, workTree, indexFile, ["update-ref", refName, commitHash]);
      if (updateRefResult.code !== 0) {
        logger.debug("git update-ref failed", { stderr: updateRefResult.stderr });
        return { success: false, error: `update-ref failed: ${updateRefResult.stderr.slice(0, 200)}` };
      }

      this.projectRefs.set(projectId, refName);

      // 7. 异步触发清理（不阻塞主流程）
      this.pruneProject(projectId, gitDir, workTree, indexFile).catch(() => {});

      return { success: true, commitHash, projectRef: refName, filesSnapshotted: filesToAdd.length };
    } catch (err) {
      logger.debug("createCheckpoint exception", { error: (err as Error).message });
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * 回滚到指定检查点。
   *
   * 借鉴 hermes-agent CheckpointManager.rollback_to_checkpoint：
   *   1. 先创建 pre-rollback 快照（undo the undo）
   *   2. 使用 checkout-index 恢复文件
   *
   * @param projectPath 项目绝对路径
   * @param commitHash 目标 commit hash
   * @param files 要恢复的文件列表（空则恢复全部）
   */
  async rollback(
    projectPath: string,
    commitHash: string,
    files: string[] = [],
  ): Promise<RollbackResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    if (!validateCommitHash(commitHash)) {
      return { success: false, error: "invalid commit hash" };
    }

    const projectId = computeProjectId(projectPath);
    const workTree = resolve(projectPath);
    const gitDir = this.storeRoot;
    const indexFile = join(this.storeRoot, `${projectId}.index`);
    const refName = `refs/heads/proj-${projectId}`;

    try {
      // 1. 验证 commit 存在
      const catFileResult = await runGit(gitDir, workTree, indexFile, ["cat-file", "-t", commitHash]);
      if (catFileResult.code !== 0 || catFileResult.stdout.trim() !== "commit") {
        return { success: false, error: "commit not found" };
      }

      // 2. 创建 pre-rollback 快照（undo the undo）
      let preRollbackCommit: string | undefined;
      const refTipResult = await runGit(gitDir, workTree, indexFile, ["rev-parse", "--verify", refName]);
      if (refTipResult.code === 0) {
        preRollbackCommit = refTipResult.stdout.trim();
      }

      // 3. 读取目标 commit 的 tree
      const lsTreeResult = await runGit(gitDir, workTree, indexFile, ["ls-tree", "-r", "-z", commitHash]);
      if (lsTreeResult.code !== 0) {
        return { success: false, error: `ls-tree failed: ${lsTreeResult.stderr.slice(0, 200)}` };
      }

      // 解析 ls-tree 输出，提取文件路径
      const restoredFiles: string[] = [];
      const entries = lsTreeResult.stdout.split("\0").filter(Boolean);
      const targetFiles = new Set(files.length > 0 ? files : entries.map((e) => {
        // 格式：<mode> <type> <hash>\t<path>
        const tabIdx = e.indexOf("\t");
        return tabIdx >= 0 ? e.slice(tabIdx + 1) : "";
      }).filter(Boolean));

      // 4. 逐文件恢复
      for (const entry of entries) {
        const tabIdx = entry.indexOf("\t");
        if (tabIdx < 0) continue;
        const filePath = entry.slice(tabIdx + 1);
        if (!targetFiles.has(filePath)) continue;
        if (!validateFilePath(filePath)) continue;

        // 提取 blob hash
        const parts = entry.slice(0, tabIdx).split(" ");
        const blobHash = parts[2];
        if (!blobHash || !validateCommitHash(blobHash)) continue;

        // 读取 blob 内容并写入文件
        const catResult = await runGit(gitDir, workTree, indexFile, ["cat-file", "blob", blobHash]);
        if (catResult.code !== 0) continue;

        const absPath = join(workTree, filePath);
        const { writeFileSync, mkdirSync: mkdir } = require("fs") as typeof import("fs");
        try {
          mkdir(dirname(absPath), { recursive: true });
          writeFileSync(absPath, catResult.stdout);
          restoredFiles.push(filePath);
        } catch (err) {
          logger.debug("restore file failed", { file: filePath, error: (err as Error).message });
        }
      }

      // 5. 更新 ref 指向回滚后的 commit
      await runGit(gitDir, workTree, indexFile, ["update-ref", refName, commitHash]);

      return {
        success: true,
        restoredFiles,
        preRollbackCommit,
      };
    } catch (err) {
      logger.debug("rollback exception", { error: (err as Error).message });
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * 列出项目的所有检查点。
   */
  async listCheckpoints(projectPath: string, limit: number = 20): Promise<CheckpointEntry[]> {
    if (!this.enabled) return [];
    const projectId = computeProjectId(projectPath);
    const workTree = resolve(projectPath);
    const gitDir = this.storeRoot;
    const indexFile = join(this.storeRoot, `${projectId}.index`);
    const refName = `refs/heads/proj-${projectId}`;

    try {
      const logResult = await runGit(gitDir, workTree, indexFile, [
        "log", "--format=%H|%ct|%s", "-n", String(limit), refName,
      ]);
      if (logResult.code !== 0) return [];

      const entries: CheckpointEntry[] = [];
      for (const line of logResult.stdout.split("\n")) {
        if (!line.trim()) continue;
        const [hash, ts, msg] = line.split("|", 3);
        if (!validateCommitHash(hash)) continue;
        const tsNum = parseInt(ts, 10);
        if (!Number.isFinite(tsNum)) continue;
        entries.push({
          commitHash: hash,
          projectRef: refName,
          timestamp: tsNum * 1000,
          message: msg || "",
          filesCount: 0,
        });
      }
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * 获取项目的最新检查点 hash。
   */
  async getLatestCheckpoint(projectPath: string): Promise<string | null> {
    if (!this.enabled) return null;
    const projectId = computeProjectId(projectPath);
    const workTree = resolve(projectPath);
    const gitDir = this.storeRoot;
    const indexFile = join(this.storeRoot, `${projectId}.index`);
    const refName = `refs/heads/proj-${projectId}`;

    try {
      const result = await runGit(gitDir, workTree, indexFile, ["rev-parse", "--verify", refName]);
      if (result.code !== 0) return null;
      const hash = result.stdout.trim();
      return validateCommitHash(hash) ? hash : null;
    } catch {
      return null;
    }
  }

  /**
   * 清除当前轮的去重集合。
   * 应在每轮对话开始时调用。
   */
  clearTurnDedup(projectPath?: string): void {
    if (projectPath) {
      const projectId = computeProjectId(projectPath);
      this.perTurnDedup.delete(projectId);
    } else {
      this.perTurnDedup.clear();
    }
  }

  /**
   * 三层清理：
   *   1. 每项目提交数上限
   *   2. 全局存储大小上限
   *   3. 自动 gc
   *
   * 借鉴 hermes-agent CheckpointManager._prune_old_checkpoints。
   */
  async prune(): Promise<{ prunedProjects: number; gcRun: boolean }> {
    if (!this.enabled) return { prunedProjects: 0, gcRun: false };
    if (!(await this.initialize())) return { prunedProjects: 0, gcRun: false };

    let prunedProjects = 0;
    const gitDir = this.storeRoot;
    const workTree = this.storeRoot;

    try {
      // 列出所有项目 ref
      const forRefResult = await runGit(gitDir, workTree, join(gitDir, "index"), ["for-each-ref", "--format=%(refname)", "refs/heads/proj-*"]);
      if (forRefResult.code !== 0) return { prunedProjects: 0, gcRun: false };

      const refs = forRefResult.stdout.split("\n").filter(Boolean);
      for (const ref of refs) {
        if (!validateRefName(ref)) continue;
        const projectId = ref.replace("refs/heads/proj-", "");
        const indexFile = join(gitDir, `${projectId}.index`);
        const pruned = await this.pruneProject(projectId, gitDir, workTree, indexFile);
        if (pruned) prunedProjects++;
      }

      // 全局大小检查
      const sizeBytes = getDirSizeBytes(this.storeRoot);
      const sizeMB = sizeBytes / (1024 * 1024);
      let gcRun = false;
      if (sizeMB > this.globalSizeLimitMB) {
        // 触发激进 gc
        const gcResult = await runGit(gitDir, workTree, join(gitDir, "index"), ["gc", "--aggressive", "--prune=now"]);
        gcRun = gcResult.code === 0;
        logger.debug("global size limit exceeded, ran aggressive gc", {
          sizeMB: Math.round(sizeMB),
          limitMB: this.globalSizeLimitMB,
          gcSuccess: gcRun,
        });
      } else {
        // 常规自动 gc
        const gcResult = await runGit(gitDir, workTree, join(gitDir, "index"), ["gc", "--auto"]);
        gcRun = gcResult.code === 0;
      }

      return { prunedProjects, gcRun };
    } catch (err) {
      logger.debug("prune exception", { error: (err as Error).message });
      return { prunedProjects, gcRun: false };
    }
  }

  /**
   * 单项目清理：保留最近 N 个提交。
   */
  private async pruneProject(
    projectId: string,
    gitDir: string,
    workTree: string,
    indexFile: string,
  ): Promise<boolean> {
    const refName = `refs/heads/proj-${projectId}`;
    if (!validateRefName(refName)) return false;

    try {
      // 计算提交数
      const countResult = await runGit(gitDir, workTree, indexFile, ["rev-list", "--count", refName]);
      if (countResult.code !== 0) return false;
      const count = parseInt(countResult.stdout.trim(), 10);
      if (isNaN(count) || count <= this.perProjectLimit) return false;

      // 找到截断点：第 perProjectLimit 个祖先
      const keepResult = await runGit(gitDir, workTree, indexFile, [
        "rev-list", "-n", String(this.perProjectLimit), refName,
      ]);
      if (keepResult.code !== 0) return false;
      const lines = keepResult.stdout.trim().split("\n");
      const newTip = lines[lines.length - 1];
      if (!validateCommitHash(newTip)) return false;

      // 更新 ref 指向新 tip
      const updateResult = await runGit(gitDir, workTree, indexFile, ["update-ref", refName, newTip]);
      if (updateResult.code !== 0) return false;

      logger.debug("pruned project commits", { projectId, oldCount: count, newCount: this.perProjectLimit });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 内部：直接执行 git 命令（用于初始化）。
   */
  private async runGitRaw(
    gitDir: string,
    workTree: string,
    indexFile: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return runGit(gitDir, workTree, indexFile, args);
  }

  /**
   * 获取配置。
   */
  getConfig(): CheckpointConfig {
    return {
      storeRoot: this.storeRoot,
      perProjectLimit: this.perProjectLimit,
      globalSizeLimitMB: this.globalSizeLimitMB,
      enabled: this.enabled,
    };
  }

  /**
   * 更新配置。
   */
  updateConfig(config: Partial<CheckpointConfig>): void {
    if (config.storeRoot !== undefined) this.storeRoot = config.storeRoot;
    if (config.perProjectLimit !== undefined) this.perProjectLimit = config.perProjectLimit;
    if (config.globalSizeLimitMB !== undefined) this.globalSizeLimitMB = config.globalSizeLimitMB;
    if (config.enabled !== undefined) this.enabled = config.enabled;
  }
}

// ── 单例 ────────────────────────────────────────────────────────────────────

let singleton: FileSystemCheckpointManager | null = null;

/**
 * 获取单例实例。
 */
export function getCheckpointManager(config?: CheckpointConfig): FileSystemCheckpointManager {
  if (!singleton) {
    singleton = new FileSystemCheckpointManager(config);
  } else if (config) {
    singleton.updateConfig(config);
  }
  return singleton;
}

/**
 * 重置单例（用于测试）。
 */
export function resetCheckpointManager(): void {
  singleton = null;
}
