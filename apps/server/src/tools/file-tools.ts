import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { AgentModelExecutor } from "@evoclaw/agent";
import {
  getCurrentToolCallContext,
  FileStateRegistry,
  ReadTracker,
  fuzzyFindAndReplace,
  maybeCorrectEscapeDrift,
  AmbiguousEscapeDriftError,
  CONSECUTIVE_READ_BLOCK,
  CONSECUTIVE_READ_WARN,
  EDIT_FAILURE_ESCALATE,
} from "@evoclaw/agent";
import type { PermissionManager, PermissionRelay } from "@evoclaw/security";
import { getActiveSecurityPolicy, decideFileAccess } from "@evoclaw/security";
import type { ErrorRecoveryManager } from "@evoclaw/security";
import type { FileSystemManager } from "@evoclaw/infrastructure";

/** Validate that a resolved path stays within the allowed base directory.
 *  Prevents path traversal attacks (e.g. `../../etc/passwd`).
 *
 *  Bug 9 修复：原实现仅用 path.resolve 做词法规范化，不解析符号链接。
 *  攻击者可在 workspace 内创建指向外部目录的 symlink（如 workspace/evil -> /etc），
 *  path.resolve 会认为 evil 在 workspace 内，但实际访问的是 /etc。
 *  改为：对已存在路径用 realpathSync 解析符号链接后再检查；
 *  对不存在路径，realpath 父目录后拼接文件名再检查。 */
function validatePathWithinBase(resolvedPath: string, baseDir: string): string | null {
  const normalizedBase = path.resolve(baseDir);
  // On Windows, normalize drive letters for comparison
  const normalizedTarget = path.resolve(resolvedPath);

  // 先做词法检查：若词法上已超出 base，直接拒绝（避免 realpath 浪费 IO）
  if (!normalizedTarget.startsWith(normalizedBase + path.sep) && normalizedTarget !== normalizedBase) {
    return `Path traversal blocked: "${resolvedPath}" is outside the allowed workspace "${normalizedBase}". Use relative paths within the workspace only.`;
  }

  // Bug 9 修复：词法检查通过后，再用 realpath 解析符号链接，防止
  // workspace 内的 symlink 指向外部目录。
  try {
    let realTarget: string;
    if (fs.existsSync(normalizedTarget)) {
      // 路径存在：直接 realpath
      realTarget = fs.realpathSync(normalizedTarget);
    } else {
      // 路径不存在（如 file_create）：realpath 父目录后拼接 basename
      const parentDir = path.dirname(normalizedTarget);
      if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        realTarget = path.join(realParent, path.basename(normalizedTarget));
      } else {
        // 父目录也不存在：信任词法检查结果
        return null;
      }
    }
    // 对 realpath 结果再做一次词法检查
    if (!realTarget.startsWith(normalizedBase + path.sep) && realTarget !== normalizedBase) {
      return `Path traversal blocked (symlink escape): "${resolvedPath}" resolves to "${realTarget}" which is outside the allowed workspace "${normalizedBase}".`;
    }
  } catch {
    // realpath 失败（权限/IO 错误）：保守拒绝，避免误放行
    return `Path validation failed (realpath error): "${resolvedPath}".`;
  }
  return null;
}

/**
 * 解析工具入参里的文件路径，返回**绝对路径**与**供 FileSystemManager 使用的相对路径**。
 *
 * 真实事故（2026-10-07）：模型连续 3 次调用 file_create 被拦在「等待审批」，
 * 最后停下来问用户「请在弹窗中批准」，但界面根本没有弹窗。
 *
 * 根因是**相对路径的基准目录不一致**：
 *   - `shell_exec` 的 cwd 是 `data/workspace`
 *   - `file_create` 却把相对路径解析到**项目根**（fsBase）
 * 而白名单只覆盖 `data/workspace` 与 `data/skills`（刻意不白名单项目根，
 * 以防 agent 改源码 / .env）。于是模型写 `list_files.mjs`（它以为落在 workspace）
 * 实际落到 `<repo>/list_files.mjs` → 不在白名单 → 触发审批 → 任务彻底卡死。
 *
 * 现在：**相对路径按 workspace 解析**（与 shell_exec 的 cwd 对齐，
 * 产物也落在 workspace 而不是污染仓库根目录）。
 *
 * ⚠️ 必须同时返回 `forFs`：FileSystemManager 以 fsBase 为基准解析相对路径，
 * 若只把 `resolved` 换给审批检查、却仍把原始相对路径交给 fsMgr，
 * 就会出现「审批判定在 workspace、实际写入在仓库根」的错配 —— 那等于凭空开了一个
 * 绕过白名单的写入口。两者必须指向同一个绝对路径。
 *
 * 绝对路径与项目根的边界校验保持原样：项目根依旧不会被自动放行。
 */
/**
 * 剥掉模型习惯性带上的 workspace 前缀（P2 路径契约收敛，2026-11-08）。
 *
 * 路径契约（钉在工具描述里，这里是实现侧的归一化兜底）：
 *   - **相对路径** → 以 workspace 根为基准；若模型把 `data/workspace/...`
 *     误当相对路径（它以为是仓库根），这里归一为 `...`。
 *   - **绝对路径** → 一律原样直通（剥段前 resolveToolPath 已保证
 *     「原路径存在 → 原样直通」，走到这里的绝对路径必然不存在）。
 *     仅当剥掉 `/data/workspace/` 段后的目标在磁盘上真实存在时
 *     才剥离（模型给真实仓库文件误加了前缀的恢复启发式，2026-11-03）；
 *     否则保持声明路径（新建文件场景，v9 Task 6 事故根因）。
 * 该函数对不含 data/workspace/ 段的路径是 no-op。
 */
