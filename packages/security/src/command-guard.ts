/**
 * Command Guard — 命令安全护栏
 *
 * 借鉴 hermes-agent 的 tools/approval.py + tools/ansi_strip.py + tools/threat_patterns.py 设计：
 *
 * 三层防御（hermes-agent 模型）：
 *   1. HARDLINE_PATTERNS — 无条件阻止（rm -rf /、mkfs、dd 到块设备、fork bomb、shutdown 等）
 *      不可被 yolo / 配置 / cron 覆盖；这是"地板层"。
 *   2. DANGEROUS_PATTERNS — 需要人工批准（rm -r、chmod 777、git push --force 等）
 *   3. LLM 智能批准 — 低风险命令自动通过
 *
 * 命令归一化（_normalize_command_for_detection）：
 *   - 剥离 ANSI 转义序列（完整 ECMA-48：CSI/OSC/DCS/8-bit C1）
 *   - 移除 null 字节
 *   - Unicode NFKC 归一化（防 fullwidth/半角片假名绕过）
 *   - 剥离 shell 反斜杠转义（r\m → rm）
 *   - 剥离空字符串字面量（r''m → rm）
 *
 * 环境变量写入黑名单（_HERMES_PROVIDER_ENV_BLOCKLIST 等价物）：
 *   - LLM provider 凭据（OPENAI_API_KEY、ANTHROPIC_TOKEN 等）
 *   - RCE 向量（LD_PRELOAD、PYTHONPATH、PATH、EDITOR 等）
 */

// ── ANSI Escape Stripping ─────────────────────────────────

/**
 * 完整 ECMA-48 ANSI 转义序列正则。
 *
 * 覆盖：CSI（含私有模式 ?、冒号分隔参数、中间字节）、
 * OSC（BEL 和 ST 终止符）、DCS/SOS/PM/APC 字符串序列、
 * nF 多字节转义、Fp/Fe/Fs 单字节转义、8-bit C1 控制字符。
 *
 * 端口自 hermes-agent tools/ansi_strip.py。
 */
const _ANSI_ESCAPE_RE = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?(?:\x1b\\)|[\x20-\x2f]+[\x30-\x7e]|[\x30-\x7e])|\x9b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x9d[\s\S]*?(?:\x07|\x9c)|[\x80-\x9f]/g;

// 快速路径：仅当存在 ESC 或 C1 字节时才走完整正则。
const _HAS_ESCAPE_RE = /[\x1b\x80-\x9f]/;

/**
 * 剥离 ANSI 转义序列。
 * 无转义字节时直接返回原值（快速路径）。
 */
export function stripAnsi(text: string): string {
  if (!text || !_HAS_ESCAPE_RE.test(text)) {
    return text;
  }
  return text.replace(_ANSI_ESCAPE_RE, "");
}

// ── Command Normalization ─────────────────────────────────

/**
 * 命令归一化：在模式匹配前清理混淆字符。
 *
 * 防止以下绕过技术：
 *   - ANSI 转义序列注入（在命令中嵌入颜色码分割关键词）
 *   - null 字节截断（rm\0 -rf /）
 *   - Unicode fullwidth 字符（ｒｍ -rf /）
 *   - 反斜杠转义（r\m → rm）
 *   - 空字符串字面量（r''m → rm）
 *
 * 端口自 hermes-agent _normalize_command_for_detection。
 */
export function normalizeCommand(input: string): string {
  if (!input) return "";

  // 1. 剥离 ANSI 转义序列
  let cmd = stripAnsi(input);

  // 2. 移除 null 字节
  cmd = cmd.replace(/\x00/g, "");

  // 3. Unicode NFKC 归一化（fullwidth Latin、半角片假名等）
  cmd = cmd.normalize("NFKC");

  // 4. 剥离 shell 反斜杠转义：r\m → rm
  cmd = cmd.replace(/\\([^\n])/g, "$1");

  // 5. 剥离空字符串字面量：r''m → rm, r""m → rm
  cmd = cmd.replace(/''|""/g, "");

  return cmd;
}

// ── Hardline Patterns (Unconditional Block) ───────────────

/**
 * 命令位置锚点：匹配命令起始位置（行首、命令分隔符后、子 shell 开头），
 * 可选消费前导包装命令（sudo、env VAR=VAL、exec、nohup、setsid）。
 *
 * 用于 shutdown/reboot 等模式，避免误匹配 "echo reboot" 或 "grep 'shutdown' log"。
 */
