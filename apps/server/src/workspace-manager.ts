/**
 * WorkspaceManager —— 运行时工作区切换服务
 *
 * 背景：EvoClaw 默认工作目录是 `<repo>/data/workspace`（适合用户交付物）。
 * 当 Agent 需要「修自己的源码」时，需要切换到仓库根（`/home/chy/EvoClaw`）。
 * 之前只能通过 `EvoClaw_WORKSPACE` env 在启动时决定，无法运行时切换。
 *
 * 设计：
 * - 全局单点真相 = `@evoclaw/core` 的 `workspace-path` helper（getWorkspaceDir/setWorkspaceDir/clearWorkspaceOverride）。
 * - WorkspaceManager 暴露三个操作：
 *   - `switchTo(dir)`：校验目录 → setWorkspaceDir（+ executor/bootstrap 同步）→ 发 WORKSPACE_SWITCHED。
 *   - `reset()`：清 override → 刷新 executor/bootstrap → 发 WORKSPACE_RESET。
 *   - `getInfo()`：返回 dir + source（runtime | env | default）。
 *
 * 为什么在 server 层而非 core 层：server 持有 AgentModelExecutor / BootstrapManager 实例，
 * core 只持有 module-level 的 override 状态；事件广播也走 server 的 EventBus。
 *
 * 安全：
 * - switchTo 仅校验目录存在 + 是目录（不做路径白名单 —— 管理员 API 本身已是特权操作）。
 * - 后续若暴露给非管理员前端，应在 @evoclaw/security 加 permission gate。
 */

import * as path from "path";
import * as fs from "fs";
import type { EventBus } from "@evoclaw/core";
import { SystemEvents, getWorkspaceDir, setWorkspaceDir, clearWorkspaceOverride, peekWorkspaceOverride } from "@evoclaw/core";
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { BootstrapManager } from "@evoclaw/agent";

/** 工作区来源：runtime = 运行时 switch 设置；env = EvoClaw_WORKSPACE 启动时设定；default = 默认 data/workspace。 */
export type WorkspaceSource = "runtime" | "env" | "default";

export interface WorkspaceInfo {
  dir: string;
  source: WorkspaceSource;
  overridden: boolean;
  /**
   * 预设路径：前端「一键切换」按钮使用，不依赖进程 cwd（避免用户从别的位置 launch server 时报错）。
   * - repoRoot：来源 `path.resolve(__dirname, "..", "..", "..")`，即 EvoClaw monorepo 根。
   * - dataWorkspace：`<repoRoot>/data/workspace`，与 workspace-path 默认路径语义一致。
   */
  presets: {
    repoRoot: string;
    dataWorkspace: string;
  };
}

export interface SwitchResult {
  success: boolean;
  dir: string;
  error?: string;
}

export class WorkspaceManager {
  /** 缓存的预设路径（构造时一次性解析，避免每次调用 resolve）。 */
  private readonly repoRoot: string;
  private readonly dataWorkspace: string;

  constructor(
    private readonly executor: AgentModelExecutor | undefined,
    private readonly bootstrap: BootstrapManager | undefined,
    private readonly eventBus: EventBus | undefined,
  ) {
    // workspace-manager.ts 编译后位于 `apps/server/dist/workspace-manager.js`，
    // 三层 `..` → apps/server/dist → apps/server → apps → 仓库根。
    this.repoRoot = path.resolve(__dirname, "..", "..", "..");
    this.dataWorkspace = path.join(this.repoRoot, "data", "workspace");
  }

  /** 读取当前工作区（不触发任何副作用）。 */
  getInfo(): WorkspaceInfo {
    const dir = getWorkspaceDir();
    const peek = peekWorkspaceOverride();
    const source: WorkspaceSource =
      peek !== null ? "runtime" : process.env.EvoClaw_WORKSPACE ? "env" : "default";
    return {
      dir,
      source,
      overridden: peek !== null,
      presets: { repoRoot: this.repoRoot, dataWorkspace: this.dataWorkspace },
    };
  }

  /**
   * 切换到指定目录。语义：
   * - 路径解析为绝对路径（支持相对路径但相对 cwd —— 管理员 API 调用方通常传绝对路径）。
   * - 目录必须存在且是目录（不自动创建 —— 避免切换到不存在的路径后工具找不到文件）。
   * - 成功后同步 executor + bootstrap，并广播 WORKSPACE_SWITCHED。
   */
  switchTo(dirInput: string): SwitchResult {
    const resolved = path.resolve(dirInput || "");
    if (!resolved) {
      return { success: false, dir: "", error: "Empty directory path" };
    }

    let st: fs.Stats;
    try {
      st = fs.statSync(resolved);
    } catch {
      return { success: false, dir: resolved, error: `Target does not exist: ${resolved}` };
    }
    if (!st.isDirectory()) {
      return { success: false, dir: resolved, error: "Target is not a directory" };
    }

    const previous = getWorkspaceDir();
    setWorkspaceDir(resolved);
    this.syncSubManagers(resolved);
    this.publishSwitched(resolved, previous);
    return { success: true, dir: resolved };
  }

  /**
   * 回退到默认工作区（清 override + 刷新 executor/bootstrap + 广播 WORKSPACE_RESET）。
   * 注意：不删 env —— 如果启动时设了 EvoClaw_WORKSPACE，reset 后会回退到 env 指定的目录。
   */
  reset(): SwitchResult {
    const previous = getWorkspaceDir();
    clearWorkspaceOverride();
    const now = getWorkspaceDir();
    this.syncSubManagers(now);
    void this.eventBus?.publish(SystemEvents.WORKSPACE_RESET, { dir: now, previous }, "workspace-manager").catch(() => {
      // 事件广播失败不阻断主流程：状态已切换，调用方可从 getInfo 确认。
    });
    return { success: true, dir: now };
  }

  /** 同步 executor + bootstrap 的工作区路径（二者都有 setWorkspacePath，但非强制依赖）。 */
  private syncSubManagers(dir: string): void {
    try { this.executor?.setWorkspacePath(dir); } catch { /* 静默：子系统偶有异常不应阻断主流程 */ }
    try { this.bootstrap?.setWorkspacePath(dir); } catch { /* 同上 */ }
  }

  private publishSwitched(dir: string, previous: string): void {
    if (!this.eventBus) return;
    void this.eventBus.publish(SystemEvents.WORKSPACE_SWITCHED, { dir, source: "runtime", previous }, "workspace-manager").catch(() => {
      // 同上：广播失败不影响主流程。
    });
  }
}