function stripWorkspacePrefix(filePath: string): string {
  let candidate = filePath.replace(/^\.[\\/]+/, "");
  const p = "data/workspace/";
  for (;;) {
    const lower = candidate.toLowerCase().replace(/\\/g, "/");
    if (!lower.startsWith(p)) break;
    candidate = candidate.slice(p.length);
  }
  // ★ 2026-11-03 修复：绝对路径中的 data/workspace/ 段也要剥离
  //   模型有时会传 /home/chy/EvoClaw/data/workspace/packages/xxx 这种绝对路径，
  //   但实际文件在 /home/chy/EvoClaw/packages/xxx（读仓库源码场景）。
  // ★ 2026-11-08 修复（v9 压测 Task 6 事故）：只剥离「剥完即存在」的绝对路径。
  //   剥段前 resolveToolPath 已保证「原路径存在 → 原样直通」，走到这里的绝对路径
  //   必然**不存在**。不存在时有两种语义：
  //   a) 新建文件（file_write 声明目标就是 data/workspace/... 本身）——剥段会把
  //      文件挪到仓库根（Task 6 根因：声称写 /home/chy/EvoClaw/data/workspace/
  //      v9-novel/the-last-city.md，实际落到 /home/chy/EvoClaw/v9-novel/，
  //      磁盘核验判缺失、续跑指令要求原样重传又再次被剥段，死循环至收尾）；
  //   b) 模型给真实仓库文件误加了 data/workspace/ 前缀（2026-11-03 目标场景，
  //      剥段后的路径在磁盘上真实存在）。
  //   判别式：剥段目标存在 → 剥离（b）；否则保持声明路径（a）。
  const lower = candidate.toLowerCase().replace(/\\/g, "/");
  const marker = "/data/workspace/";
  const idx = lower.indexOf(marker);
  if (idx >= 0) {
    // idx 指向 marker 开头的 /，slice(0, idx+1) 保留这个 /
    const stripped = candidate.slice(0, idx + 1) + candidate.slice(idx + marker.length);
    try {
      if (fs.existsSync(stripped)) candidate = stripped;
    } catch {
      /* existsSync 不抛；保险起见静默保持声明路径 */
    }
  }
  return candidate;
}

export function resolveToolPath(
  fsBase: string,
  workspaceBase: string | undefined,
  filePath: string,
): { resolved: string; forFs: string; display: string } {
  // 真实事故（2026-10-07 15:2x）：模型按 shell_exec 的 cwd 推断，
  // 传 `data/workspace/readme.md`（它以为相对项目根）。而相对路径已改为按
  // workspace 解析，于是拼成 `<ws>/data/workspace/readme.md` —— 目录多套一层，
  // 脚本写进了嵌套目录，后续 `node xxx.js` 报 SyntaxError（读到了另一个文件），
  // 模型据此误判为「file_create 往内容里注入了东西」，整整绕了几轮。
  // 这里先剥掉模型习惯性带上的 workspace 前缀再解析。
  // ★ 2026-11-03 修复：对所有路径（含绝对路径）都执行 stripWorkspacePrefix，
  //   因为模型可能传绝对路径 /home/chy/EvoClaw/data/workspace/packages/xxx
  // ★ 2026-11-04 强化：无条件调用 stripWorkspacePrefix——该函数对不含
  //   data/workspace/ 的路径是 no-op，安全；含该段的路径一律剥离。
  //   之前依赖 workspaceBase 是否存在来决定是否剥离，但 workspaceBase
  //   可能未设置（undefined），导致含 data/workspace/ 的路径未被剥离 → ENOENT。
  // ★ 2026-11-07 修正（e2e 11 任务压测）：绝对路径若**指向真实存在的文件**
  //   （典型：模型手上已有的 workspace 文件绝对路径），不应盲目剥离其中段——
  //   实测 t11-5：模型传 /home/chy/EvoClaw/data/workspace/analyze_app_log.py
  //   （该文件真实存在），旧逻辑剥成 /home/chy/EvoClaw/analyze_app_log.py（不存在）
  //   → ENOENT ×6 退避重试 → 撞外层 30s 工具超时，错误呈现为误导性的
  //   "timed out after 30s"。只对**不存在**的绝对路径保留剥离行为
  //   （模型把仓库路径误加 data/workspace 前缀的场景，2026-11-03 修复目标）。
  const rawAbsolute = path.isAbsolute(filePath) && !filePath.endsWith(path.sep);
  const effective =
    rawAbsolute && fs.existsSync(filePath)
      ? filePath
      : stripWorkspacePrefix(filePath);
  const resolved = path.isAbsolute(effective)
    ? path.resolve(fsBase, effective)
    : path.resolve(workspaceBase || fsBase, effective);
  // 换算成 fsBase 相对路径（统一用正斜杠），供 FileSystemManager 解析
  const rel = path.relative(fsBase, resolved);
  const forFs = rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : resolved;
  return { resolved, forFs, display: effective };
}

/**
 * 按「总体安全等级」裁决一次文件访问。
 *
 * 接入点在此处（而非 PermissionManager），因为沙箱内外是**路径维度**的判定，
 * 与「哪个工具」无关。PermissionManager 仍负责白名单与 requestId 流程。
 *
 * 返回 `null` 表示放行；返回字符串表示拒绝原因；返回 `"__confirm__"` 时
 * 由调用方转成审批请求（一般档下沙箱外写入即走此分支）。
 */
function judgeBySecurityLevel(
  resolvedPath: string,
  fsBase: string,
  write: boolean,
): { decision: "allow" | "confirm" | "deny"; insideSandbox: boolean; reason?: string } {
  const policy = getActiveSecurityPolicy();
  const normalizedBase = path.resolve(fsBase);
  const insideSandbox =
    resolvedPath === normalizedBase || resolvedPath.startsWith(normalizedBase + path.sep);

  // ★ 2026-10-30 修复（v7 压测 Task 7）：系统临时目录（/tmp/ 或 os.tmpdir()）
  //   是临时空间——写入不持久、不敏感。shell_exec 已可写 /tmp/，在此拦截
  //   file_write 只会迫使模型用 Python 脚本绕过（实测消耗 5-8 轮/文件），
  //   白白浪费轮次导致交付物缺失。放行临时目录写入不影响安全边界。
  const tmpDir = path.resolve(os.tmpdir()).replace(/\\/g, "/");
  const normalizedPath = path.resolve(resolvedPath).replace(/\\/g, "/");
  if (normalizedPath === tmpDir || normalizedPath.startsWith(tmpDir + "/")) {
    if (write) return { decision: "allow", insideSandbox: false };
  }

  const decision = decideFileAccess(policy, { insideSandbox, write });
  if (decision === "allow") return { decision, insideSandbox };
  if (decision === "deny") {
    return {
      decision: "deny",
      insideSandbox,
      reason:
        `操作被安全策略拦截：当前为「${policy.label}」等级，只允许在沙箱（${normalizedBase}）内` +
        `${write ? "写入" : "读取"}文件，沙箱外路径一律禁止。` +
        `如需放开，请到「安全 → 总体安全」调整等级。`,
    };
  }
  return { decision: "confirm", insideSandbox };
}

