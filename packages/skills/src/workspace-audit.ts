/**
 * 工作台技能审计（对齐 openclaw-main 的 src/skills/security/workspace-audit.ts）。
 *
 * 安全要点：
 * - 符号链接逃逸检测：技能目录下的 SKILL.md 若通过 symlink 指向工作台外部，
 *   会绕过工作台根边界检查，让外部代码以工作台技能身份被加载
 * - BFS 扫描限制：maxFiles + maxDirVisits，防止符号链接循环或目录爆炸
 * - realpath 超时保护：2 秒超时，避免网络挂载卡死审计
 * - 路径白名单：仅当 realpath 仍在工作台根内才视为可信
 */

import fs from "fs";
import path from "path";

/** 审计发现条目。 */
export interface WorkspaceAuditFinding {
  /** 检查 ID，用于去重与抑制 */
  checkId: string;
  /** 严重级别 */
  severity: "info" | "warn" | "error";
  /** 标题 */
  title: string;
  /** 详情 */
  detail: string;
  /** 修复建议 */
  remediation: string;
}

/** 扫描限制配置。 */
export interface WorkspaceSkillScanLimits {
  /** 最大 SKILL.md 文件数 */
  maxFiles?: number;
  /** 最大目录访问数（BFS 上限） */
  maxDirVisits?: number;
}

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_ESCAPE_DETAIL_ROWS = 12;
const REALPATH_TIMEOUT_MS = 2000;

/** 安全的 stat 调用：失败不抛出。 */
function safeStat(targetPath: string): { ok: boolean; isDir: boolean; isSymlink: boolean } {
  try {
    const lst = fs.lstatSync(targetPath, { throwIfNoEntry: false });
    if (!lst) return { ok: false, isDir: false, isSymlink: false };
    return {
      ok: true,
      isDir: lst.isDirectory(),
      isSymlink: lst.isSymbolicLink(),
    };
  } catch {
    return { ok: false, isDir: false, isSymlink: false };
  }
}

/**
 * 带超时的 realpath 调用。
 * 使用 Promise.race + unref 计时器，避免网络挂载卡死审计。
 */
function realpathWithTimeout(p: string, timeoutMs = REALPATH_TIMEOUT_MS): Promise<string | null> {
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const realpathPromise = fs.promises
    .realpath(p)
    .catch(() => null)
    .then((result) => {
      if (timerHandle) clearTimeout(timerHandle);
      return result;
    });
  const timeoutPromise = new Promise<null>((resolve) => {
    timerHandle = setTimeout(() => resolve(null), timeoutMs);
    timerHandle.unref?.();
  });
  return Promise.race([realpathPromise, timeoutPromise]);
}

/** 判定 candidate 是否位于 root 内（含 root 自身）。 */
export function isPathInside(root: string, candidate: string): boolean {
  const rootNorm = path.resolve(root);
  const candNorm = path.resolve(candidate);
  if (rootNorm === candNorm) return true;
  // 严格前缀匹配：rootNorm + path.sep
  return candNorm.startsWith(rootNorm + path.sep);
}

/** 列出工作台 skills/ 下的所有 SKILL.md 文件（BFS + 限制）。 */
async function listWorkspaceSkillMarkdownFiles(
  workspaceDir: string,
  limits: WorkspaceSkillScanLimits = {},
): Promise<{ skillFilePaths: string[]; truncated: boolean }> {
  const skillsRoot = path.join(workspaceDir, "skills");
  const rootStat = safeStat(skillsRoot);
  if (!rootStat.ok || !rootStat.isDir) {
    return { skillFilePaths: [], truncated: false };
  }

  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalDirVisits = limits.maxDirVisits ?? maxFiles * 20;
  const skillFiles: string[] = [];
  const queue: string[] = [skillsRoot];
  const visitedDirs = new Set<string>();

  for (let i = 0; i < maxTotalDirVisits; i++) {
    if (queue.length === 0 || skillFiles.length >= maxFiles) {
      break;
    }
    const dir = queue.shift()!;
    const dirRealPath = (await realpathWithTimeout(dir)) ?? path.resolve(dir);
    if (visitedDirs.has(dirRealPath)) {
      continue;
    }
    visitedDirs.add(dirRealPath);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const stat = safeStat(fullPath);
        if (!stat.ok) continue;
        if (stat.isDir) {
          queue.push(fullPath);
          continue;
        }
        // 符号链接指向文件：仅当名为 SKILL.md 时收集
        // 注意：isFile 通过 statSync（跟随符号链接）判断更准确
        try {
          const realStat = fs.statSync(fullPath, { throwIfNoEntry: false });
          if (realStat?.isFile() && entry.name === "SKILL.md") {
            skillFiles.push(fullPath);
          }
        } catch {
          // ignore
        }
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        skillFiles.push(fullPath);
      }
    }
  }

  return { skillFilePaths: skillFiles, truncated: queue.length > 0 };
}

/**
 * 收集工作台技能的符号链接逃逸审计发现。
 *
 * 检测逻辑：
 * 1. 列出工作台 skills/ 下所有 SKILL.md（含 symlink）
 * 2. 对每个 SKILL.md 调用 realpath
 * 3. 若 realpath 不在工作台根内，记录为逃逸
 * 4. 若 realpath 超时，记录为可疑（无法验证目标）
 *
 * @param workspaceDirs 工作台根目录列表
 * @param limits 扫描限制
 * @returns 审计发现列表
 */