const _CMDPOS =
  "(?:^|[;&|\\n`]|\\$\\()\\s*" + // 起始位置
  "(?:sudo\\s+(?:-[^\\s]+\\s+)*)?" + // 可选 sudo + flags
  "(?:env\\s+(?:\\w+=\\S*\\s+)*)?" + // 可选 env VAR=VAL
  "(?:(?:exec|nohup|setsid|time)\\s+)*" + // 可选包装命令
  "\\s*";

export interface HardlinePattern {
  /** 编译后的正则 */
  pattern: RegExp;
  /** 人类可读的阻止原因 */
  reason: string;
}

/**
 * Hardline 无条件阻止模式。
 *
 * 这些命令如此灾难性，以至于永远不应通过 agent 运行——
 * 即使 yolo / approvals.mode=off / cron 也不能覆盖。
 *
 * 列表刻意保持精简：只包含无恢复路径的操作：
 *   - 文件系统销毁（根目录 rm -rf）
 *   - 原始块设备覆写（mkfs、dd to /dev/）
 *   - 内核关机/重启
 *   - 拒绝服务命令（fork bomb、kill -1）
 *
 * 可恢复但代价高昂的操作（git reset --hard、rm -rf /tmp/x、chmod -R 777、curl|sh）
 * 归入 DANGEROUS_PATTERNS，允许 yolo 通过。
 */
export const HARDLINE_PATTERNS: HardlinePattern[] = [
  // rm 递归删除根文件系统或受保护根目录
  // 注意：alternation 必须包含 /\*（匹配 /*），不能只匹配 / 和 *
  // 否则 rm -rf /* 会因 / 后跟 * 不匹配 \s|$ 而漏检
  {
    pattern: /\brm\s+(-[^\s]*\s+)*(\/|\/\*|\/ \*)(\s|$)/i,
    reason: "recursive delete of root filesystem",
  },
  {
    pattern: /\brm\s+(-[^\s]*\s+)*(\/home|\/home\/\*|\/root|\/root\/\*|\/etc|\/etc\/\*|\/usr|\/usr\/\*|\/var|\/var\/\*|\/bin|\/bin\/\*|\/sbin|\/sbin\/\*|\/boot|\/boot\/\*|\/lib|\/lib\/\*)(\s|$)/i,
    reason: "recursive delete of system directory",
  },
  {
    pattern: /\brm\s+(-[^\s]*\s+)*(~|\$HOME)(\/?|\/\*)?(\s|$)/i,
    reason: "recursive delete of home directory",
  },
  // 文件系统格式化
  {
    pattern: /\bmkfs(\.[a-z0-9]+)?\b/i,
    reason: "format filesystem (mkfs)",
  },
  // 原始块设备覆写（dd + 重定向）
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*/i,
    reason: "dd to raw block device",
  },
  {
    pattern: />\s*\/dev\/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b/i,
    reason: "redirect to raw block device",
  },
  // Fork bomb（经典 shell 形式）
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "fork bomb",
  },
  // 杀死系统所有进程
  {
    pattern: /\bkill\s+(-[^\s]+\s+)*-1\b/i,
    reason: "kill all processes",
  },
  // 系统关机/重启 — 锚定命令位置，避免误匹配 "echo reboot"
  {
    pattern: new RegExp(_CMDPOS + "(shutdown|reboot|halt|poweroff)\\b", "i"),
    reason: "system shutdown/reboot",
  },
  {
    pattern: new RegExp(_CMDPOS + "init\\s+[06]\\b", "i"),
    reason: "init 0/6 (shutdown/reboot)",
  },
  {
    pattern: new RegExp(_CMDPOS + "systemctl\\s+(poweroff|reboot|halt|kexec)\\b", "i"),
    reason: "systemctl poweroff/reboot",
  },
  {
    pattern: new RegExp(_CMDPOS + "telinit\\s+[06]\\b", "i"),
    reason: "telinit 0/6 (shutdown/reboot)",
  },
];

// ── Dangerous Patterns (Require Approval) ─────────────────

export interface DangerousPattern {
  /** 编译后的正则 */
  pattern: RegExp;
  /** 人类可读的原因 */
  reason: string;
}