/**
 * 文件操作前置检查：安全等级裁决 + 路径边界校验。
 *
 * 返回 `ok:false` 时直接拒绝；`ok:true` 时 `insideSandbox` 决定走
 * FileSystemManager 的常规入口还是 `operateAbsolute`（沙箱外已授权通道）。
 */
function preflight(
  resolvedPath: string,
  fsBase: string,
  write: boolean,
): { ok: false; error: string } | { ok: true; insideSandbox: boolean; needsConfirm: boolean } {
  const judge = judgeBySecurityLevel(resolvedPath, fsBase, write);
  if (judge.decision === "deny") return { ok: false, error: judge.reason! };
  if (judge.insideSandbox) {
    const pathError = validatePathWithinBase(resolvedPath, fsBase);
    if (pathError) return { ok: false, error: pathError };
    return { ok: true, insideSandbox: true, needsConfirm: false };
  }
  // 沙箱外：词法边界检查（路径穿越）已无意义——策略本身就允许越界，
  // 但符号链接一致性仍由 operateAbsolute 复核。
  return { ok: true, insideSandbox: false, needsConfirm: judge.decision === "confirm" };
}

export function registerFileTools(
  executor: AgentModelExecutor,
  permissionManager: PermissionManager,
  permissionRelay: PermissionRelay | undefined,
  errorRecoveryManager: ErrorRecoveryManager,
  fileSystemManager: FileSystemManager,
  fsBase: string,
  /**
   * 相对路径的基准目录（通常是 data/workspace，已在白名单内）。缺省时退回 fsBase。
   * 支持传「运行时 getter」——在每次调用时求值，使管理员 API 切换工作区后立即生效；
   * 传字符串常量则在注册时固定（向后兼容，测试常用）。
   */
  workspaceBase?: string | (() => string)
): void {
  const fsMgr = fileSystemManager;
  const errRecovery = errorRecoveryManager;
  const permMgr = permissionManager;
  const permRelay = permissionRelay;

  /** 每次调用时动态解析 workspace：函数 → 调用；字符串 → 常量使用；undefined → 退回 fsBase（向后兼容）。 */
  const resolveWorkspaceBase = (): string => {
    if (typeof workspaceBase === "function") return workspaceBase();
    return workspaceBase ?? fsBase;
  };

  // ── R11-1 文件编辑三件套（GAP-5/6/7）共享设施 ─────────────────────
  // FileStateRegistry 管**跨会话** mtime/hash staleness；ReadTracker 管**会话内**
  // 重复读去重、分页覆盖账与整文件覆盖的全文基线。两者互补（对标 hermes
  // file_state.py + file_tools_read_tracking.py 的分工）。
  const stateRegistry = FileStateRegistry.getInstance();
  const readTracker = ReadTracker.getInstance();

  /** 当前会话 id（ToolRuntimeContext 未包裹时退 "default"，与审批层一致） */
  const currentSessionId = (): string => getCurrentToolCallContext()?.sessionId ?? "default";

  /** 文件 version（mtime + hash 前 16 字符）；文件不存在返回 null */
  function fileVersionOf(resolvedPath: string): string | null {
    try {
      const stat = fs.statSync(resolvedPath);
      const content = fs.readFileSync(resolvedPath, "utf-8");
      return `${stat.mtimeMs}:${FileStateRegistry.hashContent(content)}`;
    } catch {
      return null;
    }
  }

  /**
   * 会话内读追踪记账：ReadTracker（stub/block/覆盖账/基线）+ FileStateRegistry（跨会话 staleness）。
   * 在 file_read 成功返回内容前调用。
   */
  function noteSuccessfulRead(
    sessionId: string,
    resolvedPath: string,
    offset: number,
    limit: number | undefined,
    content: string,
    truncated: boolean,
    fileVersion: string | null,
  ): void {
    try {
      // hash 传 undefined → recordRead 自动读盘计算**整文件** hash。
      // 不能传 content 的 hash：分页读的 content 只是片段，与 checkStale 的
      // 整文件 hash 比对会永远误报 stale（实测 dbg2 复现）。
      stateRegistry.recordRead(sessionId, resolvedPath);
    } catch {
      /* staleness 记账失败不阻断读 */
    }
    try {
      const endLine = offset - 1 + content.split("\n").length;
      const totalLines = (() => {
        try {
          return fs.readFileSync(resolvedPath, "utf-8").split("\n").length;
        } catch {
          return 0;
        }
      })();
      readTracker.noteReadServed(
        sessionId, resolvedPath, fileVersion, offset, limit, endLine, totalLines, truncated,
      );
    } catch {
      /* 读追踪失败不阻断读 */
    }
  }

  /**
   * 整文件覆盖前的双守卫（对标 hermes `_stale_overwrite_blocker`，在磁盘突变前执行）。
   * 返回 null = 放行；返回字符串 = 拒绝理由（含 re-read 引导）。
   * modify 成功后 noteWriteServed 刷新基线 → 连续 modify 不自卡。
   */
  function checkStaleOverwrite(sessionId: string, resolvedPath: string): string | null {
    // 1) 跨会话 staleness（version/mtime/hash/removed，FileStateRegistry）
    const stale = stateRegistry.checkStale(sessionId, resolvedPath);
    if (stale.stale) {
      return (
        `${resolvedPath} was modified outside this session since you last read it ` +
        `(${stale.reason}). Re-read the file with file_read before overwriting.`
      );
    }
    // 2) 会话内全文基线（ReadTracker：never read / partial read / changed since）
    const version = fileVersionOf(resolvedPath);
    return readTracker.checkOverwriteBaseline(sessionId, resolvedPath, version !== null, version);
  }

  /** 文件行数 */
  function countLines(content: string): number {
    return content.split("\n").length;
  }

  // ── file_write（create / modify 复合工具）─────────────────────────
  // 合并自 file_create 与 file_modify。两者仅「新建还是覆盖」的语义不同，
  // handler 逻辑体逐字保留，由 action 分发。旧工具名不再注册。

  async function handleFileWriteCreate(params: Record<string, unknown>): Promise<unknown> {
    const filePath = String(params.path || "");
    const content = String(params.content || "");
    const overwrite = params.overwrite === true;
    const { resolved: resolvedPath, forFs: fsPath, display } = resolveToolPath(fsBase, resolveWorkspaceBase(),filePath);
    const pf = preflight(resolvedPath, fsBase, true);
    if (!pf.ok) return { success: false, error: pf.error };
    const sessionId = currentSessionId();
    // ★ 2026-11-26（v33 压测实证）：模型经常「整文件重发」现有文件（把刚写的文件按
    //   新方案再写一遍），却用 action=create 且不带 overwrite=false → fsMgr 抛
    //   EEXIST，模型再花一整轮改判 action=modify。hermes write_file 的语义是
    //   「存在则覆盖」并只在一个前提下拒绝：本任务没有该文件的当前全文、
    //   或文件在磁盘上已被改动。这里对齐：目标已存在但本会话持有其当前全文
    //   （刚写过 / 完整读过，且磁盘未变）→ 按覆盖执行（与 modify 同语义），
    //   否则维持 EEXIST 拒绝（绝不静默覆盖未见内容）。
    let effectiveOverwrite = overwrite;
    let autoOverwriteNote: string | undefined;
    if (!overwrite && fs.existsSync(resolvedPath)) {
      const blocker = checkStaleOverwrite(sessionId, resolvedPath);
      if (!blocker) {
        effectiveOverwrite = true;
        autoOverwriteNote =
          "目标文件已存在，且本会话持有其当前全文（你写过或完整读过、磁盘未变）——已按覆盖写入（等价 action=modify）。";
      }
    }
    // 沙箱外的写操作在「一般安全」档需要用户确认
    if (pf.needsConfirm) {
      const cReq = permMgr.requestPermission("file_create", filePath, { size: content.length, outsideSandbox: true }, "tool");
      if (cReq.status === "denied") {
        return { success: false, error: `Permission denied for file_create on ${filePath}. Request ID: ${cReq.id}` };
      }
      if (cReq.status === "pending") {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_create", description: `创建沙箱外文件: ${filePath}`, params, category: "file" });
        return { success: false, requiresPermission: true, requestId: cReq.id, operation: "file_create", description: "创建文件", target: filePath, error: `该路径位于沙箱外，需要你确认后才能创建: ${filePath}` };
      }
    } else if (permMgr.isPathAutoApproved(resolvedPath, "file_create")) {
      permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_create", description: `创建文件: ${filePath}`, params, category: "file" });
    }
    const doCreate = async () => {
      const r = pf.insideSandbox
        ? await fsMgr.createFile(fsPath, content, effectiveOverwrite)
        : await fsMgr.operateAbsolute(resolvedPath, content, "create", effectiveOverwrite);
      // ★ v26 实证（T4 R14 / T7 R11）：create 成功后必须登记会话内全文基线。
      //   否则同一会话紧接着 action=modify 会被「没读过全文」守卫拒绝，
      //   模型被迫先 file_read 整个文件再重试——白白多一轮，还会误以为
      //   文件被外部改动。刚写入的就是完整内容，基线即 content。
      try {
        stateRegistry.recordWrite(sessionId, resolvedPath, content);
      } catch { /* 记账失败不阻断写 */ }
      try {
        readTracker.noteWriteServed(sessionId, resolvedPath, fileVersionOf(resolvedPath) ?? `${Date.now()}:write`);
        readTracker.clearEditFailures(sessionId, resolvedPath);
      } catch { /* 记账失败不阻断写 */ }
      // ★ 回报可直接复用的绝对路径。真实事故：早前只回报 fsBase 相对路径
      // （data/workspace/x.py），模型拿它当 cwd 又拼一次 →
      // `...\data\workspace\data\workspace`，连踩两个坑。
      return {
        success: true,
        ...(r as object),
        ...(autoOverwriteNote ? { note: autoOverwriteNote } : {}),
        path: resolvedPath,
        workspaceRelative: display,
      };
    };
    return await errRecovery
      .executeWithRetry("file_create", fsPath, doCreate)
      .catch((err: unknown) => {
        // ★ 2026-11-07：ENOENT 常因父目录不存在或相对路径基准猜错；报错附上两个
        // 根目录，避免模型连续试错（e2e t11-7/8：模型凭空猜 /workspace 根）。
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("ENOENT") || message.includes("no such file")) {
          return {
            success: false,
            error: message,
            hint:
              `路径解析失败。相对路径以 workspace 根为基准：${resolveWorkspaceBase()}；` +
              `沙箱根（仓库根）：${fsBase}；本次解析为：${resolvedPath}。`,
          };
        }
        // ★ 2026-11-21（v23 Task 5 实证）：create 撞已有文件是确定性失败，
        //   与 ENOENT 同属「一条 hint 就能自救」家族。旧实现只透传裸错误，
        //   模型要自己猜 action=modify / overwrite=true / edit（v23 烧了 2 次
        //   失败调用才恢复）。把三个可选出路一次给全，同类错误不再反复试错。
        if (message.includes("already exists") || message.includes("EEXIST") || message.includes("eexist")) {
          return {
            success: false,
            error: message,
            hint:
              `文件已存在（${resolvedPath}）。三选一：` +
              `① 用 file_write action=modify + content 覆盖为完整新内容；` +
              `② 用 file_write action=create + overwrite=true 显式替换；` +
              `③ 只改局部时用 file_write action=edit + old_string/new_string。`,
          };
        }
        throw err;
      });
  }

  async function handleFileWriteModify(params: Record<string, unknown>): Promise<unknown> {
    const filePath = String(params.path || "");
    const content = String(params.content || "");
    const { resolved: resolvedPath, forFs: fsPath, display } = resolveToolPath(fsBase, resolveWorkspaceBase(),filePath);
    const pf = preflight(resolvedPath, fsBase, true);
    if (!pf.ok) return { success: false, error: pf.error };
    if (pf.needsConfirm) {
      const cReq = permMgr.requestPermission("file_modify", filePath, { size: content.length, outsideSandbox: true }, "tool");
      if (cReq.status === "denied") {
        return { success: false, error: `Permission denied for file_modify on ${filePath}. Request ID: ${cReq.id}` };
      }
      if (cReq.status === "pending") {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_modify", description: `修改沙箱外文件: ${filePath}`, params, category: "file" });
        return { success: false, requiresPermission: true, requestId: cReq.id, operation: "file_modify", description: "修改文件", target: filePath, error: `该路径位于沙箱外，需要你确认后才能修改: ${filePath}` };
      }
    } else if (permMgr.isPathAutoApproved(resolvedPath, "file_modify")) {
      permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_modify", description: `修改文件: ${filePath}`, params, category: "file" });
    }
    // ★ R11 GAP-5 stale-overwrite 阻断（对标 hermes `_stale_overwrite_blocker`）：
    //   磁盘突变前拒绝「基于旧快照/未读过全文的整文件覆盖」——静默丢工作的最直接路径。
    //   modify 成功后 noteWriteServed 刷新基线，连续 modify 不自卡。
    const sessionId = currentSessionId();
    const blocker = checkStaleOverwrite(sessionId, resolvedPath);
    if (blocker) {
      return { success: false, error: blocker, stale_write_blocked: true, path: filePath, resolved_path: resolvedPath };
    }
    const doModify = async () => {
      const r = pf.insideSandbox
        ? await fsMgr.modifyFile(fsPath, content)
        : await fsMgr.operateAbsolute(resolvedPath, content, "modify", true);
      // 写后记账：跨会话 staleness 刷新 + 会话内基线/dedup 更新
      try {
        stateRegistry.recordWrite(sessionId, resolvedPath, content);
      } catch { /* 记账失败不阻断写 */ }
      try {
        readTracker.noteWriteServed(sessionId, resolvedPath, fileVersionOf(resolvedPath) ?? `${Date.now()}:write`);
      } catch { /* 记账失败不阻断写 */ }
      return { success: true, ...(r as object), path: resolvedPath, workspaceRelative: display };
    };
    return await errRecovery
      .executeWithRetry("file_modify", fsPath, doModify)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("ENOENT") || message.includes("no such file")) {
          return {
            success: false,
            error: message,
            hint:
              `路径解析失败。相对路径以 workspace 根为基准：${resolveWorkspaceBase()}；` +
              `沙箱根（仓库根）：${fsBase}；本次解析为：${resolvedPath}。`,
          };
        }
        throw err;
      });
  }

  /**
   * R11 GAP-7：file_write action=edit — old_string/new_string 精确编辑
   * （对标 hermes patch_tool mode=replace）。改大文件不再整文件重发。
   * 流程：preflight → 权限 → 写锁内（stale 阻断 → 读当前内容 →
   * escape-drift 纠正 → 9 策略模糊匹配 → CRLF 归一 → 写回）。
   */
  async function handleFileWriteEdit(params: Record<string, unknown>): Promise<unknown> {
    const filePath = String(params.path || "");
    const oldString = params.old_string !== undefined ? String(params.old_string) : undefined;
    const newString = params.new_string !== undefined ? String(params.new_string) : undefined;
    const replaceAll = params.replace_all === true;
    if (oldString === undefined || oldString === "") {
      return { success: false, error: "action=edit 需要 old_string（要查找的原文）。请先 file_read 核对当前内容。" };
    }
    if (newString === undefined) {
      return { success: false, error: "action=edit 需要 new_string（替换文本；删除内容请传空字符串）" };
    }
    const { resolved: resolvedPath, forFs: fsPath, display } = resolveToolPath(fsBase, resolveWorkspaceBase(), filePath);
    const pf = preflight(resolvedPath, fsBase, true);
    if (!pf.ok) return { success: false, error: pf.error };
    const sessionId = currentSessionId();
    if (pf.needsConfirm) {
      const cReq = permMgr.requestPermission("file_modify", filePath, { outsideSandbox: true, edit: true }, "tool");
      if (cReq.status === "denied") {
        return { success: false, error: `Permission denied for file_modify on ${filePath}. Request ID: ${cReq.id}` };
      }
      if (cReq.status === "pending") {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_modify", description: `编辑沙箱外文件: ${filePath}`, params, category: "file" });
        return { success: false, requiresPermission: true, requestId: cReq.id, operation: "file_modify", description: "编辑文件", target: filePath, error: `该路径位于沙箱外，需要你确认后才能编辑: ${filePath}` };
      }
    } else if (permMgr.isPathAutoApproved(resolvedPath, "file_modify")) {
      permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_modify", description: `编辑文件: ${filePath}`, params, category: "file" });
    }

    return await errRecovery.executeWithRetry("file_edit", fsPath, async () => {
      return await stateRegistry.withWriteLock(resolvedPath, async () => {
        // a. staleness 检查：edit 对「未全文读」**不硬拦**（hermes patch_tool 语义：
        //    _stale_overwrite_blocker 只管 write_file 整文件覆盖；patch 的安全机制
        //    是 old_string 必须命中当前内容——文件变了就匹配失败，模型自然重读）。
        //    跨会话 mtime/hash 漂移降级为 warning 附到结果上。
        let staleWarning: string | null = null;
        const stale = stateRegistry.checkStale(sessionId, resolvedPath);
        if (stale.stale) {
          staleWarning =
            `Warning: ${filePath} was modified since you last read it (${stale.reason}). ` +
            "The content you read may be stale — old_string may not match. Consider re-reading.";
        }
        // b. 读当前内容
        let content: string;
        try {
          content = pf.insideSandbox
            ? await fsMgr.readFile(fsPath)
            : fs.readFileSync(resolvedPath, "utf-8");
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: message,
            hint: `无法读取待编辑文件（可能不存在）。本次解析为：${resolvedPath}。请先用 file_read 确认路径。`,
          };
        }
        // c. escape-drift 保守纠正（AmbiguousEscapeDriftError 必须报错、不得送模糊匹配）
        let effectiveOld = oldString!;
        let effectiveNew = newString!;
        let driftNote: string | null = null;
        try {
          const corrected = maybeCorrectEscapeDrift(effectiveOld, effectiveNew, content);
          effectiveOld = corrected.old;
          effectiveNew = corrected.new;
          driftNote = corrected.note;
        } catch (err: unknown) {
          if (err instanceof AmbiguousEscapeDriftError) {
            return { success: false, error: err.message, ambiguous_escape_drift: true, path: filePath };
          }
          throw err;
        }
        // d. 9 策略模糊匹配替换
        const result = fuzzyFindAndReplace(content, effectiveOld, effectiveNew, replaceAll);
        if (!result.success) {
          const failures = readTracker.recordEditFailure(sessionId, resolvedPath);
          const escalate =
            failures >= EDIT_FAILURE_ESCALATE
              ? ` （连续 ${failures} 次未命中该文件——停止微调 old_string 重试，先 file_read 重新核对该文件的当前内容，再决定编辑方案。）`
              : "";
          return {
            success: false,
            error: result.error + escalate,
            hint: `用 file_read 核对当前内容，或加长 old_string 提供更多上下文使其唯一。${driftNote ? ` note: ${driftNote}` : ""}`,
            path: filePath,
          };
        }
        // e. CRLF 归一（hermes _detect_line_ending 最小版）：文件主体为 CRLF 时
        //    替换文本内的 \n 改写为 \r\n，避免同文件混用行尾
        const crlfFile = content.includes("\r\n");
        let toWrite = result.newContent;
        if (crlfFile && effectiveNew.includes("\n") && !effectiveNew.includes("\r\n")) {
          // 仅当替换段来自非 exact 策略或模型用了 LF：把 new 里的 LF 归一为 CRLF
          const newAsCrlf = effectiveNew.replace(/\r?\n/g, "\r\n");
          if (newAsCrlf !== effectiveNew) {
            // 重放一次 exact 替换（effectiveOld 已在模糊匹配中命中），成本可忽略
            const redo = fuzzyFindAndReplace(content, effectiveOld, newAsCrlf, replaceAll);
            if (redo.success) toWrite = redo.newContent;
          }
        }
        // f. 写回
        if (pf.insideSandbox) {
          await fsMgr.modifyFile(fsPath, toWrite);
        } else {
          await fsMgr.operateAbsolute(resolvedPath, toWrite, "modify", true);
        }
        // g. 记账：跨会话 + 会话内 + 失败计数清零
        try { stateRegistry.recordWrite(sessionId, resolvedPath, toWrite); } catch { /* ignore */ }
        try {
          readTracker.noteWriteServed(sessionId, resolvedPath, fileVersionOf(resolvedPath) ?? `${Date.now()}:edit`);
          readTracker.clearEditFailures(sessionId, resolvedPath);
        } catch { /* ignore */ }
        // h. 受影响行区间摘要（不做完整 unified diff）
        const oldLineCount = countLines(content);
        const newLineCount = countLines(toWrite);
        return {
          success: true,
          path: resolvedPath,
          workspaceRelative: display,
          size: Buffer.byteLength(toWrite, "utf-8"),
          strategy: result.strategy,
          matchCount: result.matchCount,
          linesBefore: oldLineCount,
          linesAfter: newLineCount,
          ...(driftNote ? { note: driftNote } : {}),
          ...(staleWarning ? { warning: staleWarning } : {}),
        };
      });
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT") || message.includes("no such file")) {
        return {
          success: false,
          error: message,
          hint:
            `路径解析失败。相对路径以 workspace 根为基准：${resolveWorkspaceBase()}；` +
            `沙箱根（仓库根）：${fsBase}；本次解析为：${resolvedPath}。`,
        };
      }
      throw err;
    });
  }

  executor.registerTool(
    "file_write",
    {
      name: "file_write",
      description: "Write a file: create it if absent, replace its full content if present (对标 hermes write_file), or edit it in place。action 可省略——省略（或 auto）时按磁盘现状自动判定：文件不存在→create，已存在→modify。create 新建（目标已存在时：若本会话持有其当前全文/刚写过则自动替换，否则拒绝并给出三条出路；overwrite=true 可强制替换）；modify 整文件覆盖（覆盖前校验「本会话已见过当前全文」，防用陈旧副本静默丢改动）；edit 用 old_string/new_string 定点替换（改大文件首选，只发变更段）。创建后请告知用户文件路径，并说明可通过 /api/files/download/{path} 下载。路径契约：相对路径以工作区根（workspace）为基准；绝对路径一律原样直通、不被改写——写产物请始终使用「工作区根相对路径」（如 v9-novel/the-last-city.md），不要把 /data/workspace/ 拼进相对路径。",
      parameters: {
        action: { type: "string", description: "create = 新建文件；modify = 覆盖已有文件内容；edit = old_string/new_string 定点替换；省略或 auto = 按磁盘现状自动选择（推荐，等价 hermes write_file 的「不存在则建、存在则覆盖」）", required: false, default: "auto", enum: ["create", "modify", "edit", "auto"] },
        path: { type: "string", description: "File path. 相对路径以 workspace 根为基准；绝对路径原样直通（不会被剥段改写）。", required: true },
        content: { type: "string", description: "Content to write to the file（仅 create/modify 使用）", required: false, default: "" },
        overwrite: { type: "boolean", description: "Whether to overwrite if the file already exists（仅 action=create 生效，default: false）", required: false, default: false },
        old_string: { type: "string", description: "（仅 action=edit）要查找的原文；请从 file_read 结果逐字复制，含足够上下文使其唯一", required: false },
        new_string: { type: "string", description: "（仅 action=edit）替换文本；删除内容传空字符串", required: false },
        replace_all: { type: "boolean", description: "（仅 action=edit）替换所有匹配（default: false，要求唯一匹配）", required: false, default: false },
      },
    },
    async (params: Record<string, unknown>) => {
      // ★ 2026-11-10（v10 Task 6）：action 取值做「首 token」归一化。
      // 模型把枚举值写坏时（实测 "create\n</parameter=overwrite>\ntrue"，
      // 换行与伪 XML 尾巴混进取值），严格 === 判定整条写路径报废 →
      // 交付物缺失 → 续跑空转到 loop 检测。取首个字母 token 判定意图；
      // 仍不认识的取值原样（截断）回报，便于定位。
      //
      // ★ 2026-11-26（v33 压测实证）：旧 schema 把 action 声明为 required，
      //   模型在 6 次调用里按 hermes write_file 的肌肉记忆只传 {path, content}
      //   （甚至带了 overwrite 也没带 action）→ 校验层「Missing required parameter
      //   action」直接拒，模型再花一整轮把整段大文件内容重新发一遍。
      //   hermes 的 write_file 只有 path+content：不存在则创建、存在则覆盖。
      //   对齐：action 可省略，省略/auto 时按磁盘现状自动判定（存在→modify，
      //   不存在→create）。显式 create/modify/edit 行为不变。
      const rawAction = String(params.action || "").trim();
      let action: string;
      if (rawAction === "" || rawAction.toLowerCase() === "auto") {
        const filePath = String(params.path || "");
        const { resolved } = resolveToolPath(fsBase, resolveWorkspaceBase(), filePath);
        action = fs.existsSync(resolved) ? "modify" : "create";
      } else {
        action = (/^[a-z_]+/i.exec(rawAction)?.[0] ?? "").toLowerCase();
      }
      if (action === "modify") return await handleFileWriteModify(params);
      if (action === "create") return await handleFileWriteCreate(params);
      if (action === "edit") return await handleFileWriteEdit(params);
      return { success: false, error: `未知 file_write action: ${rawAction.slice(0, 40)}（仅支持 create / modify / edit / auto（省略即 auto））` };
    }
  );

  executor.registerTool(
    "file_delete",
    {
      name: "file_delete",
      description: "Delete a file at the specified path（路径契约：相对路径以 workspace 根为基准；绝对路径原样直通）",
      parameters: {
        path: { type: "string", description: "File path. 相对路径以 workspace 根为基准；绝对路径原样直通。", required: true },
      },
    },
    async (params: Record<string, unknown>) => {
      const filePath = String(params.path || "");
      const { resolved: resolvedPath, forFs: fsPath, display } = resolveToolPath(fsBase, resolveWorkspaceBase(),filePath);
      const pf = preflight(resolvedPath, fsBase, true);
      if (!pf.ok) return { success: false, error: pf.error };
      if (pf.needsConfirm) {
        const cReq = permMgr.requestPermission("file_delete", filePath, { outsideSandbox: true }, "tool");
        if (cReq.status === "denied") {
          return { success: false, error: `Permission denied for file_delete on ${filePath}. Request ID: ${cReq.id}` };
        }
        if (cReq.status === "pending") {
          permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_delete", description: `删除沙箱外文件: ${filePath}`, params, category: "file" });
          return { success: false, requiresPermission: true, requestId: cReq.id, operation: "file_delete", description: "删除文件", target: filePath, error: `该路径位于沙箱外，需要你确认后才能删除: ${filePath}` };
        }
      } else if (permMgr.isPathAutoApproved(resolvedPath, "file_delete")) {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_delete", description: `删除文件: ${filePath}`, params, category: "file" });
        return await errRecovery.executeWithRetry("file_delete", fsPath, async () => {
          if (pf.insideSandbox) await fsMgr.deleteFile(fsPath);
          else await fsMgr.deleteFileAbsolute(resolvedPath);
          return { success: true, path: filePath };
        });
      }
      const permRequest = permMgr.requestPermission("file_delete", filePath, {}, "tool");
      if (permRequest.status === "denied") {
        return { success: false, error: `Permission denied for file_delete on ${filePath}. Request ID: ${permRequest.id}` };
      }
      if (permRequest.status === "pending") {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_delete", description: `删除文件: ${filePath}`, params, category: "file" });
        return { success: false, requiresPermission: true, requestId: permRequest.id, operation: "file_delete", description: permRequest.description, target: filePath, error: `Awaiting user approval to delete: ${filePath}` };
      }
      return await errRecovery.executeWithRetry("file_delete", fsPath, async () => {
        if (pf.insideSandbox) await fsMgr.deleteFile(fsPath);
        else await fsMgr.deleteFileAbsolute(resolvedPath);
        return { success: true, path: filePath };
      });
    }
  );

  executor.registerTool(
    "file_read",
    {
      name: "file_read",
      description: "Read the contents of a file. For large files, use offset (1-based line number) and limit (max lines) to read in chunks. Each read returns up to 16000 characters. 路径契约：相对路径以 workspace 根为基准；绝对路径原样直通（已存在的绝对路径永不被改写）。",
      parameters: {
        path: { type: "string", description: "File path. 相对路径以 workspace 根为基准；绝对路径原样直通。", required: true },
        offset: { type: "string", description: "Line number to start reading from (1-based, default: 1)", required: false },
        limit: { type: "string", description: "Number of lines to read (default: all up to 16K char limit)", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const filePath = String(params.path || "");
      const { resolved: resolvedPath, forFs: fsPath, display } = resolveToolPath(fsBase, resolveWorkspaceBase(),filePath);
      const pf = preflight(resolvedPath, fsBase, false);
      if (!pf.ok) return { success: false, error: pf.error };
      const sessionId = currentSessionId();
      // 「一般安全」档允许读取沙箱外的一般文件；只有严格档会在这里被拒（pf.ok=false）
      // ★ 2026-11-04 ENOENT 兜底：stripWorkspacePrefix 在 resolveToolPath 中已无条件调用，
      //   但若服务器加载了旧 dist（或路径经过其他组件改写后重新拼回 data/workspace/），
      //   读取仍可能 ENOENT。这里在 readTarget 内层捕获 ENOENT，自动尝试剥离后的路径。
      const readTarget = pf.insideSandbox
        ? async () => {
            try {
              return await fsMgr.readFile(fsPath);
            } catch (err: unknown) {
              if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
                const stripped = stripWorkspacePrefix(fsPath);
                if (stripped !== fsPath) return await fsMgr.readFile(stripped);
              }
              throw err;
            }
          }
        : async () => {
            try {
              return fs.readFileSync(resolvedPath, "utf-8");
            } catch (err: unknown) {
              if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
                const stripped = stripWorkspacePrefix(resolvedPath);
                if (stripped !== resolvedPath) return fs.readFileSync(stripped, "utf-8");
              }
              throw err;
            }
          };
      return await errRecovery.executeWithRetry("file_read", fsPath, async () => {
        const parsedOffset = params.offset ? parseInt(String(params.offset), 10) : 1;
        const offset = Number.isFinite(parsedOffset) ? Math.max(1, parsedOffset) : 1;
        const parsedLimit = params.limit ? parseInt(String(params.limit), 10) : undefined;
        const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? Math.max(1, parsedLimit) : undefined;
        const version = fileVersionOf(resolvedPath);
        // ★ R11 GAP-6 读追踪：同 version 的同一 (path, offset, limit) 重复读
        //   第 1 次 stub、第 2 次起硬 BLOCK（weak tool-follower 防死循环）。
        const verdict = readTracker.checkBeforeRead(sessionId, resolvedPath, version, offset, limit);
        if (verdict.action === "block") {
          return {
            success: false,
            error:
              `BLOCKED: You have called file_read on this exact region ${verdict.consecutive} times ` +
              "and the file has NOT changed. STOP calling file_read for this path — the content " +
              "from your earlier file_read result in this conversation is still current. " +
              "Proceed with your task using the information you already have.",
            guardrail_refusal: true,
            already_read: verdict.consecutive,
            path: filePath,
          };
        }
        if (verdict.action === "stub") {
          return {
            status: "unchanged",
            message:
              "File unchanged since last read. The content from the earlier file_read result " +
              "in this conversation is still current — refer to that instead of re-reading.",
            path: filePath,
            dedup: true,
            content_returned: false,
          };
        }
        let content = await readTarget();
        const totalLines = countLines(content);
        let truncated = false;
        if (offset > 1 || limit) {
          const allLines = content.split("\n");
          const start = Math.max(0, offset - 1);
          const end = limit ? start + limit : allLines.length;
          content = allLines.slice(start, end).join("\n");
        }
        // 16K char 截断（此前只在 description 里声明、未强制）：截断页不作全文证据
        if (content.length > 16000) {
          content = content.slice(0, 16000);
          truncated = true;
        }
        noteSuccessfulRead(sessionId, resolvedPath, offset, limit, content, truncated, version);
        const result: Record<string, unknown> = { path: filePath, content };
        if (truncated) {
          result.truncated = true;
          result.total_lines = totalLines;
          result.hint =
            `Content truncated at 16000 characters (file has ${totalLines} lines). ` +
            "Use offset/limit to page through the rest if you need it.";
        }
        if (verdict.consecutive >= CONSECUTIVE_READ_BLOCK) {
          // 理论上 dedup 已被 noteReadServed 清空走 allow；此分支兜底硬拒
          return {
            success: false,
            error:
              `BLOCKED: You have read this exact file region ${verdict.consecutive} times in a row. ` +
              "The content has NOT changed. You already have this information. " +
              "STOP re-reading and proceed with your task.",
            guardrail_refusal: true,
            path: filePath,
          };
        }
        if (verdict.consecutive >= CONSECUTIVE_READ_WARN) {
          result.warning =
            `You have read this exact file region ${verdict.consecutive} times consecutively. ` +
            "The content has not changed since your last read. Use the information you already have.";
        }
        return result;
      }).catch((err: unknown) => {
        // ★ 2026-11-07 e2e 压测发现：ENOENT 错误里只有被解析路径，模型不知道
        //   workspace 根在哪、相对路径以谁为基准，连续用 `../` 之类的猜测碰壁。
        //   在报错里附上两个根目录的绝对路径，让模型能自行推导正确路径。
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("ENOENT") || message.includes("no such file")) {
          return {
            success: false,
            error: message,
            hint:
              `文件不存在。相对路径以 workspace 根为基准解析：${resolveWorkspaceBase()}；` +
              `沙箱根（仓库根）：${fsBase}；本次调用被解析为：${resolvedPath}。` +
              `如需访问仓库源码，请用工作区切换工具把工作区切到仓库根，或改用真实存在的相对路径。`,
          };
        }
        throw err;
      });
    }
  );

  executor.registerTool(
    "file_list",
    {
      name: "file_list",
      description: "List files and directories in a folder",
      parameters: {
        path: { type: "string", description: "Relative directory path to list（缺省列出工作区根目录）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const dirPath = String(params.path || ".");
      const { resolved: resolvedPath, forFs: fsDir } = resolveToolPath(fsBase, resolveWorkspaceBase(),dirPath);
      const pf = preflight(resolvedPath, fsBase, false);
      if (!pf.ok) return { success: false, error: pf.error };
      // ★ 2026-11-26（v33 complex-report-probe 实证）：模型常在「创建目录之前」
      //   先 file_list 探测目标目录是否存在。目录不存在时旧实现抛 ENOENT →
      //   被判定为一次工具失败（并进失败链），可这是正常的存在性探测，不是错误。
      //   对齐 shell `ls` 的直觉：目录缺失 → 返回空列表 + exists:false + 提示，
      //   让模型直接进入创建流程，而不是先处理一次假失败。
      if (!fs.existsSync(resolvedPath)) {
        return {
          path: dirPath,
          files: [],
          dirs: [],
          exists: false,
          hint: `目录尚不存在（解析为 ${resolvedPath}）。若要创建，用 file_write 写文件或 shell_exec 执行 mkdir -p。`,
        };
      }
      if (pf.insideSandbox) {
        return await errRecovery.executeWithRetry("file_list", fsDir, () => fsMgr.listAll(fsDir));
      }
      // 沙箱外目录列举（一般安全 / 一定风险档允许）
      return await errRecovery.executeWithRetry("file_list", fsDir, async () => {
        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true }).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
        }));
        return { path: dirPath, entries };
      });
    }
  );
}
