/**
 * Shell 命令风险分级（Shell Command Risk Classification）
 *
 * 背景：系统提示词明确鼓励模型生成并执行 Python 脚本，因此 `shell_exec`
 * 不能整体改为"需审批"——那会打断几乎所有自动化任务。
 * 但也不能对所有命令都免审批：`rm -rf /`、`mkfs`、`dd` 写盘等命令一旦被
 * 提示注入或模型误判，后果不可逆。
 *
 * 策略：把命令分成三档，并区分「可审批」与「必须硬拦」：
 *   - `safe`     常规命令，直接执行（保持现有自动化能力）
 *   - `caution`  有副作用但可恢复（如 rm -rf 相对路径、pip install），放行但标记
 *   - `critical` 不可逆 / 系统级破坏 → **必须人工审批**，审批通过后才执行
 *   - `blocked`  命令注入特征（换行注入、反引号替换）→ 硬拦，不接受审批
 *
 * 「硬拦」与「需审批」必须分开：注入特征是攻击信号，不该给用户一个
 * "点同意就放行" 的机会；而 `rm -rf /` 是用户可能真的需要的高危操作，
 * 应该让用户知情后决策。
 *
 * 另有「硬线地板」（hermes alignment round4）：归一化后命中
 * command-guard 的无条件阻止模式时，任何安全等级都硬拦，不接受审批。
 */

import { checkHardline, normalizeCommand } from "./command-guard";

export type ShellRiskLevel = "safe" | "caution" | "critical" | "blocked";

export interface ShellRiskAssessment {
  level: ShellRiskLevel;
  /** 人类可读的原因，用于审批界面与工具返回 */
  reason?: string;
  /** 命中的规则标识，便于诊断与测试 */
  rule?: string;
  /**
   * 硬线地板命中原因（hermes approval_floors 语义）。
   * 命中时 `decideShellCommand` 在任何安全等级下都返回 block。
   * 与 `rule` 分开，避免污染既有分级规则 ID 的断言与日志。
   */
  hardlineReason?: string;
}

/**
 * 命令注入特征 —— 命中即硬拦，不接受人工审批。
 * 这些是攻击信号而非合法的高危操作。
 */