/**
 * Dangerous 模式 — 需要人工批准但可被 yolo 模式覆盖。
 *
 * 借鉴 hermes-agent tools/approval.py DANGEROUS_PATTERNS（47 个模式）。
 * 这些命令有副作用但可恢复，在 yolo 模式下自动通过，
 * 非 yolo 模式下需要用户确认。
 *
 * 分类：
 *   - 文件删除（rm -r、rmdir）
 *   - 权限修改（chmod 777、chown）
 *   - 版本控制（git push --force、git reset --hard）
 *   - 包管理（npm install、pip install）
 *   - 网络下载执行（curl|sh、wget|bash）
 *   - 系统配置（sysctl、iptables）
 *   - 容器操作（docker rm、docker rmi）
 */
export const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // ── 文件删除 ──
  { pattern: /\brm\s+(-[^\s]*\s+)*-r/i, reason: "recursive file deletion" },
  { pattern: /\brm\s+(-[^\s]*\s+)*-f/i, reason: "force file deletion" },
  { pattern: /\brmdir\b/i, reason: "directory removal" },
  // ── 权限修改 ──
  { pattern: /\bchmod\s+(-[^\s]*\s+)*777\b/i, reason: "chmod 777 (world-writable)" },
  { pattern: /\bchmod\s+(-[^\s]*\s+)*-R\b/i, reason: "recursive chmod" },
  { pattern: /\bchown\b/i, reason: "ownership change" },
  { pattern: /\bchgrp\b/i, reason: "group change" },
  // ── 版本控制 ──
  { pattern: /\bgit\s+push\s+(-[^\s]*\s+)*--force\b/i, reason: "git push --force" },
  { pattern: /\bgit\s+push\s+(-[^\s]*\s+)*-f\b/i, reason: "git push -f (force)" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard" },
  { pattern: /\bgit\s+clean\s+-[^\s]*f/i, reason: "git clean -f (force)" },
  { pattern: /\bgit\s+rebase\b/i, reason: "git rebase" },
  // ── 包管理 ──
  { pattern: /\bnpm\s+install\b/i, reason: "npm install (executes install scripts)" },
  { pattern: /\bnpm\s+i\s+/i, reason: "npm install (executes install scripts)" },
  { pattern: /\bpip\s+install\b/i, reason: "pip install" },
  { pattern: /\bpip3\s+install\b/i, reason: "pip3 install" },
  { pattern: /\byarn\s+add\b/i, reason: "yarn add" },
  { pattern: /\bpnpm\s+add\b/i, reason: "pnpm add" },
  // ── 网络下载执行 ──
  { pattern: /\bcurl\b[^\n|]*\|\s*(sh|bash|zsh|python|perl)\b/i, reason: "curl piped to shell interpreter" },
  { pattern: /\bwget\b[^\n|]*\|\s*(sh|bash|zsh|python|perl)\b/i, reason: "wget piped to shell interpreter" },
  { pattern: /\bcurl\b[^\n]*\|\s*sh\b/i, reason: "curl | sh" },
  // ── 系统配置 ──
  { pattern: /\bsysctl\b/i, reason: "kernel parameter modification" },
  { pattern: /\biptables\b/i, reason: "firewall rule modification" },
  { pattern: /\bufw\b/i, reason: "firewall rule modification" },
  // ── 容器操作 ──
  { pattern: /\bdocker\s+rm\b/i, reason: "docker container removal" },
  { pattern: /\bdocker\s+rmi\b/i, reason: "docker image removal" },
  { pattern: /\bdocker\s+compose\s+(down|restart|kill)\b/i, reason: "docker compose destructive action" },
  { pattern: /\bdocker\s+volume\s+rm\b/i, reason: "docker volume removal" },
  { pattern: /\bdocker\s+system\s+prune\b/i, reason: "docker system prune" },
  // ── 进程管理 ──
  { pattern: /\bkillall\b/i, reason: "kill all processes by name" },
  { pattern: /\bpkill\b/i, reason: "kill processes by pattern" },
  { pattern: /\bkill\s+-9\b/i, reason: "kill -9 (SIGKILL)" },
  // ── 磁盘操作 ──
  { pattern: /\bdu\s+-[^\s]*h/i, reason: "disk usage (may be slow on large dirs)" },
  { pattern: /\bdf\s+-[^\s]*h/i, reason: "disk free check" },
  // ── sudo ──
  { pattern: /\bsudo\s+-S\b/i, reason: "sudo -S (password from stdin — possible brute force)" },
  { pattern: /\bsudo\s+-k\b/i, reason: "sudo -k (reset timestamp)" },
  // ── 网络工具 ──
  { pattern: /\bnc\b/i, reason: "netcat (network tool)" },
  { pattern: /\bncat\b/i, reason: "ncat (network tool)" },
  { pattern: /\bssh\b/i, reason: "ssh (remote shell)" },
  { pattern: /\bscp\b/i, reason: "scp (remote copy)" },
  { pattern: /\brsync\b/i, reason: "rsync (remote sync)" },
  // ── 编译/构建 ──
  { pattern: /\bmake\b/i, reason: "make (executes Makefile)" },
  { pattern: /\bgcc\b/i, reason: "gcc compilation" },
  { pattern: /\bg\+\+\b/i, reason: "g++ compilation" },
  // ── 数据库 ──
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, reason: "SQL DROP" },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, reason: "SQL TRUNCATE" },
  { pattern: /\bDELETE\s+FROM\b/i, reason: "SQL DELETE" },
  // ── 其他 ──
  { pattern: /\bcrontab\b/i, reason: "crontab modification" },
  { pattern: /\bat\b\s+\d/i, reason: "at (scheduled command)" },
];

