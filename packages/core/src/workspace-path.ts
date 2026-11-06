/**
 * 工作目录单点管理。
 *
 * 解决：
 * - 多处硬编码 `path.resolve(__dirname, "..", "..", "..", "..", "data", "workspace")`
 *   造成 dev vs prod 路径差异（`__dirname` 在 dist/source 下解析到不同位置）
 * - `EvoClaw_WORKSPACE` env var 仅被部分工具（video/image/protocol-adapter）识别，
 *   核心 file/shell 工具根本不读
 * - 运行时无法切换：`AgentModelExecutor.setWorkspacePath()` 只在 server start 调用
 *   一次，没有 API 端点或 UI 入口
 *
 * 优先级（从高到低）：
 * 1. `setWorkspaceDir()` 运行时 override（`POST /api/workspace` 触发）
 * 2. `EvoClaw_WORKSPACE` env var（启动时）
 * 3. `path.resolve(process.cwd(), "data", "workspace")` 默认
 *
 * 状态：模块级单例，进程内全局唯一。EvoClaw 开发实践上不存在「并行
 * 多 session 使用不同 workspace」的需求——单 agent 单任务模式。将来如
 * 需 per-session workspace，可将本模块改造为 `Map<sessionId, string>`，
 * 但当前不建议：复杂度 ≫ 收益。
 *
 * 安全：本模块只负责「解析根」，不做 startWith 逃逸检查。各工具在调用
 * `getWorkspaceDir()` 后，仍按自身策略做 cwd 边界检查（见
 * `apps/server/src/tools/shell-media-tools.ts:314`、`scheduler-tools.ts:150`）。
 * 原因：workspace 列表是用户显式可指定的任意根，任何下限都是误伤。
 */

import * as fs from "fs";
import * as path from "path";

/**
 * 运行时 override。null 表示未 override（走 env / default 语义）。
 */
let runtimeOverride: string | null = null;

/**
 * 确保目录存在（递归 mkdir），返回 passthrough。
 */
function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 解析并返回当前工作目录。不修改任何 mutable state。
 *
 * 用法：所有 file/shell/scheduler 工具应调用本函数而非自己拼 __dirname，
 * 配合 `POST /api/workspace` 即可运行时切换。
 */
export function getWorkspaceDir(): string {
  if (runtimeOverride) {
    return ensureDir(runtimeOverride);
  }
  const env = process.env.EvoClaw_WORKSPACE;
  if (env && env.trim()) {
    return ensureDir(path.resolve(env));
  }
  return ensureDir(path.resolve(process.cwd(), "data", "workspace"));
}

/**
 * 运行时覆盖工作目录。立即生效，影响所有调用 `getWorkspaceDir()` 的位置。
 *
 * 调用方应在切换后刷新依赖 workspace 的缓存，典型做法：
 *   const resolved = setWorkspaceDir(dir);
 *   agentModelExecutor.setWorkspacePath(resolved); // 内部已触发
 *     - mkdir + reload bootstrap files + clear _bootstrapPrefixBySession
 *
 * 返回 resolve 后的绝对路径（便于调用方日志/快照）。
 */
export function setWorkspaceDir(dir: string): string {
  const resolved = path.resolve(dir);
  ensureDir(resolved);
  runtimeOverride = resolved;
  return resolved;
}

/**
 * 清除运行时 override，回到 env / default 语义。
 * 用作「撤销」入口：UI 一键回到默认 data/workspace。
 */
export function clearWorkspaceOverride(): void {
  runtimeOverride = null;
}

/**
 * 当前 override 值（null 表示未设）。
 * 用于 UI 展示「当前是从 env 取值、还是运行时 override」+ 诊断端点。
 */
export function peekWorkspaceOverride(): string | null {
  return runtimeOverride;
}
