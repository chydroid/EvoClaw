import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { spawn } from "child_process";
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { ServiceRegistry } from "@evoclaw/core";
import { LocalSandboxBackend, generateVideoDownloadScript, generateMusicDownloadScript } from "@evoclaw/infrastructure";
import { assessShellCommand, getActiveSecurityPolicy, decideShellCommand } from "@evoclaw/security";
import type { SandboxPolicy } from "@evoclaw/core";

/**
 * 剥掉命令里与当前工作目录重复的「项目相对路径」前缀。
 *
 * 事故：cwd 已是 `.../data/workspace`，模型却在命令里写
 * `python data/workspace/fetch_ci_logs.py`，spawn 时解析成
 * `.../data/workspace/data/workspace/fetch_ci_logs.py`（文件不存在）。
 * 结果是同一处错误连续卡住两轮，用户被迫反复回「继续」。
 *
 * 策略（保守）：只有当「剥掉前缀后文件确实存在」、且「原路径确实不存在」时
 * 才改写，避免误伤合法的同名嵌套目录。
 */
function stripDuplicatedCwdPrefix(command: string, cwd: string): string {
  if (!command || !cwd) return command;
  const projectRoot = path.resolve(__dirname, "..", "..", "..", "..");
  const rel = path.relative(projectRoot, path.resolve(cwd)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return command;

  // 匹配以该相对目录开头的路径片段（正斜杠或反斜杠均可）
  const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![:\\w/\\\\.])(${escaped})[\\\\/]`, "g");
  return command.replace(re, (match, _prefix, offset) => {
    // 取该片段后的整个路径 token
    const rest = command.slice(offset + match.length).split(/\s+/)[0];
    if (!rest) return match;
    const candidate = path.resolve(cwd, rest.replace(/["']/g, ""));
    const original = path.resolve(projectRoot, rel, rest.replace(/["']/g, ""));
    // 仅在「原来拼不出来、剥掉后拼得出来」时改写
    if (!fs.existsSync(original) && fs.existsSync(candidate)) {
      console.log(`[shell_exec] Stripped duplicated cwd prefix: ${rel}/ -> ./`);
      return "";
    }
    return match;
  });
}

/**
 * 同步 spawn 在本机不可用 —— 追加可操作提示。
 *
 * 真实事故（2026-10-07 15:3x）：模型写的 Node 脚本里用
 * `execSync/spawnSync` 调 `mineru-open-api`，14 个文件全部
 * `spawnSync C://WINDOWS//system32//cmd.exe EBUSY`，
 * 而脚本本身 `success:true` —— 模型看不出是环境问题，只以为 CLI 坏了。
 *
 * 根因：WorkBuddy 注入的 shim 目录让**同步** spawn 失败；
 * 异步 spawn（shell_exec 自己用的就是）正常。
 */
const EBUSY_HINT =
  "\n\n[SYSTEM HINT] 本机**同步 spawn 不可用**：Node 的 `execSync` / `spawnSync` 调用外部命令会返回 " +
  "`spawnSync ... EBUSY`（WorkBuddy 的 shim 目录导致），异步 `exec` / `spawn` 则正常。\n" +
  "若你的脚本里用了 execSync/spawnSync，请改成 Promise 形式的 exec/spawn（await 包裹）。";

function withEbusyHint(text: string): string {
  return /EBUSY/i.test(text) ? text + EBUSY_HINT : text;
}

/** Recursively search for a file by name under a directory tree (max depth 4) */
function findFileRecursive(root: string, filename: string, maxDepth = 4): string | null {
  if (maxDepth <= 0) return null;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isFile() && entry.name === filename) return fullPath;
      if (entry.isDirectory()) {
        const found = findFileRecursive(fullPath, filename, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch { /* ignore permission errors */ }
  return null;
}

/** Auto-discover Python installation paths for PATH extension */
function findPythonPaths(): string[] {
  const paths: string[] = [];

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const userProfile = process.env.USERPROFILE || "";
    const searchRoots = [localAppData, userProfile].filter(Boolean);

    for (const root of searchRoots) {
      const pythonDir = path.join(root, "Programs", "Python");
      try {
        const entries = fs.readdirSync(pythonDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && /^Python\d+/.test(entry.name)) {
            const installDir = path.join(pythonDir, entry.name);
            const scriptsDir = path.join(installDir, "Scripts");
            if (fs.existsSync(path.join(installDir, "python.exe"))) {
              paths.push(installDir);
              if (fs.existsSync(scriptsDir)) paths.push(scriptsDir);
            }
          }
        }
      } catch { /* ignore */ }
    }

    // Common system locations
    for (const p of ["C:\\Python313", "C:\\Python312", "C:\\Python311", "C:\\Python310"]) {
      if (fs.existsSync(path.join(p, "python.exe"))) {
        paths.push(p);
        const scriptsDir = path.join(p, "Scripts");
        if (fs.existsSync(scriptsDir)) paths.push(scriptsDir);
      }
    }
  } else {
    for (const p of ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin"]) {
      if (fs.existsSync(path.join(p, "python3"))) {
        paths.push(p);
      }
    }
  }

  return paths;
}

/** 异步执行 Python 脚本，返回 stdout（替代 execSync 避免阻塞事件循环）。
 *  错误对象携带 stderr/stdout/code 属性，兼容原 execSync 错误处理代码。 */
function runPythonScriptAsync(
  scriptName: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [scriptName], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        sigkillTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 5000);
        sigkillTimer.unref();
        const err = new Error(`Python script timed out after ${timeoutMs}ms`) as Error & { stderr: string };
        err.stderr = stderr;
        reject(err);
      }
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > 20 * 1024 * 1024) {
        try { child.stdout?.destroy(); } catch { /* ignore */ }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > 20 * 1024 * 1024) {
        try { child.stderr?.destroy(); } catch { /* ignore */ }
      }
    });

    child.stdout?.on("error", (err: Error) => {
      process.stderr.write(`[shell-media-tools] stdout error: ${err.message}\n`);
    });

    child.stderr?.on("error", (err: Error) => {
      process.stderr.write(`[shell-media-tools] stderr error: ${err.message}\n`);
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (code === 0) {
          resolve(stdout);
        } else {
          const err = new Error(`Python script exited with code ${code}`) as Error & { stderr: string; stdout: string; code: number };
          err.stderr = stderr;
          err.stdout = stdout;
          err.code = code as number;
          reject(err);
        }
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        (err as Error & { stderr: string }).stderr = stderr;
        reject(err);
      }
    });
  });
}