// ── Hardline Check ────────────────────────────────────────

export interface HardlineCheckResult {
  /** 是否被阻止 */
  blocked: boolean;
  /** 阻止原因（blocked=true 时有值） */
  reason?: string;
  /** 归一化后的命令（用于日志/审计） */
  normalizedCommand?: string;
}

/**
 * 检查命令是否匹配 Hardline 无条件阻止模式。
 *
 * 在匹配前先归一化命令，防止 ANSI/null/Unicode/反斜杠绕过。
 *
 * @example
 * ```ts
 * const result = checkHardline("rm -rf /");
 * if (result.blocked) {
 *   throw new Error(`BLOCKED (hardline): ${result.reason}`);
 * }
 * ```
 */
export function checkHardline(command: string): HardlineCheckResult {
  return checkHardlineNormalized(normalizeCommand(command).toLowerCase());
}

function checkHardlineNormalized(normalized: string): HardlineCheckResult {
  for (const { pattern, reason } of HARDLINE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { blocked: true, reason, normalizedCommand: normalized };
    }
  }

  return { blocked: false, normalizedCommand: normalized };
}

// ── Dangerous Check ───────────────────────────────────────

export interface DangerousCheckResult {
  /** 是否需要批准 */
  needsApproval: boolean;
  /** 原因 */
  reason?: string;
  /** 归一化后的命令 */
  normalizedCommand?: string;
}

/**
 * 检查命令是否匹配 Dangerous 模式（需要人工批准）。
 *
 * 在 yolo 模式下，dangerous 命令自动通过；
 * 非 yolo 模式下，需要用户确认。
 *
 * @example
 * ```ts
 * const hardline = checkHardline(cmd);
 * if (hardline.blocked) throw new Error(`BLOCKED: ${hardline.reason}`);
 * const dangerous = checkDangerous(cmd);
 * if (dangerous.needsApproval && !yoloMode) {
 *   const approved = await requestApproval(cmd, dangerous.reason);
 *   if (!approved) throw new Error("User denied");
 * }
 * ```
 */
export function checkDangerous(command: string): DangerousCheckResult {
  return checkDangerousNormalized(normalizeCommand(command).toLowerCase());
}

function checkDangerousNormalized(normalized: string): DangerousCheckResult {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(normalized)) {
      return { needsApproval: true, reason, normalizedCommand: normalized };
    }
  }

  return { needsApproval: false, normalizedCommand: normalized };
}

// ── Unified Command Guard ─────────────────────────────────

export type CommandGuardAction = "block" | "approve" | "allow";

export interface CommandGuardResult {
  /** 最终决策 */
  action: CommandGuardAction;
  /** 原因 */
  reason?: string;
  /** 归一化后的命令 */
  normalizedCommand?: string;
  /** 是否匹配了 hardline 模式 */
  hardlineBlocked: boolean;
  /** 是否匹配了 dangerous 模式 */
  dangerousMatched: boolean;
  /** dangerous 模式的原因 */
  dangerousReason?: string;
}