export async function collectWorkspaceSkillSymlinkEscapeFindings(params: {
  workspaceDirs: string[];
  skillScanLimits?: WorkspaceSkillScanLimits;
}): Promise<WorkspaceAuditFinding[]> {
  const findings: WorkspaceAuditFinding[] = [];
  const { workspaceDirs } = params;
  if (workspaceDirs.length === 0) {
    return findings;
  }

  const escapedSkillFiles: Array<{
    workspaceDir: string;
    skillFilePath: string;
    skillRealPath: string;
  }> = [];
  const seenSkillPaths = new Set<string>();

  for (const workspaceDir of workspaceDirs) {
    const workspacePath = path.resolve(workspaceDir);
    const workspaceRealPath = (await realpathWithTimeout(workspacePath)) ?? workspacePath;
    const { skillFilePaths, truncated } = await listWorkspaceSkillMarkdownFiles(
      workspacePath,
      params.skillScanLimits,
    );

    if (truncated) {
      findings.push({
        checkId: "skills.workspace.scan_truncated",
        severity: "warn",
        title: "Workspace skill scan reached the directory visit limit",
        detail:
          `The skills/ directory scan in ${workspacePath} stopped early after reaching the ` +
          `BFS visit cap. Skill files in the unscanned portion of the tree were not checked ` +
          "for symlink escapes.",
        remediation:
          "Flatten or simplify the skills/ directory hierarchy to stay within the scan budget, " +
          "or move deeply-nested skill collections to a managed skill location.",
      });
    }

    for (const skillFilePath of skillFilePaths) {
      const canonicalSkillPath = path.resolve(skillFilePath);
      if (seenSkillPaths.has(canonicalSkillPath)) {
        continue;
      }
      seenSkillPaths.add(canonicalSkillPath);

      const skillRealPath = await realpathWithTimeout(canonicalSkillPath);
      if (!skillRealPath) {
        escapedSkillFiles.push({
          workspaceDir: workspacePath,
          skillFilePath: canonicalSkillPath,
          skillRealPath: "(realpath timed out - symlink target unverifiable)",
        });
        continue;
      }
      if (isPathInside(workspaceRealPath, skillRealPath)) {
        continue;
      }
      escapedSkillFiles.push({
        workspaceDir: workspacePath,
        skillFilePath: canonicalSkillPath,
        skillRealPath,
      });
    }
  }

  if (escapedSkillFiles.length === 0) {
    return findings;
  }

  findings.push({
    checkId: "skills.workspace.symlink_escape",
    severity: "warn",
    title: "Workspace skill files resolve outside the workspace root",
    detail:
      "Detected workspace `skills/**/SKILL.md` paths whose realpath escapes their workspace root:\n" +
      escapedSkillFiles
        .slice(0, DEFAULT_MAX_ESCAPE_DETAIL_ROWS)
        .map(
          (entry) =>
            `- workspace=${entry.workspaceDir}\n` +
            `  skill=${entry.skillFilePath}\n` +
            `  realpath=${entry.skillRealPath}`,
        )
        .join("\n") +
      (escapedSkillFiles.length > DEFAULT_MAX_ESCAPE_DETAIL_ROWS
        ? `\n- +${escapedSkillFiles.length - DEFAULT_MAX_ESCAPE_DETAIL_ROWS} more`
        : ""),
    remediation:
      "Keep workspace skills inside the workspace root (replace symlinked escapes with real in-workspace files), or move trusted shared skills to managed/bundled skill locations.",
  });

  return findings;
}

/**
 * 检测技能目录中是否存在指向技能根外部的符号链接文件。
 * 这是更通用的扫描（不限于 SKILL.md），用于安装时审计。
 *
 * @param skillRoot 技能根目录
 * @param limits 扫描限制
 * @returns 逃逸的符号链接列表
 */
export async function detectSymlinkEscapeInSkill(params: {
  skillRoot: string;
  limits?: WorkspaceSkillScanLimits;
}): Promise<Array<{ symlinkPath: string; targetPath: string; reason: string }>> {
  const { skillRoot, limits } = params;
  const skillRootReal = (await realpathWithTimeout(skillRoot)) ?? path.resolve(skillRoot);
  const escapes: Array<{ symlinkPath: string; targetPath: string; reason: string }> = [];

  const maxFiles = limits?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDirVisits = limits?.maxDirVisits ?? maxFiles * 20;
  const queue: string[] = [skillRoot];
  const visitedDirs = new Set<string>();
  let visited = 0;

  while (queue.length > 0 && visited < maxDirVisits) {
    const dir = queue.shift()!;
    visited++;
    const dirReal = (await realpathWithTimeout(dir)) ?? path.resolve(dir);
    if (visitedDirs.has(dirReal)) continue;
    visitedDirs.add(dirReal);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const targetReal = await realpathWithTimeout(fullPath);
        if (!targetReal) {
          escapes.push({
            symlinkPath: fullPath,
            targetPath: "(unresolvable)",
            reason: "realpath timed out - symlink target unverifiable",
          });
          continue;
        }
        if (!isPathInside(skillRootReal, targetReal)) {
          escapes.push({
            symlinkPath: fullPath,
            targetPath: targetReal,
            reason: `symlink target "${targetReal}" escapes skill root "${skillRootReal}"`,
          });
        }
        // 即便没逃逸，也要继续遍历符号链接指向的目录
        try {
          const stat = fs.statSync(fullPath, { throwIfNoEntry: false });
          if (stat?.isDirectory()) {
            queue.push(fullPath);
          }
        } catch {
          // ignore
        }
      } else if (entry.isDirectory()) {
        queue.push(fullPath);
      }
    }
  }

  return escapes;
}