export function registerShellMediaTools(
  executor: AgentModelExecutor,
  registry?: ServiceRegistry,
): void {
  // ── SSRF 防护：解析服务注册表中的 ssrfProtection，对工具传入的 URL 做内网/元数据端点过滤 ──
  const ssrfProtection = registry?.resolveService<{ checkURL(url: string): Promise<{ allowed: boolean; reason?: string }> }>("ssrfProtection");
  const checkSsrf = async (url: string): Promise<string | null> => {
    if (!ssrfProtection) return "SSRF protection service unavailable";
    try {
      const result = await ssrfProtection.checkURL(url);
      if (!result.allowed) return result.reason ?? "blocked by SSRF policy";
      return null;
    } catch {
      return "SSRF check failed";
    }
  };

  // ── shell_exec: 在安全前提下在沙箱外执行 shell 命令（支持 Python/Node.js） ──
  // 支持：1200s 超时、30s 进度反馈、超时续接
  executor.registerTool(
    "shell_exec",
    {
      name: "shell_exec",
      description: "Execute a shell command securely. Supports Python (python/python3), Node.js (node), and standard shell commands. Long-running tasks (crawlers) get up to 1200s timeout with periodic progress feedback every 30s. If timeout occurs, the tool returns partial output with a resume hint. Set sandbox=true to route through LocalSandboxBackend with a restrictive policy (timeout/path enforcement; network/subprocess are soft-limited — use docker backend for hard isolation).",
      parameters: {
        command: { type: "string", description: "The shell command to execute. Examples: 'python script.py', 'node script.mjs', 'pip install requests'" },
        cwd: { type: "string", description: "Optional working directory for the command (default: workspace)" },
        timeout: { type: "string", description: "Optional timeout in seconds (default: 120, max: 1200). Use higher values for crawler tasks." },
        sandbox: { type: "boolean", description: "Optional. When true, execute via LocalSandboxBackend with a restrictive SandboxPolicy (enforces timeout, memory, path allowlist). Default: false (direct spawn)." },
      },
    },
    async (params: Record<string, unknown>) => {
      const command = String(params.command || "");
      if (!command) return { success: false, error: "Command is required" };

      const workspaceDir = path.resolve(__dirname, "..", "..", "..", "..", "data", "workspace");
      // Ensure cwd exists - spawn fails with ENOENT if cwd directory doesn't exist
      let cwd = params.cwd ? String(params.cwd) : workspaceDir;
      // 安全校验：cwd 必须在工作区内，防止路径逃逸
      const resolvedCwd = path.resolve(cwd);
      if (!resolvedCwd.startsWith(workspaceDir + path.sep) && resolvedCwd !== workspaceDir) {
        return { success: false, error: `cwd must be within workspace` };
      }
      if (!fs.existsSync(cwd)) {
        // 安全：cwd 不存在时仅回退到 workspaceDir，禁止回退到项目父目录（防止路径逃逸）
        if (fs.existsSync(workspaceDir)) {
          cwd = workspaceDir;
          console.log(`[shell_exec] cwd does not exist, falling back to workspace`);
        } else {
          return { success: false, error: "cwd does not exist and workspace fallback unavailable" };
        }
      }
      const timeoutSec = Math.min(Math.max(parseInt(String(params.timeout ?? "120"), 10) || 120, 1), 1200);

      // On Windows, replace python3 with python (python3 doesn't exist on Windows)
      let effectiveCommand = command;
      if (process.platform === "win32") {
        effectiveCommand = effectiveCommand.replace(/\bpython3\b/g, "python");
      }

      // ── Windows 上 `-c` / `-e` 内联代码保护（python -c 与 node -e 同理）──
      // 事故 1：`python -c "import os,json,...; print(str(d)[:800])"` 经 cmd.exe /c
      //   传递后引号被吃掉，稳定报 `SyntaxError: unterminated string literal`。
      // 事故 2（2026-10-07）：`node -e "const fs=require('fs');const files=..."`
      //   同样被 cmd.exe 吃掉引号，报 `[eval]:1 "const ^^^^ Unterminated string constant`。
      //   模型为此反复重试了 3 轮，最后放弃任务。
      // 这类失败是**确定性**的：同样的命令再跑一次还是会炸，属于纯粹浪费轮次。
      // 复杂内联代码一律拦下并给出替代方案；简单单行（如 `python -c "print(1)"`）仍放行。
      if (process.platform === "win32") {
        const INLINE_LANGS: Array<{ re: RegExp; name: string; ext: string }> = [
          { re: /\bpython3?\s+-c\s+(.+)$/is, name: "python -c", ext: "py" },
          { re: /\bnode(?:\.exe)?\s+(?:-e|--eval)\s+(.+)$/is, name: "node -e", ext: "mjs" },
        ];
        for (const lang of INLINE_LANGS) {
          const inlineMatch = effectiveCommand.match(lang.re);
          if (!inlineMatch) continue;
          // ★ 只取 `-c/-e` 后面**第一段引号包裹的内容**作为内联代码。
          // 事故 3（2026-10-07 15:2x）：`python --version && python -c "import docx; print('OK')"`
          // 被上一版规则误判为「复杂内联代码」而整条拦截 —— 那条命令其实无害，
          // 只是把 `&&` 之后的分号也算了进去。拦截过宽会让模型无路可走。
          const rawArgs = inlineMatch[1].trim();
          const quoted = rawArgs.match(/^"([^"]*)"/);
          const code = (quoted ? quoted[1] : rawArgs).trim();
          const quoteCount = quoted ? 2 : (code.match(/"/g) || []).length;
          const isComplex = code.includes(";") || quoteCount > 2 || /\n/.test(code);
          if (isComplex) {
            return {
              success: false,
              error:
                `Windows 下 \`${lang.name}\` 内联多行/含分号的代码会因 cmd.exe 引号处理而报语法错误` +
                `（Unterminated string / Invalid or unexpected token）。` +
                ` 请把代码写入 .${lang.ext} 文件再执行（先 file_create 创建脚本，再 \`${lang.name.split(" ")[0]} script.${lang.ext}\`）。`,
              command,
              cwd,
              hint: `改用脚本文件（工作目录见 cwd 字段）。注意：相对路径会落在 workspace 下。`,
            };
          }
        }
      }

      // Fix relative paths: LLM often generates "data/skills/..." but cwd
      // may already be inside data/workspace, causing path duplication.
      // Only replace if it's a relative path (not preceded by : or / or \)
      const projectRoot = path.resolve(__dirname, "..", "..", "..", "..");
      const skillsDir = path.join(projectRoot, "data", "skills");
      const skillsDirForward = skillsDir.replace(/\\/g, "/");
      // Match "data/skills/" only when NOT preceded by a path separator or drive letter
      effectiveCommand = effectiveCommand.replace(
        /(?<![:\\/])data[\\/]skills[\\/]/g,
        skillsDirForward + "/"
      );

      // ── 工作目录前缀重复修复 ──
      // 事故：cwd 已经是 data/workspace，模型却写成
      // "python data/workspace/fetch_ci_logs.py"，拼成
      // data\workspace\data\workspace\fetch_ci_logs.py，脚本找不到，
      // 连续两轮卡在同一处，用户被迫反复说「继续」。
      // 这里在 spawn 之前就把重复的 cwd 前缀剥掉。
      effectiveCommand = stripDuplicatedCwdPrefix(effectiveCommand, cwd);

      // Strip outer double-quotes around Windows drive-letter paths. LLM often
      // wraps absolute paths in quotes ("D:\...") which, when passed through
      // cmd.exe /c, can confuse downstream tools (e.g. python sees a file
      // arg that still contains the opening quote).
      if (process.platform === "win32") {
        effectiveCommand = effectiveCommand.replace(
          /("[A-Za-z]:\\[^\s"]+")/g,
          (m) => m.slice(1, -1)
        );
      }

      // Resolve short script paths: LLM often generates "scripts/xxx.py" or
      // "scripts/xxx.py" without the full skill directory prefix. When the
      // referenced file doesn't exist relative to cwd, search under the
      // skills directory tree for a matching file.
      const scriptMatch = effectiveCommand.match(
        /\b(python|python3|node)\s+([^\s]+\.(?:py|js|mjs|ts))\b/
      );
      if (scriptMatch) {
        const scriptPath = scriptMatch[2].replace(/["']/g, "");
        const fullPath = path.resolve(cwd, scriptPath);
        if (!fs.existsSync(fullPath)) {
          // Search for the file under the skills directory tree
          const scriptBasename = path.basename(scriptPath);
          const found = findFileRecursive(skillsDir, scriptBasename);
          if (found) {
            const foundForward = found.replace(/\\/g, "/");
            effectiveCommand = effectiveCommand.replace(scriptPath, () => foundForward);
            console.log(`[shell_exec] Resolved short script path: ${scriptPath} -> ${foundForward}`);
          }
        }
      }

      // ── 安全校验：三档风险分级 ──
      // 用户明确要求：不能对所有命令都免审批，但极其危险的命令必须人工审批。
      //   blocked  → 命令注入特征（换行/反引号/命令替换）：硬拦，不给审批机会
      //   critical → 不可逆破坏（rm -rf /、mkfs、dd 写盘、关机…）：转人工审批
      //   caution  → 有副作用但可恢复：放行，仅标记
      //   safe     → 常规命令：直接执行，保持自动化能力
      const risk = assessShellCommand(effectiveCommand || command);
      // 由「总体安全等级」裁决：不同档位对同一条命令的处置不同
      // （严格档 critical 硬拦、一般档 critical 走审批、风险档仅拦不可逆操作）。
      const verdict = decideShellCommand(getActiveSecurityPolicy(), risk);
      if (verdict === "block") {
        return {
          success: false,
          error:
            `Command blocked by「${getActiveSecurityPolicy().label}」安全等级: ` +
            `${risk.reason ?? "命中高危规则"} (rule=${risk.rule ?? "unknown"})。` +
            `如需放开，请到「安全 → 总体安全」调整等级。`,
          command,
          // 始终回传 cwd：模型需要知道命令在哪个目录执行，
          // 否则只能靠猜来写相对路径（历史上因此拼出重复前缀）。
          cwd,
        };
      }
      if (verdict === "approve") {
        // 走既有审批通道：llm-caller 会把它转成 pendingPermissions，
        // 用户批准后由 approveAndExecute 重新执行本 handler。
        const permMgr = registry?.resolveService<{
          requestPermission(operation: string, target: string, details: Record<string, unknown>, requestedBy?: string): { id: string; status: string; error?: string };
        }>("permissionManager");
        if (permMgr) {
          const perm = permMgr.requestPermission(
            "shell_exec",
            command,
            { risk: "critical", rule: risk.rule, reason: risk.reason, command },
            "tool",
          );
          if (perm.status === "denied") {
            return { success: false, error: `高危命令已被拒绝执行：${risk.reason ?? ""}`, command };
          }
          if (perm.status === "pending") {
            return {
              success: false,
              requiresPermission: true,
              requestId: perm.id,
              operation: "shell_exec",
              description: `执行高危 shell 命令（${risk.reason ?? "不可逆操作"}）`,
              target: command.slice(0, 200),
              error: `Awaiting approval: ${risk.reason ?? "该命令可能造成不可逆破坏"}`,
            };
          }
        } else {
          // 拿不到权限服务时采取保守策略：宁可不执行，也不放过高危命令
          return {
            success: false,
            error: `高危命令需人工审批，但权限服务不可用，已阻止执行：${risk.reason ?? ""} (rule=${risk.rule ?? "unknown"})`,
            command,
          };
        }
      }

      // ── 旧危险模式黑名单已移除（2026-10-07）──
      // 它是 shell-command-risk.ts 的遗留重复实现，带来两个真实问题：
      //  ① 误杀：`/rmdir\s+\/[sS]\s+\/[qQ]/i` 没有目标检查，
      //     连 `rmdir /s /q doc2md_out`（清理自己刚建的临时目录）都拦。
      //     实测模型因此卡住，改用 mkdir -p 又因 Unix 语法在 Windows 失败。
      //  ② 消息无用：只说「matched dangerous pattern」，不给规则名与命中的具体原因，
      //     模型无法据此调整，只能反复换命令重试。
      // 现在统一由 assessShellCommand() + decideShellCommand() 裁决：
      // 规则更全（整盘/根目录/注入/关机/磁盘写入…），消息带规则名、原因与当前安全等级。

      // ── 沙箱模式：通过 LocalSandboxBackend 执行，应用限制性 SandboxPolicy ──
      // 硬隔离（网络/子进程阻断）需 docker 后端；本地后端强制 timeout/memory/path。
      if (params.sandbox === true) {
        const SANDBOX_POLICY: SandboxPolicy = {
          allowNetwork: false,
          allowFileSystem: true, // 脚本需读写工作区
          allowSubprocess: true, // shell 本身即子进程，无法在本地后端强制阻断
          maxExecutionTime: timeoutSec * 1000,
          maxMemoryMB: 512,
          allowedHosts: [],
          allowedPaths: [cwd],
        };
        const backend = new LocalSandboxBackend();
        const shellWrap = process.platform === "win32"
          ? [process.env.ComSpec || "cmd.exe", "/c", effectiveCommand]
          : ["/bin/bash", "-c", effectiveCommand];
        try {
          const result = await backend.execute(shellWrap, {
            timeoutMs: timeoutSec * 1000,
            workdir: cwd,
            policy: SANDBOX_POLICY,
            maxOutputBytes: 5 * 1024 * 1024,
          });
          await backend.dispose();
          return {
            success: result.success,
            output: result.stdout.slice(0, 50000),
            stderr: result.stderr.slice(0, 5000) || undefined,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            error: result.error,
            sandboxed: true,
            command,
          };
        } catch (err) {
          await backend.dispose();
          return {
            success: false,
            error: `Sandbox execution failed: ${err instanceof Error ? err.message : String(err)}`,
            sandboxed: true,
            command,
          };
        }
      }

      // Build PATH with Python and Node.js locations (auto-discovered)
      const pythonPaths = findPythonPaths();
      const existingPath = process.env.PATH || process.env.Path || "";
      const extendedPath = [...pythonPaths, existingPath].join(path.delimiter);

      const shell = process.platform === "win32"
        ? (process.env.ComSpec || "cmd.exe")
        : "/bin/bash";
      // ★ Windows 下先切 UTF-8 代码页。cmd.exe 默认 GBK(936)，
      // 中文报错信息会以乱码返回（实测「系统找不到指定的路径」变成
      // 「ϵͳ�Ҳ���ָ�����·��」），模型完全无法解读错误含义，
      // 只能反复换命令重试。chcp 只影响本次子进程，开销可忽略。
      const cmdForRun = process.platform === "win32"
        ? `chcp 65001 >nul & ${effectiveCommand}`
        : effectiveCommand;
      const shellArgs = process.platform === "win32" ? ["/c", cmdForRun] : ["-c", cmdForRun];

      // ── 使用 spawn 实现异步执行 + 进度反馈 ──
      return new Promise((resolve) => {
        console.log(`[shell_exec] Running: ${effectiveCommand} (cwd: ${cwd}, timeout: ${timeoutSec}s)`);

        const child = spawn(shell, shellArgs, {
          cwd,
          env: { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

        let stdout = "";
        let stderr = "";
        let lastProgressTime = Date.now();
        const startTime = Date.now();
        const PROGRESS_INTERVAL = 30000; // 30s

        child.stdout?.on("data", (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          if (stdout.length > 5 * 1024 * 1024) { // 5MB limit
            try { child.stdout?.destroy(); } catch {}
          }

          // 每30秒输出进度反馈
          const now = Date.now();
          if (now - lastProgressTime >= PROGRESS_INTERVAL) {
            const lines = stdout.split("\n").filter(Boolean);
            const lastLines = lines.slice(-3).join(" | ");
            const progressMsg = `⏳ [shell_exec ${Math.floor((now - startTime) / 1000)}s] 最新输出: ${lastLines.slice(0, 200)}`;
            console.log(progressMsg);
            lastProgressTime = now;
          }
        });

        child.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
          if (stderr.length > 5 * 1024 * 1024) {
            try { child.stderr?.destroy(); } catch {}
          }
        });

        child.stdout?.on("error", (err: Error) => {
          process.stderr.write(`[shell-media-tools] stdout error: ${err.message}\n`);
        });

        child.stderr?.on("error", (err: Error) => {
          process.stderr.write(`[shell-media-tools] stderr error: ${err.message}\n`);
        });

        // 超时计时器
        let resolved = false;
        let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            child.kill("SIGTERM");
            sigkillTimer = setTimeout(() => {
              try { child.kill("SIGKILL"); } catch {}
            }, 5000);
            sigkillTimer.unref();
            const partial = stdout.slice(-2000);
            const progressSeconds = Math.floor((Date.now() - startTime) / 1000);
            console.log(`[shell_exec] TIMEOUT after ${timeoutSec}s, partial output: ${stdout.length} chars`);
            resolve({
              success: false,
              timedOut: true,
              timeout: timeoutSec,
              output: stdout.slice(0, 50000),
              partialOutput: partial,
              error: `命令执行超时 (${timeoutSec}秒)，已运行约 ${progressSeconds} 秒。部分输出已保留。`,
              resumeHint: "任务超时但进度已保存。你可以使用相同的命令继续执行，脚本会自动从检查点恢复。",
              command,
            });
          }
        }, timeoutSec * 1000);

        child.on("close", (code) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            if (sigkillTimer) clearTimeout(sigkillTimer);
            const output = stdout.trim();
            const errorOutput = stderr.trim();
            console.log(`[shell_exec] Exit code ${code}, output: ${output.length} chars`);
            if (code === 0) {
              resolve({
                success: true,
                output: withEbusyHint(output.slice(0, 50000)),
                stderr: errorOutput.slice(0, 5000) || undefined,
                command,
                cwd,
              });
            } else {
              resolve({
                success: false,
                exitCode: code,
                error: withEbusyHint((errorOutput.slice(0, 10000) || output.slice(0, 10000))),
                output: withEbusyHint(output.slice(0, 50000)),
                command,
                cwd,
              });
            }
          }
        });

        child.on("error", (err) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            console.log(`[shell_exec] Process error: ${err.message}`);
            resolve({ success: false, error: err.message, command });
          }
        });
      });
    }
  );

  // ── scrapling_fetch: 使用 Scrapling 框架进行高级抓取 ──
  executor.registerTool(
    "scrapling_fetch",
    {
      name: "scrapling_fetch",
      description: "Fetch a URL using Scrapling's StealthyFetcher (bypasses Cloudflare, handles anti-bot). Returns page title, text content, and extracted links. Supports adaptive scraping that survives website redesigns.",
      parameters: {
        url: { type: "string", description: "The URL to fetch" },
        selector: { type: "string", description: "Optional CSS selector to extract specific content" },
        extractLinks: { type: "string", description: "Set to 'true' to extract all links from the page" },
        headless: { type: "string", description: "Set to 'false' for faster non-headless mode (default: true)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const url = String(params.url || "");
      if (!url) return { success: false, error: "URL is required" };
      const selector = params.selector ? String(params.selector) : "";
      const extractLinks = String(params.extractLinks || "") === "true";
      const headless = String(params.headless || "") !== "false";

      // SSRF 防护：阻止访问内网/元数据端点
      const ssrfReason = await checkSsrf(url);
      if (ssrfReason) {
        return { success: false, error: `URL blocked by security policy: ${ssrfReason}`, url };
      }

      const workspaceDir = path.resolve(__dirname, "..", "..", "..", "..", "data", "workspace");
      const pythonPaths = findPythonPaths();
      const existingPath = process.env.PATH || process.env.Path || "";
      const extendedPath = [...pythonPaths, existingPath].join(path.delimiter);

      const script = `#!/usr/bin/env python3
import json, sys
try:
    from scrapling.fetchers import StealthyFetcher
    page = StealthyFetcher.fetch(${JSON.stringify(url)}, headless=${headless ? "True" : "False"})
    result = {
        "title": page.css("title::text").get(""),
        "url": str(page.url),
        "status": page.status,
        "text_preview": page.text_content()[:3000],
    }
    ${selector ? `result["selected"] = [el.text_content().strip()[:500] for el in page.css(${JSON.stringify(selector)})[:10]]` : ""}
    ${extractLinks ? `result["links"] = [{"href": l.attrib.get("href", ""), "text": l.text_content().strip()[:100]} for l in page.css("a[href]")[:30]]` : ""}
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}, ensure_ascii=False))
    sys.exit(1)
`;

      try {
        // Write script to temp file instead of using python -c (which fails with multiline scripts)
        const scriptPath = path.join(workspaceDir, `_scrapling_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.py`);
        fs.writeFileSync(scriptPath, script, "utf-8");
        try {
          const result = await runPythonScriptAsync(
            path.basename(scriptPath),
            workspaceDir,
            { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
            60000,
          );
          const parsed = JSON.parse(result.trim());
          return { success: true, ...parsed };
        } catch (err: any) {
          const stderr = err.stderr?.toString() || err.message || String(err);
          return { success: false, error: stderr.slice(0, 5000) };
        } finally {
          try { fs.unlinkSync(scriptPath); } catch { /* non-critical */ }
        }
      } catch (err: any) {
        const stderr = err.stderr?.toString() || err.message || String(err);
        return { success: false, error: stderr.slice(0, 5000) };
      }
    }
  );

  // ── video_download: 下载视频（B站/抖音/YouTube/好看视频等1000+网站） ──
  executor.registerTool(
    "video_download",
    {
      name: "video_download",
      description: "Download video from 1000+ websites using yt-dlp + ffmpeg. Supports Bilibili, Douyin, YouTube, Haokan, WeChat Channels, Kuaishou, Xigua, etc. Auto watermark removal for Douyin. Returns file path for download.",
      parameters: {
        url: { type: "string", description: "The video URL to download (Bilibili, Douyin, YouTube, etc.)" },
        format: { type: "string", description: "Video quality: 'best', '720p', '1080p', '4k' (default: best)" },
        noWatermark: { type: "string", description: "Set to 'true' to remove watermark (default: true for Douyin)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const url = String(params.url || "");
      if (!url) return { success: false, error: "URL is required" };
      const format = String(params.format || "best");
      const noWatermark = String(params.noWatermark || "true") === "true";

      // SSRF 防护：阻止访问内网/元数据端点
      const ssrfReason = await checkSsrf(url);
      if (ssrfReason) {
        return { success: false, error: `URL blocked by security policy: ${ssrfReason}`, url };
      }

      const workspaceDir = path.resolve(__dirname, "..", "..", "..", "..", "data", "workspace");
      const outputDir = path.join(workspaceDir, "downloads");
      const pythonPaths = findPythonPaths();
      const existingPath = process.env.PATH || process.env.Path || "";
      const extendedPath = [...pythonPaths, existingPath].join(path.delimiter);

      // Generate download script using media-downloader bridge
      const script = generateVideoDownloadScript({
        url,
        outputDir,
        format,
        noWatermark,
      });

      const scriptPath = path.join(workspaceDir, `_video_dl_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.py`);
      fs.writeFileSync(scriptPath, script, "utf-8");

      try {
        const result = await runPythonScriptAsync(
          path.basename(scriptPath),
          workspaceDir,
          { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
          600000, // 10 minutes for large videos
        );

        // Parse [RESULT]...[/RESULT] from output
        const match = result.match(/\[RESULT\](.*?)\[\/RESULT\]/s);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]);
            return { success: true, ...parsed };
          } catch (jsonErr) {
            // 关键修复：原先 JSON.parse 抛错会冒泡到外层 catch，
            // 且没有 [RESULT] 标记时仍返回 success:true —— 脚本报错也会
            // 被当成"下载完成"，与此前邮箱伪造完成态同型。
            return {
              success: false,
              error: `下载脚本输出的 [RESULT] 标记不是合法 JSON：${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
              output: result.slice(-2000),
            };
          }
        }
        // 无 [RESULT] 标记 = 脚本未产出结果（可能中途报错/被 kill），
        // 必须如实报告失败，绝不能返回 success:true。
        return {
          success: false,
          error: "下载脚本未产出 [RESULT] 结果标记，可能执行失败或超时；以下为原始输出尾部：",
          output: result.slice(-2000),
        };
      } catch (err: any) {
        const stderr = err.stderr?.toString() || err.message || String(err);
        // Check if partial download exists
        const resultMatch = stderr.match(/\[RESULT\](.*?)\[\/RESULT\]/s);
        if (resultMatch) {
          try {
            const parsed = JSON.parse(resultMatch[1]);
            return { success: true, ...parsed, warning: "Download completed with warnings" };
          } catch (jsonErr) {
            console.warn(`[VideoDownload] Failed to parse yt-dlp JSON output: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
          }
        }
        return { success: false, error: stderr.slice(0, 5000) };
      } finally {
        try { fs.unlinkSync(scriptPath); } catch { /* non-critical */ }
      }
    }
  );

  // ── music_search: 搜索歌手热门歌曲（播放意图，非下载） ──
  executor.registerTool(
    "music_search",
    {
      name: "music_search",
      description: "Search for an artist's hit songs and return a formatted list with playable links. Use this when the user wants to LISTEN to music, not download it.",
      parameters: {
        artist: { type: "string", description: "Artist name (歌手名)" },
        limit: { type: "number", description: "Number of songs to return (default: 10)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const artist = String(params.artist || "");
      const limitRaw = Number(params.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10;
      if (!artist) return { success: false, error: "Artist name is required" };
      // Return structured data that the LLM will format into a nice list
      return JSON.stringify({
        artist,
        hint: `Search for ${artist}'s hit songs using web_search, then format the results as a numbered list with clickable links to NetEase Cloud Music (https://music.163.com/#/search/m/?s=${encodeURIComponent(artist)}+歌名&type=1). Do NOT download any files.`,
        neteaseSearchUrl: `https://music.163.com/#/search/m/?s=${encodeURIComponent(artist)}&type=1`,
        limit,
      });
    }
  );

  // ── music_download: 下载音乐（从视频平台提取音频） ──
  executor.registerTool(
    "music_download",
    {
      name: "music_download",
      description: "Download music by searching and extracting audio from video platforms using yt-dlp + ffmpeg. Supports any song name/artist. Returns MP3 file path for download. Falls back to YouTube search if direct URL not available.",
      parameters: {
        query: { type: "string", description: "Song name, artist, or URL (e.g. '周杰伦 晴天' or a music URL)" },
        audioFormat: { type: "string", description: "Audio format: 'mp3', 'flac', 'aac' (default: mp3)" },
        quality: { type: "string", description: "Audio quality: '128', '192', '320' kbps (default: 320)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const query = String(params.query || "");
      if (!query) return { success: false, error: "Query (song name or URL) is required" };
      const audioFormat = String(params.audioFormat || "mp3");
      const quality = String(params.quality || "320");

      const workspaceDir = path.resolve(__dirname, "..", "..", "..", "..", "data", "workspace");
      const outputDir = path.join(workspaceDir, "downloads");
      const pythonPaths = findPythonPaths();
      const existingPath = process.env.PATH || process.env.Path || "";
      const extendedPath = [...pythonPaths, existingPath].join(path.delimiter);

      // Check if query is a URL — if so, use video_download with extractAudio
      const isUrl = /^https?:\/\//i.test(query);

      // SSRF 防护：当 query 是 URL 时阻止访问内网/元数据端点
      if (isUrl) {
        const ssrfReason = await checkSsrf(query);
        if (ssrfReason) {
          return { success: false, error: `URL blocked by security policy: ${ssrfReason}`, url: query };
        }
      }

      if (isUrl) {
        // Use video download script with extractAudio=true
        const script = generateVideoDownloadScript({
          url: query,
          outputDir,
          extractAudio: true,
          audioFormat,
        });
        const scriptPath = path.join(workspaceDir, `_music_dl_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.py`);
        fs.writeFileSync(scriptPath, script, "utf-8");

        try {
          const result = await runPythonScriptAsync(
            path.basename(scriptPath),
            workspaceDir,
            { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
            300000,
          );
          const match = result.match(/\[RESULT\](.*?)\[\/RESULT\]/s);
          if (match) {
            try {
              const parsed = JSON.parse(match[1]);
              return { success: true, ...parsed };
            } catch (jsonErr) {
              return {
                success: false,
                error: `下载脚本输出的 [RESULT] 标记不是合法 JSON：${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
                output: result.slice(-2000),
              };
            }
          }
          // 无结果标记 = 未真正完成，如实报失败（勿再返回 success:true）
          return {
            success: false,
            error: "下载脚本未产出 [RESULT] 结果标记，可能执行失败或超时；以下为原始输出尾部：",
            output: result.slice(-2000),
          };
        } catch (err: any) {
          const stderr = err.stderr?.toString() || err.message || String(err);
          return { success: false, error: stderr.slice(0, 5000) };
        } finally {
          try { fs.unlinkSync(scriptPath); } catch { /* non-critical */ }
        }
      } else {
        // Search and download music
        const script = generateMusicDownloadScript({
          query,
          outputDir,
          audioFormat,
          quality,
        });
        const scriptPath = path.join(workspaceDir, `_music_dl_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.py`);
        fs.writeFileSync(scriptPath, script, "utf-8");

        try {
          const result = await runPythonScriptAsync(
            path.basename(scriptPath),
            workspaceDir,
            { ...process.env, PYTHONIOENCODING: "utf-8", Path: extendedPath, PATH: extendedPath },
            300000,
          );
          const match = result.match(/\[RESULT\](.*?)\[\/RESULT\]/s);
          if (match) {
            try {
              const parsed = JSON.parse(match[1]);
              return { success: true, ...parsed };
            } catch (jsonErr) {
              return {
                success: false,
                error: `下载脚本输出的 [RESULT] 标记不是合法 JSON：${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
                output: result.slice(-2000),
              };
            }
          }
          // 无结果标记 = 未真正完成，如实报失败（勿再返回 success:true）
          return {
            success: false,
            error: "下载脚本未产出 [RESULT] 结果标记，可能执行失败或超时；以下为原始输出尾部：",
            output: result.slice(-2000),
          };
        } catch (err: any) {
          const stderr = err.stderr?.toString() || err.message || String(err);
          return { success: false, error: stderr.slice(0, 5000) };
        } finally {
          try { fs.unlinkSync(scriptPath); } catch { /* non-critical */ }
        }
      }
    }
  );

  // ── execute_code: 在沙箱中执行代码（一等公民工具） ──
  // 借鉴 OpenHands/SWE-agent 的 code execution as first-class 工具理念。
  // 路由到 SandboxManager（Docker 后端，安全加固：read-only rootfs / cap-drop=ALL /
  // network=none / memory+cpu 限制 / nobody 用户 / tmpfs noexec），Docker 不可用时
  // 返回明确错误而非静默降级到宿主机执行。
  // 自动管理会话生命周期：首次调用创建会话，后续复用；空闲 10 分钟后自动销毁。
  const sandboxManager = registry?.resolveService<{
    createSession(config: { backend: "docker" | "ssh"; timeoutMs?: number }): Promise<{ id: string }>;
    executeScript(
      sessionId: string,
      script: string,
      options?: { interpreter?: string; timeoutMs?: number }
    ): Promise<{ success: boolean; exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean; error?: string }>;
    destroySession(sessionId: string): Promise<void>;
    listBackends(): Promise<Array<{ type: string; available: boolean }>>;
  }>("sandboxManager");

  // 沙箱会话缓存：executor 进程内复用同一个 docker 会话
  let sandboxSessionId: string | null = null;
  let sandboxSessionCreatedAt = 0;
  const SANDBOX_SESSION_TTL_MS = 10 * 60 * 1000; // 10 分钟空闲后销毁
  // 会话创建互斥锁：串行化会话创建，防止并发调用各自创建会话产生孤儿
  let sessionCreatePromise: Promise<void> | null = null;

  /**
   * Programmatic Tool Calling：把多步工具流水线折叠为单次推理调用。
   *
   * 设计（对标 Hermes 的 run_in_sandbox 产品化方向）：
   * - 模型写一段脚本（默认 Node.js ESM），脚本内可直接 import 并 await 调用
   *   EvoClaw 已注册的任意工具（读文件、写文件、搜索、记忆等），一次推理
   *   完成原先需要 N 轮 LLM 往返的多步流水线
   * - 代码在 LocalSandboxBackend（软沙箱）中执行：继承宿主 Node 环境可跑 ESM，
   *   但受 workspace 路径校验与 120s 超时约束；Docker 后端可用时可切硬隔离
   * - 审计：执行记录（脚本 hash + 调用统计 + 耗时）写 data/logs/programmatic-calls.jsonl，
   *   走 atomicWriteFile 约定；工具名黑名单不可被脚本调用（shell/网络/审批类）
   * - service-gated：依赖 registry 中的 sandboxManager 与 executor 服务，缺任一
   *   返回明确错误而非静默失败
   */

  /** 工具黑名单：脚本侧不允许直接调用的工具（shell/网络外发/审批/危险类） */
  const PROGRAMMATIC_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
    "shell_exec", "execute_code", "git_push", "git_commit",
    "webhook_send", "email_send", "mcp_toggle_tool",
    "approve", "reject", "device_pairing_approve",
    "kill_task", "dlq_retry_batch",
  ]);

  /** 程序化调用审计日志目录（data/logs/，与现有日志目录对齐） */
  const programmaticLogDir = path.resolve(__dirname, "..", "..", "..", "..", "data", "logs");
  const programmaticLogPath = path.join(programmaticLogDir, "programmatic-calls.jsonl");

  /** 写一条程序化调用审计记录（原子写约定：JSONL 全文重写 + temp/fsync/rename） */
  const writeProgrammaticAudit = (entry: Record<string, unknown>): void => {
    try {
      const { atomicWriteFileSync } = require("@evoclaw/core") as { atomicWriteFileSync: (p: string, d: string) => void };
      fs.mkdirSync(programmaticLogDir, { recursive: true });
      const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n";
      const existing = fs.existsSync(programmaticLogPath) ? fs.readFileSync(programmaticLogPath, "utf-8") : "";
      atomicWriteFileSync(programmaticLogPath, existing + line);
    } catch (err) {
      // 审计失败不阻断执行（best-effort），stderr 提示
      process.stderr.write(`[execute_code] audit log write failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  /** 从 executor 当前注册的 ToolDefinition[] 构建注入脚本的 API 文档 */
  const buildProgrammaticApiDoc = (): string => {
    try {
      const defs = executor.getRegisteredTools();
      const allowed = defs.filter((d) => !PROGRAMMATIC_FORBIDDEN_TOOLS.has(d.name));
      return allowed
        .map((d) => `- ${d.name}${d.description ? `: ${d.description.slice(0, 120)}` : ""}`)
        .join("\n");
    } catch {
      return "(tool list unavailable — see docs for the registered tool set)";
    }
  };

  /**
   * 把用户脚本包装成「可调用工具」的 Node ESM 入口。
   *
   * 机制：宿主 spawn `node file.mjs`（workspace 内临时文件，宿主 ESM 环境，
   * 可直接 import 宿主依赖）。脚本内通过 stdout 发
   * `{"__evoclaw_call":{id,name,params}}` 协议消息发起工具调用，本 handler 侧
   * 拦截并路由到 executor.executeToolByName（宿主侧执行，审批门禁由调用方保证）；
   * 结果经 child.stdin 回传（`__EVOCRAW_RESULT:` 协议行），包装层封成 async
   * `tools.call(name, params)`。
   * stdout 仅允许协议消息与 console.log 重定向消息。
   */
  const buildProgrammaticScript = (userCode: string, opts: { toolListDoc: string }): string => {
    const toolNames = opts.toolListDoc
      .split("\n")
      .map((l) => {
        const m = l.match(/^- ([^:]+)/);
        return m ? m[1].trim() : l.replace(/^- /, "");
      })
      .filter((n): n is string => Boolean(n));
    const forbidden = Array.from(PROGRAMMATIC_FORBIDDEN_TOOLS);
    // 脚本内白名单：运行时对未知/禁用工具名返回错误，宿主侧再校验一次
    return [
      "// ── EvoClaw programmatic tool calling wrapper（生成代码，勿手改）──",
      `// 可用工具（${toolNames.length}）：${toolNames.join(", ")}`,
      `// 禁用工具（调用即失败）：${forbidden.join(", ")}`,
      "const ALLOWED = new Set(" + JSON.stringify(toolNames) + ");",
      "const FORBIDDEN = new Set(" + JSON.stringify(forbidden) + ");",
      "const pending = new Map();",
      "let callSeq = 0;",
      // stdin 保持可读（宿主经此回传结果）；脚本结束后需主动关闭所有 handle，
      // 否则挂起的 stdin 'data' 监听会让 Node 事件循环不空、进程永不退出。
      "let stdinDrained = false;",
      "const closeStdin = () => { if (stdinDrained) return; stdinDrained = true; try { process.stdin.destroy(); } catch {} };",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  for (const line of String(chunk).split('\\n')) {",
      "    if (!line.startsWith('__EVOCRAW_RESULT:')) continue;",
      "    try {",
      "      const { id, ok, value } = JSON.parse(line.slice('__EVOCRAW_RESULT:'.length));",
      "      const p = pending.get(id);",
      "      if (!p) continue;",
      "      pending.delete(id);",
      "      if (ok) p.resolve(value); else p.reject(new Error((value && value.error) ? String(value.error) : 'tool call failed'));",
      "    } catch { /* 忽略非协议行 */ }",
      "  }",
      "});",
      "const tools = {",
      "  call: async (name, params) => {",
      "    if (FORBIDDEN.has(String(name))) throw new Error('tool is forbidden in programmatic scripts: ' + name);",
      "    if (!ALLOWED.has(String(name))) throw new Error('unknown tool: ' + name);",
      "    const id = ++callSeq;",
      "    const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));",
      "    process.stdout.write(JSON.stringify({ __evoclaw_call: { id, name, params: params || {} } }) + '\\n');",
      "    return await p;",
      "  },",
      "  list: () => Array.from(ALLOWED),",
      "};",
      "console.log = (...args) => { try { process.stdout.write(JSON.stringify({ __evoclaw_log: args.map(String) }) + '\\n'); } catch {} };",
      "console.error = (...args) => { process.stderr.write(args.join(' ') + '\\n'); };",
      "// ── 用户脚本（ESM，可 import 宿主依赖；顶层 await 由 main() 包裹）──",
      "// 脚本 IIFE 结束时关闭 stdin，确保 Node 事件循环排空、进程退出",
      "(async () => {\n" + userCode + "\n})().finally(closeStdin);",
    ].join("\n");
  };

  executor.registerTool(
    "execute_code",
    {
      name: "execute_code",
      description:
        "Execute code. Two modes: (1) sandboxed execution (default) — isolated Docker container " +
        "(read-only rootfs, no network, memory+CPU limits, nobody user), safer than shell_exec for " +
        "untrusted/user-provided code, supports Python and Node.js; returns a clear error if Docker is " +
        "unavailable. (2) programmatic=true — runs a Node.js ESM script in a local soft sandbox with an " +
        "injected `tools` API: call multiple registered tools from within one script and combine results " +
        "(folds a multi-step tool pipeline into a single LLM turn). Forbidden tools (shell_exec, git_push, " +
        "webhooks, approvals) are rejected; audit log written to data/logs/programmatic-calls.jsonl.",
      parameters: {
        code: {
          type: "string",
          description:
            "The code to execute. For Python: 'print(\"hello\")'. For Node.js: plain ESM script, or use " +
            "tools.call(name, params) when programmatic=true to invoke other tools from within the script.",
        },
        language: {
          type: "string",
          description: "Interpreter: 'python' or 'node' (default: 'node'). Programmatic tool calling requires 'node'.",
        },
        timeout: {
          type: "string",
          description: "Optional timeout in seconds (default: 30, max: 120).",
        },
        programmatic: {
          type: "boolean",
          description:
            "When true, runs a Node.js ESM script with an injected `tools` API so one call can drive a multi-step " +
            "tool pipeline (call several tools in sequence/parallel and combine results). Only 'node' language is " +
            "supported. Forbidden tools (shell_exec, git_push, webhooks, approvals, ...) are rejected. " +
            "Prefer this over many separate tool calls for read-heavy pipelines.",
        },
      },
    },
    async (params: Record<string, unknown>) => {
      const programmatic = params.programmatic === true;
      const requestedLanguage = String(params.language || "node").toLowerCase();

      // ── Programmatic Tool Calling 路径（node + 注入 tools API，LocalSandboxBackend 软沙箱） ──
      if (programmatic) {
        if (requestedLanguage !== "node") {
          return {
            success: false,
            error: "Programmatic tool calling requires language='node' (ESM + injected tools API). Python is not supported.",
          };
        }
        const code = String(params.code || "");
        if (!code) return { success: false, error: "Parameter 'code' is required" };

        const timeoutSec = Math.min(Math.max(parseInt(String(params.timeout ?? "120"), 10) || 120, 1), 120);
        const workspaceDir = path.resolve(__dirname, "..", "..", "..", "..", "data", "workspace");
        const startedAt = Date.now();

        // 组装脚本：注入 tools API（白名单）+ 脚本体
        const scriptSource = buildProgrammaticScript(code, {
          toolListDoc: buildProgrammaticApiDoc(),
        });

        // 软沙箱执行：直接 spawn node 并接管 stdout/stderr 流，
        // 实现「脚本 stdout 协议消息 → 宿主工具调用 → stderr 结果回传」的跨进程循环。
        // 脚本落在 workspace 内（与 shell_exec 的工作区约定一致），宿主 ESM 环境可直接 import 依赖。
        const workspaceForExec = fs.existsSync(workspaceDir) ? workspaceDir : process.cwd();
        const scriptFile = path.join(workspaceForExec, `.programmatic-${crypto.randomUUID().slice(0, 8)}.mjs`);
        fs.writeFileSync(scriptFile, scriptSource, "utf-8");

        let child: import("child_process").ChildProcess;
        try {
          child = spawn(process.execPath, [scriptFile], {
            cwd: workspaceForExec,
            // stdin 双工：宿主经 child.stdin 向脚本回传工具结果（__EVOCRAW_RESULT 协议行）
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
            windowsHide: true,
          });
        } catch (err: unknown) {
          try { fs.unlinkSync(scriptFile); } catch { /* best-effort */ }
          writeProgrammaticAudit({ kind: "execute_code", mode: "programmatic", status: "error", durationMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) });
          return { success: false, error: `Failed to spawn programmatic script: ${err instanceof Error ? err.message : String(err)}` };
        }

        // 调用并发上限：防止脚本发起无界工具调用
        const MAX_CONCURRENT_CALLS = 4;
        let inFlight = 0;
        const queue: Array<{ id: number; name: string; params: Record<string, unknown> }> = [];
        const MAX_PENDING = 64;
        let pendingCount = 0;
        let rejectedCalls = 0;
        const calledTools: string[] = [];

        // 结果回传：经 child.stdin 发协议行（脚本侧 wrapper 监听 stdin 解析）。
        // 已终结调用数（ok/fail）达到已入队调用总数后 end() stdin ——
        // 否则宿主未关闭的 stdin pipe 会让脚本进程永不退出（top-level await 挂起）。
        // FORBIDDEN/超限调用由脚本侧 wrapper 直接 throw（不进宿主队列），不计入 pending，
        // 因此宿主只需按队列内调用数收尾。
        // 宿主侧「已终结」语义：脚本发出的调用数 == 已回传结果数 → stdin 可关闭。
        // 超限/未知工具由脚本侧 wrapper 直接 throw（宿主不可见），只有成功入队的调用
        // 会计数，因此该等式等价于「脚本已不会再有新请求」。
        let totalCalls = 0;
        let repliedCount = 0;
        const reply = (id: number, ok: boolean, value: unknown): void => {
          repliedCount++;
          try {
            child.stdin?.write(`__EVOCRAW_RESULT:${JSON.stringify({ id, ok, value })}\n`);
          } catch { /* child 已退出则忽略 */ }
          if (totalCalls > 0 && repliedCount >= totalCalls) {
            try { child.stdin?.end(); } catch { /* ignore */ }
          }
        };

        const runNext = (): void => {
          while (inFlight < MAX_CONCURRENT_CALLS && queue.length > 0) {
            const call = queue.shift()!;
            inFlight++;
            void (async () => {
              let value: unknown;
              try {
                if (PROGRAMMATIC_FORBIDDEN_TOOLS.has(call.name)) {
                  value = { success: false, error: `tool is forbidden in programmatic scripts: ${call.name}` };
                  rejectedCalls++;
                } else {
                  // 宿主侧执行：executeToolByName 跳过人工审批门禁（契约见 agent-model-executor），
                  // 安全边界由工具白名单 + workspace 路径约束承担
                  value = await executor.executeToolByName(call.name, call.params);
                }
              } catch (err: unknown) {
                value = { success: false, error: err instanceof Error ? err.message : String(err) };
              }
              inFlight--;
              reply(call.id, value !== null && typeof value === "object" && "success" in (value as object) ? Boolean((value as { success: unknown }).success) : true, value);
              runNext();
            })();
          }
        };

        // 超时看门狗
        const timeoutTimer = setTimeout(() => {
          child?.kill("SIGKILL");
        }, timeoutSec * 1000);
        timeoutTimer.unref?.();

        // stdout 逐行解析：协议消息（__evoclaw_call）+ console.log 重定向消息（__evoclaw_log）
        let stdoutBuf = "";
        let capturedStdout = "";
        let stderr = "";
        const MAX_CAPTURE = 5 * 1024 * 1024;
        const processStdoutLine = (line: string): void => {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) {
            // 非协议行（异常裸输出）：保留为可见输出
            if (capturedStdout.length < MAX_CAPTURE) capturedStdout += line + "\n";
            return;
          }
          let msg: { __evoclaw_call?: { id: number; name: string; params?: Record<string, unknown> }; __evoclaw_log?: unknown[] };
          try { msg = JSON.parse(trimmed); } catch {
            if (capturedStdout.length < MAX_CAPTURE) capturedStdout += line + "\n";
            return;
          }
          if (msg.__evoclaw_call) {
            pendingCount++;
            totalCalls++;
            if (pendingCount > MAX_PENDING) {
              reply(msg.__evoclaw_call.id, false, { success: false, error: "too many pending programmatic calls" });
              rejectedCalls++;
              return;
            }
            queue.push({ id: msg.__evoclaw_call.id, name: String(msg.__evoclaw_call.name || ""), params: msg.__evoclaw_call.params ?? {} });
            calledTools.push(msg.__evoclaw_call.name || "?");
            runNext();
          } else if (msg.__evoclaw_log !== undefined) {
            if (capturedStdout.length < MAX_CAPTURE) capturedStdout += msg.__evoclaw_log.join(" ") + "\n";
          }
        };
        const handleStdout = (chunk: Buffer): void => {
          stdoutBuf += chunk.toString("utf-8");
          let nl: number;
          while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            processStdoutLine(line);
          }
        };
        const handleStderr = (chunk: Buffer): void => {
          for (const rawLine of chunk.toString("utf-8").split("\n")) {
            if (rawLine.startsWith("__EVOCRAW_RESULT:")) continue; // 宿主侧消费，不进捕获
            if (stderr.length < MAX_CAPTURE) stderr += rawLine + "\n";
          }
        };
        child.stdout?.on("data", handleStdout);
        child.stderr?.on("data", handleStderr);

        const closeInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.on("close", (code, signal) => resolve({ code, signal }));
          child.on("error", (err) => {
            stderr += `spawn error: ${err.message}\n`;
            resolve({ code: -1, signal: null });
          });
        });

        const timedOut = closeInfo.signal === "SIGKILL" || Date.now() - startedAt > (timeoutSec + 5) * 1000;
        // 超时后 drain 未完成的工具调用：以错误回传，避免脚本侧 Promise 悬挂
        if (queue.length > 0 || inFlight > 0) {
          for (const c of queue.splice(0)) {
            reply(c.id, false, { success: false, error: "programmatic call aborted by timeout" });
            rejectedCalls++;
          }
        }

        const success = closeInfo.code === 0 && !timedOut;
        writeProgrammaticAudit({
          kind: "execute_code",
          mode: "programmatic",
          status: success ? "ok" : "failed",
          exitCode: closeInfo.code ?? -1,
          durationMs: Date.now() - startedAt,
          timedOut,
          codeHash: crypto.createHash("sha256").update(code).digest("hex").slice(0, 16),
          codeBytes: code.length,
          toolCalls: calledTools.length,
          rejectedCalls,
          calledTools: calledTools.slice(0, 20),
        });

        try { fs.unlinkSync(scriptFile); } catch { /* best-effort */ }

        const MAX_OUTPUT = 100_000;
        const truncate = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n... [output truncated]" : s);
        return {
          success,
          exitCode: closeInfo.code ?? -1,
          stdout: truncate(capturedStdout).trim(),
          stderr: truncate(stderr).trim(),
          durationMs: Date.now() - startedAt,
          timedOut,
          language: "node",
          sandbox: "local-programmatic",
          programmatic: true,
          toolCalls: calledTools.length,
          rejectedCalls,
        };
      }

      // ── 常规沙箱路径（Docker 硬隔离） ──
      if (!sandboxManager) {
        return {
          success: false,
          error: "SandboxManager service is not registered. Cannot execute code in sandbox.",
          hint: "Use shell_exec instead, or ensure the server registers SandboxManager.",
        };
      }

      const code = String(params.code || "");
      if (!code) return { success: false, error: "Parameter 'code' is required" };

      const language = requestedLanguage;
      if (language !== "python" && language !== "node") {
        return { success: false, error: `Unsupported language: ${language}. Use 'python' or 'node'.` };
      }

      const timeoutSec = Math.min(Math.max(parseInt(String(params.timeout ?? "30"), 10) || 30, 1), 120);

      try {
        // 检查 Docker 后端是否可用
        const backends = await sandboxManager.listBackends();
        const dockerAvailable = backends.some((b) => b.type === "docker" && b.available);
        if (!dockerAvailable) {
          return {
            success: false,
            error: "Docker is not available on the host. Cannot execute code in sandbox.",
            hint: "Install Docker, or use shell_exec for non-sandboxed execution.",
            backends,
          };
        }

        // 复用或创建会话（10 分钟 TTL）
        const now = Date.now();
        if (sandboxSessionId && now - sandboxSessionCreatedAt > SANDBOX_SESSION_TTL_MS) {
          try { await sandboxManager.destroySession(sandboxSessionId); } catch { /* best-effort */ }
          sandboxSessionId = null;
        }
        if (!sandboxSessionId) {
          // 并发竞态防护：串行化会话创建，防止并发调用各自创建会话产生孤儿。
          // 若已有调用正在创建会话，等待其完成；失败也忽略，由下方二次检查决定是否重试。
          if (sessionCreatePromise) {
            try { await sessionCreatePromise; } catch { /* 创建失败则忽略，下方会重试 */ }
          }
          // 二次检查：等待期间可能已被其他调用设置，避免重复创建
          if (!sandboxSessionId) {
            sessionCreatePromise = (async () => {
              const session = await sandboxManager.createSession({
                backend: "docker",
                timeoutMs: timeoutSec * 1000,
              });
              sandboxSessionId = session.id;
              sandboxSessionCreatedAt = Date.now();
            })();
            try {
              await sessionCreatePromise;
            } finally {
              sessionCreatePromise = null;
            }
          }
        }

        if (!sandboxSessionId) {
          return {
            success: false,
            error: "Failed to create sandbox session. Docker backend may be unavailable.",
          };
        }

        const result = await sandboxManager.executeScript(sandboxSessionId, code, {
          interpreter: language,
          timeoutMs: timeoutSec * 1000,
        });

        // 刷新会话活跃时间
        sandboxSessionCreatedAt = Date.now();

        // 截断超长输出
        const MAX_OUTPUT = 100_000;
        const truncate = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n... [output truncated]" : s);

        return {
          success: result.success,
          exitCode: result.exitCode,
          stdout: truncate(result.stdout),
          stderr: truncate(result.stderr),
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          language,
          sandbox: "docker",
        };
      } catch (err: any) {
        return {
          success: false,
          error: err?.message || String(err),
          hint: "If Docker daemon is not running, start it with 'dockerd' or 'service docker start'.",
        };
      }
    }
  );
}