/**
 * 统一命令守卫入口 — 组合 Hardline + Dangerous 检测。
 *
 * 借鉴 hermes-agent tools/approval.py check_all_command_guards：
 *   1. 先检查 Hardline（无条件阻止）
 *   2. 再检查 Dangerous（需批准）
 *   3. 都不匹配则允许
 *
 * @param command 原始命令
 * @param yoloMode 是否为 yolo 模式（自动批准 dangerous 命令）
 */
export function checkAllCommandGuards(
  command: string,
  yoloMode: boolean = false,
): CommandGuardResult {
  const normalized = normalizeCommand(command);
  const normalizedLower = normalized.toLowerCase();

  // 1. Hardline 检查（无条件阻止）
  const hardline = checkHardlineNormalized(normalizedLower);
  if (hardline.blocked) {
    return {
      action: "block",
      reason: hardline.reason,
      normalizedCommand: hardline.normalizedCommand,
      hardlineBlocked: true,
      dangerousMatched: false,
    };
  }

  // 2. Dangerous 检查
  const dangerous = checkDangerousNormalized(normalizedLower);
  if (dangerous.needsApproval) {
    // yolo 模式自动批准，否则需要人工批准
    return {
      action: yoloMode ? "allow" : "approve",
      reason: dangerous.reason,
      normalizedCommand: dangerous.normalizedCommand,
      hardlineBlocked: false,
      dangerousMatched: true,
      dangerousReason: dangerous.reason,
    };
  }

  // 3. 默认允许
  return {
    action: "allow",
    normalizedCommand: normalized,
    hardlineBlocked: false,
    dangerousMatched: false,
  };
}

// ── Environment Variable Denylist ─────────────────────────

/**
 * 环境变量写入黑名单：LLM provider 凭据 + RCE 向量。
 *
 * 借鉴 hermes-agent _HERMES_PROVIDER_ENV_BLOCKLIST + GHSA-rhgp-j443-p4rf。
 *
 * 这些变量绝不应通过 skill 声明的 required_environment_variables
 * 或 config.yaml 的 env_passthrough 注入子进程——
 * 否则会绕过沙箱凭据擦除或实现 RCE。
 */
export const ENV_VAR_NAME_DENYLIST: ReadonlySet<string> = new Set([
  // ── LLM Provider 凭据（绝不能注入子进程） ──
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
  "COHERE_API_KEY",
  "FIREWORKS_API_KEY",
  "XAI_API_KEY",
  "HELICONE_API_KEY",
  "PARALLEL_API_KEY",
  "FIRECRAWL_API_KEY",
  "FIRECRAWL_API_URL",
  "LLM_MODEL",

  // ── RCE 向量（绝不能由 skill/config 注入） ──
  "LD_PRELOAD",        // 动态链接器劫持 — 任意 .so 注入
  "LD_LIBRARY_PATH",   // 动态链接器搜索路径劫持
  "LD_AUDIT",          // 审计库注入
  "LD_BIND_NOW",       // （非 RCE 但影响链接器行为，保守阻止）
  "DYLD_INSERT_LIBRARIES", // macOS 等价物
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "PYTHONPATH",        // Python 模块搜索路径劫持
  "PYTHONSTARTUP",     // Python 启动时执行任意文件
  "PYTHONHOME",        // Python 解释器根目录劫持
  "NODE_PATH",         // Node.js 模块搜索路径劫持
  "NODE_OPTIONS",      // Node.js 启动参数注入（--require 等）
  "RUBYLIB",           // Ruby 模块搜索路径劫持
  "RUBYOPT",           // Ruby 启动参数注入
  "PERL5LIB",          // Perl 模块搜索路径劫持
  "PERL5OPT",          // Perl 启动参数注入
  "PERLLIB",
  "JAVA_TOOL_OPTIONS", // JVM 启动参数注入（-agentlib 等）
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",

  // ── Shell/编辑器劫持 ──
  "PATH",              // 修改 PATH 可劫持任意命令
  "SHELL",             // 修改默认 shell
  "BASH_ENV",          // bash 非交互启动时执行的脚本
  "ENV",               // POSIX sh 启动时执行的文件
  "ZDOTDIR",           // zsh 配置目录劫持
  "EDITOR",            // 编辑器劫持（visudo、crontab -e 等会调用）
  "VISUAL",            // 同上
  "GIT_EDITOR",        // git 调用的编辑器
  "GIT_SSH_COMMAND",   // git 调用的 SSH 命令（可注入任意命令）
  "GIT_SSH",
  "PROMPT_COMMAND",    // bash 每次提示前执行的命令
  "TERM",              // 非安全向量但影响终端行为，保守阻止

  // ── Hermes/EvoClaw 内部状态（绝不能由子进程修改） ──
  "HERMES_HOME",
  "EVOCLAW_HOME",
  "HERMES_SESSION_KEY",
  "EVOCLAW_SESSION_KEY",
  "HERMES_GATEWAY_SESSION",
  "HERMES_YOLO_MODE",  // 冻结于导入时，运行时修改是注入攻击
  "EVOCLAW_YOLO_MODE",
]);