const INJECTION_RULES: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: "newline_injection", re: /\r|\n/, reason: "命令包含换行符，存在命令注入风险" },
  { id: "backtick_substitution", re: /`[^`]*`/, reason: "命令包含反引号命令替换，存在注入风险" },
  { id: "command_substitution", re: /\$\([^)]*\)|\$\{[^}]*\}/, reason: "命令包含命令替换语法，存在注入风险" },
];

/**
 * 不可逆 / 系统级破坏 —— 需人工审批。
 * 覆盖：磁盘级格式化、引导分区写入、系统关机重启、家目录/根目录递归删除、
 * 权限体系篡改、远程脚本直接执行、进程/服务强杀。
 */
const CRITICAL_RULES: Array<{ id: string; re: RegExp; reason: string }> = [
  // ── 磁盘与文件系统（不可逆）──
  { id: "fs_format", re: /\bmkfs(\.\w+)?\b|\bfdisk\b|\bformat\s+[a-z]:/i, reason: "格式化磁盘（数据不可恢复）" },
  { id: "raw_disk_write", re: /\bdd\s+[^\n]*of=\/dev\/|\bdd\s+[^\n]*of=[a-z]:/i, reason: "直接向磁盘设备写入（数据不可恢复）" },
  { id: "overwrite_disk_device", re: />\s*\/dev\/(sd|nvme|hd|vd)[a-z0-9]*/i, reason: "覆写磁盘设备文件" },
  // ── 根目录 / 主目录 / 整盘递归删除 ──
  { id: "rm_rf_root", re: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+\/(\s|$)/, reason: "递归强制删除根目录" },
  { id: "rm_rf_home", re: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+(~|\$HOME)(\s|\/|$)/, reason: "递归强制删除用户主目录" },
  { id: "rm_rf_windows_root", re: /\brmdir\s+\/[sS]\s+\/[qQ]\s+[a-z]:\\?|\bdel\s+\/[sS]\s+\/[qQ]\s+[a-z]:\\?/i, reason: "递归强制删除整盘" },
  { id: "rm_rf_no_preserve", re: /--no-preserve-root/, reason: "使用 --no-preserve-root 删除受保护目录" },
  { id: "powershell_recursive_delete", re: /\b(Remove-Item|rd)\b[^\n]*-[rR][^\n]*-[fF]/, reason: "PowerShell 递归强制删除" },
  // ── 关机 / 重启 / 进程与服务强杀 ──
  { id: "power_state", re: /\b(shutdown|reboot|halt|poweroff)\b|\bStop-Computer\b/i, reason: "关机或重启系统" },
  { id: "kill_service", re: /\b(Stop-Process|Stop-Service|taskkill|killall|pkill)\b/i, reason: "强杀进程或服务" },
  // ── 权限体系与注册表 ──
  { id: "chmod_root", re: /\bchmod\s+(777|-R\s+777)\s+\//i, reason: "修改根目录权限位" },
  { id: "chown_root", re: /\bchown\s+(-R\s+)?(\S+\s+)+\/(\s|$)/i, reason: "递归修改根目录属主" },
  { id: "registry_delete", re: /\breg\s+delete\b|\bregedit\b/i, reason: "删除注册表项" },
  { id: "execution_policy", re: /\bSet-ExecutionPolicy\b|\bInvoke-Expression\b|\biex\b/i, reason: "修改执行策略或动态执行代码" },
  // ── 远程脚本直接执行 ──
  { id: "remote_pipe_exec", re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*[|;&]\s*(sudo\s+)?(sh|bash|zsh|python|powershell|cmd|iex)\b/i, reason: "下载并直接执行远程脚本" },
  // ── 资源耗尽 ──
  { id: "fork_bomb", re: /:\(\)\s*\{.*\|.*&.*\}\s*;\s*:|fork\s*bomb/i, reason: "fork 炸弹（耗尽系统资源）" },
];

/**
 * 有副作用但可恢复 —— 放行并标记，不阻断自动化。
 * 仅用于让调用方/日志知道这条命令不是纯只读。
 */
const CAUTION_RULES: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: "recursive_delete_relative", re: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*/, reason: "递归删除（相对路径）" },
  { id: "package_install", re: /\b(npm|pnpm|yarn|pip|pip3|gem|composer)\s+(install|add|i)\b/i, reason: "安装依赖包" },
  { id: "git_destructive", re: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s)/i, reason: "Git 破坏性或远程操作" },
  { id: "git_force_push", re: /\bgit\s+push\b[^\n]*(--force|-f)\b/i, reason: "强制推送" },
  { id: "permission_change", re: /\bchmod\b|\bchown\b|\bicacls\b/i, reason: "修改权限" },
  { id: "process_signal", re: /\bkill\s+-\d|\bkillall\b|\btaskkill\b/i, reason: "发送信号终止进程" },
];

/**
 * 检测命令中的换行是否"安全"（位于 heredoc 或引号内）。
 * 安全换行是数据传递，不是命令注入——模型大量使用 `python3 <<'EOF' ... EOF`
 * 或 `python3 -c "多行\n脚本"` 传数据，这些应放行。
 * 只有引号/heredoc **之外**的换行才可能是命令注入（`echo foo\nrm -rf /`）。
 *
 * 仅剥离带引号的 heredoc 定界符（<<'EOF' / <<"EOF"），未引号定界符
 * （<<EOF）仍会被 shell 展开，其中的命令替换应保留检查。
 */
/** 剥离带引号 heredoc 的正文，只留下 shell 可见的命令文本（正文是数据）。 */
function stripQuotedHeredocBodies(command: string): string {
  return command.replace(/<<['"](\w+)['"][\r\n]([\s\S]*?)[\r\n]\1/g, " <<HEREDOC>");
}

function hasOnlySafeNewlines(command: string): boolean {
  const stripped = stripQuotedHeredocBodies(command);
  // 追踪引号状态：引号内的换行是安全的
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "\\" && (inSingle || inDouble)) {
      i++; // 跳过转义字符
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inSingle && !inDouble) {
      return false; // 不安全换行（引号外）
    }
  }
  return true;
}

/** 对单条命令做风险分级。永不抛出。 */
export function assessShellCommand(command: string): ShellRiskAssessment {
  if (typeof command !== "string" || command.trim() === "") {
    return { level: "blocked", reason: "命令为空", rule: "empty_command" };
  }
  const cmd = command;
  // hermes alignment round4：规则匹配用归一化后的命令，防止 ANSI/null/fullwidth/
  // 反斜杠/空字符串字面量混淆（此前 command-guard.ts 的 normalizeCommand 零调用点）。
  // 注入换行判定仍用原文——它依赖引号/heredoc 状态机，归一化会破坏该语义。
  const normalized = normalizeCommand(cmd);

  // 硬线地板（hermes approval_floors 语义）：在「归一化 + 剥离引号 heredoc
  // 正文」后的 shell 可见文本上判定。正文里的 `os.system('rm -rf /')` 是
  // 传给程序的数据，不能误杀（2026-11-02 既有设计）；而命令前缀本身若含
  // hardline 仍会被拦。结果作为附加字段并入分级返回，不改写既有 rule/level，
  // 由 decideShellCommand 在任何安全等级下优先硬拦。
  const shellVisible = normalizeCommand(stripQuotedHeredocBodies(cmd));
  const hardline = checkHardline(shellVisible);
  const hardlineReason = hardline.blocked ? hardline.reason : undefined;
  const floor = hardlineReason ? { hardlineReason } : {};

  // 1. 注入特征优先：攻击信号不接受审批（原文判定，保留 heredoc 语义；
  //    反引号/替换规则同时查归一化文本，防反斜杠混淆绕过）
  for (const rule of INJECTION_RULES) {
    if (rule.id === "newline_injection") {
      // ★ 2026-11-02 修复：仅拦截引号/heredoc 之外的换行
      // 旧规则拦截所有换行，误杀 heredoc（python3 <<'EOF' ... EOF）和
      // 引号内多行字符串（python3 -c "行1\n行2"），模型被迫改用
      // file_write+execute_code 绕行，浪费轮次与 token。
      if (!hasOnlySafeNewlines(cmd)) {
        return { level: "blocked", reason: rule.reason, rule: rule.id, ...floor };
      }
    } else if (rule.re.test(cmd) || rule.re.test(normalized)) {
      return { level: "blocked", reason: rule.reason, rule: rule.id, ...floor };
    }
  }

  // 2. 不可逆破坏 → 需人工审批（归一化后匹配）
  for (const rule of CRITICAL_RULES) {
    if (rule.re.test(normalized)) {
      return { level: "critical", reason: rule.reason, rule: rule.id, ...floor };
    }
  }

  // 3. 有副作用但可恢复 → 放行并标记（归一化后匹配）
  for (const rule of CAUTION_RULES) {
    if (rule.re.test(normalized)) {
      return { level: "caution", reason: rule.reason, rule: rule.id, ...floor };
    }
  }

  // 4. 分级器完全没命中、但硬线地板命中（rm -rf /etc、kill -1 等）：
  //    至少升为 critical，绝不作为 safe 放行。
  if (hardlineReason) {
    return {
      level: "critical",
      reason: `硬线阻止：${hardlineReason}`,
      hardlineReason,
    };
  }

  return { level: "safe" };
}

/** 是否需要人工审批（与 permission-manager 的 requireExplicitConsent 对接） */
export function requiresApprovalForShellCommand(assessment: ShellRiskAssessment): boolean {
  return assessment.level === "critical";
}

/** 命令注入类规则 ID（任何安全等级都硬拦，调低等级无法放开） */
const INJECTION_RULE_IDS = new Set(INJECTION_RULES.map((r) => r.id));

/**
 * 硬拦命令的可执行恢复指引（拼在 shell_exec 的 blocked 错误之后）。
 *
 * 关键不变式：注入类（换行 / 反引号 / $() 替换）在**任何**安全等级下都硬拦，
 * 所以绝不能对它们提示「调低安全等级可放开」——那会误导模型反复重试内联命令
 * 或直接把「被拦截」误判成「沙箱环境不可用」而放弃（v12 压测 Task 2 实证：
 * 模型反复用 $(...) 内联命令被 command_substitution 拦，最终 0 交付）。
 * 改为给出真正可用的路径：写脚本文件再执行，或改用 execute_code。
 * 硬线地板（删根/写盘/fork bomb 等）则明确「无法放开」，不提供绕过指引。
 */
export function shellBlockGuidance(assessment: ShellRiskAssessment): string {
  if (INJECTION_RULE_IDS.has(assessment.rule ?? "")) {
    return " 命令注入特征（换行 / 反引号 / $() 命令替换）在任何安全等级下都会硬拦，" +
      "调低「总体安全」等级无法放开，请勿反复重试内联命令。" +
      "改用可执行路径：把命令写成脚本文件（用 file_write 生成 .sh/.py/.js）后" +
      "再用 shell_exec 只执行该文件；或直接改用 execute_code 工具（沙箱内支持多行代码与命令替换）。";
  }
  if (assessment.hardlineReason) {
    return " 该命令命中无条件高危模式（如删根 / 写盘 / fork bomb 等），任何安全等级都不会执行，也无法通过审批放开。";
  }
  return "如需放开，请到「安全 → 总体安全」调整等级。";
}

/** 给审批界面/工具返回用的中文说明 */
export function describeShellRisk(assessment: ShellRiskAssessment): string {
  switch (assessment.level) {
    case "critical":
      return `⚠️ 高危命令，需要人工确认后才能执行：${assessment.reason ?? "该命令可能造成不可逆破坏"}`;
    case "blocked":
      return `🚫 命令已被安全策略拦截：${assessment.reason ?? "命令存在注入风险"}`;
    case "caution":
      return `注意：${assessment.reason ?? "该命令有副作用"}`;
    default:
      return "";
  }
}