/**
 * 检查环境变量名是否在写入黑名单中。
 *
 * @returns true 表示该变量不应由 skill/config 注入子进程
 */
export function isEnvVarDenied(varName: string): boolean {
  return ENV_VAR_NAME_DENYLIST.has(varName);
}

/**
 * 过滤环境变量字典，移除黑名单中的项。
 *
 * @returns 过滤后的新字典（不修改输入）
 */
export function filterDeniedEnvVars(
  env: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_VAR_NAME_DENYLIST.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

// ── Invisible Unicode Characters ──────────────────────────

/**
 * 不可见/双向 Unicode 字符集合（注入攻击常用）。
 *
 * 端口自 hermes-agent tools/threat_patterns.py INVISIBLE_CHARS。
 * 包括：零宽空格、零宽连接符、双向控制字符、BOM 等。
 */
export const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
  "\u200b", // 零宽空格
  "\u200c", // 零宽非连接符
  "\u200d", // 零宽连接符
  "\u2060", // 词连接符
  "\u2062", // 不可见乘号
  "\u2063", // 不可见分隔符
  "\u2064", // 不可见加号
  "\ufeff", // 零宽不换行空格（BOM）
  "\u202a", // 从左到右嵌入
  "\u202b", // 从右到左嵌入
  "\u202c", // 弹出方向格式化
  "\u202d", // 从左到右覆盖
  "\u202e", // 从右到左覆盖
  "\u2066", // 从左到右隔离
  "\u2067", // 从右到左隔离
  "\u2068", // 第一个强字符隔离
  "\u2069", // 弹出方向隔离
]);

/**
 * 检测文本中是否包含不可见 Unicode 字符。
 *
 * @returns 命中的码点列表（如 ["U+200B", "U+202E"]），空数组表示无命中
 */
export function detectInvisibleChars(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const ch of text) {
    if (INVISIBLE_CHARS.has(ch) && !seen.has(ch)) {
      seen.add(ch);
      hits.push(`U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
  return hits;
}

// ── R2-3: 破坏性命令检测（借鉴 hermes-agent _is_destructive_command） ──

/**
 * 破坏性命令模式。
 *
 * 借鉴 hermes-agent agent/tool_executor.py 的 _is_destructive_command：
 *   匹配会导致数据丢失或系统不可逆变更的命令。
 *   这类命令在执行前应自动 checkpoint 快照工作目录。
 */
const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  // 文件删除
  /\brm\s+-rf?\b/i,
  /\brmdir\s+\/s\b/i,           // Windows
  /\bdel\s+\/[sfq]/i,           // Windows del
  // Git 破坏性操作
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[fd]/i,
  /\bgit\s+push\s+(?:-f|--force)/i,
  // 磁盘/文件系统
  /\bmkfs\b/i,
  /\bdd\s+.*of=\/dev\//i,
  /\bfdisk\b/i,
  /\bformat\s+[a-z]:/i,         // Windows format
  // 系统操作
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  // 权限/所有权
  /\bchmod\s+-R\s+0?777\b/i,
  /\bchown\s+-R\b/i,
  // 进程
  /\bkillall\b/i,
  /\bpkill\s+-9\b/i,
  // fork bomb
  /:\(\)\{.*:|:&\};:/,
];

/**
 * 检测命令是否为破坏性命令。
 *
 * 借鉴 hermes-agent _is_destructive_command：
 *   返回 true 时应在执行前自动 checkpoint 工作目录，
 *   以便用户可以回滚。
 *
 * @param command 待检测的命令字符串
 * @returns true 表示该命令是破坏性的
 */
export function isDestructiveCommand(command: string): boolean {
  if (!command) return false;
  // 归一化后再匹配（防止 ANSI/Unicode 绕过）
  const normalized = normalizeCommand(command).toLowerCase();
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(normalized);
  });
}
