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
 *   - `blocked`  空命令（无法判定）
 *
 * 「硬拦」与「需审批」必须分开：硬线模式是攻击信号，不该给用户一个
 * "点同意就放行" 的机会；而 `rm -rf /` 是用户可能真的需要的高危操作，
 * 应该让用户知情后决策。
 *
 * 另有「硬线地板」（hermes alignment round4）：归一化后命中
 * command-guard 的无条件阻止模式时，任何安全等级都硬拦，不接受审批。
 *
 * ★ hermes 对齐（2026-11-26）：不再把「换行」「`$(...)`」「反引号」这些**裸语法特征**
 *   当成注入硬拦（对齐 hermes tools/approval_detection.py）：
 *   - 换行是 shell 语法（多行脚本），危险与否取决于它分隔出来的命令本身；
 *   - `$(...)` / 反引号的正文**会被执行**，所以把正文当作独立命令再扫一遍规则表——
 *     `$(stat -c%s f)` 放行，`$(rm -rf /)` 照样命中硬线；
 *   - `${VAR}` 只是参数展开、不执行命令，不再参与判定。
 *   旧实现按裸特征整条硬拦，实测把 `python3 -c "多行脚本"`、heredoc + 收尾命令、
 *   `for` 循环里的 `$(wc -c < "$f")` 全部误杀（v32/v33 压测 5 次，每次白烧一轮）。
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
 *
 * ★ hermes 对齐（2026-11-26）：这张表已清空。裸语法特征（换行、反引号、`$(...)`、
 *   `${...}`）不再作为硬拦理由——见文件头注释。安全不靠「语法长得可疑」，
 *   而靠规则表与硬线地板对**实际会执行的内容**判定：
 *     - 换行分隔出的命令照常进规则表，`ls\nrm -rf /` 仍被硬线地板拦住；
 *     - `$(...)` / 反引号的正文本来就在命令文本里，`$(rm -rf /)` 仍命中 rm_rf_root；
 *       `$(stat -c%s f)`、`$(wc -c < "$f")` 这类正常展开不再被误杀。
 *   保留这个空表是为了让 `blocked` 语义（"不可审批的硬拦"）与 guidance 分支不散架。
 */
const INJECTION_RULES: Array<{ id: string; re: RegExp; reason: string }> = [];

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

/**
 * 引号感知掩码：把「引号内的数据」替换为空格，只留下 shell 真正会执行的内容。
 *
 * 对齐 hermes tools/approval_quoted_newlines.py `_mask_quoted_newlines` 的判定模型：
 * 引号内的换行、`rm -rf /` 之类的**文本**是数据，不该触发命令规则；但引号内的
 * `$(...)` / 反引号正文会被 shell **执行**，所以它的正文按代码区重新扫描（引号
 * 状态重置），`$(rm -rf /)` 照样命中，`$(stat -c%s f)` 放行。
 *
 * 单引号内没有转义也没有展开 → 全部是数据。
 * 双引号内除 `$(...)` / 反引号外都是数据（含换行，掩成空格）。
 */
function maskQuotedData(command: string): string {
  type Frame = { kind: "single" | "double" | "paren" | "tick"; depth: number };
  const out: string[] = [];
  const stack: Frame[] = [];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    const frame = top();
    const inData = frame?.kind === "single" || frame?.kind === "double";

    if (inData) {
      if (frame.kind === "double") {
        if (ch === "\\" && i + 1 < command.length) {
          out.push(" ", " ");
          i += 2;
          continue;
        }
        if (ch === "$" && command[i + 1] === "(") {
          stack.push({ kind: "paren", depth: 0 });
          out.push("$", "(");
          i += 2;
          continue;
        }
        if (ch === "`") {
          stack.push({ kind: "tick", depth: 0 });
          out.push("`");
          i++;
          continue;
        }
        if (ch === '"') {
          stack.pop();
          out.push('"');
          i++;
          continue;
        }
        out.push(" "); // 双引号内的一切（含换行）都是数据
        i++;
        continue;
      }
      if (ch === "'") {
        stack.pop();
        out.push("'");
        i++;
        continue;
      }
      out.push(" ");
      i++;
      continue;
    }

    // ── 代码区（顶层，或 `$(...)` / 反引号的正文）──
    if (ch === "\\" && i + 1 < command.length) {
      out.push(ch, command[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "'") {
      stack.push({ kind: "single", depth: 0 });
      out.push("'");
      i++;
      continue;
    }
    if (ch === '"') {
      stack.push({ kind: "double", depth: 0 });
      out.push('"');
      i++;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      stack.push({ kind: "paren", depth: 0 });
      out.push("$", "(");
      i += 2;
      continue;
    }
    if (ch === "`") {
      if (frame?.kind === "tick" && frame.depth === 0) {
        stack.pop();
      } else {
        stack.push({ kind: "tick", depth: 0 });
      }
      out.push("`");
      i++;
      continue;
    }
    if (frame?.kind === "paren") {
      if (ch === "(") frame.depth++;
      else if (ch === ")" && frame.depth > 0) frame.depth--;
      else if (ch === ")" && frame.depth === 0) {
        stack.pop();
        out.push(")");
        i++;
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/**
 * 引号内的载荷交给另一个 shell **执行**的命令（sh -c / eval / source …）。
 * 这种引号不是数据边界，掩码会把真正的命令藏起来，因此整条命令按原文检测。
 */
const SHELL_CARRIER_RE =
  /\b(?:eval|source)\b|\b(?:sh|bash|zsh|ksh|dash)\b[^\n]*?\s-[A-Za-z]*c\b/;

/**
 * 去掉「纯路径参数」外层的引号：`rm -rf "/home"` → `rm -rf /home`。
 *
 * 对齐 hermes `_hardline_rm_path` 的 `(?:["'](?:path)["']|...)` 分支——引号包裹的
 * **路径操作数**仍是真实目标，不是数据。只对「整段引号内不含空白、且以路径字符开头」
 * 的片段去引号，所以 `echo "rm -rf / is bad"` 这类散文仍是数据（含空格 → 不动）。
 */
function unquotePathWords(command: string): string {
  return command.replace(
    /(["'])((?:~|\$HOME|\$[A-Za-z_][A-Za-z0-9_]*|\/|[A-Za-z]:)[^"'\s]*)\1/g,
    (_m, _q: string, body: string) => body
  );
}

/** 供规则匹配的「shell 实际执行内容」：去路径引号 + 引号数据掩码 + 引号 heredoc 正文剥离。 */
function shellVisibleText(command: string): string {
  const heredocStripped = stripQuotedHeredocBodies(command);
  if (SHELL_CARRIER_RE.test(heredocStripped)) return heredocStripped;
  return maskQuotedData(unquotePathWords(heredocStripped));
}

/** 对单条命令做风险分级。永不抛出。 */
export function assessShellCommand(command: string): ShellRiskAssessment {
  if (typeof command !== "string" || command.trim() === "") {
    return { level: "blocked", reason: "命令为空", rule: "empty_command" };
  }
  const cmd = command;
  // ★ hermes 对齐（2026-11-26）：判定对象是「shell 实际会执行的内容」——
  //   引号内的数据掩码、引号 heredoc 正文剥离；换行/`$()`/反引号本身不再是
  //   拦截理由，危险与否取决于它们分隔/包裹出来的命令。见文件头注释。
  //   归一化（ANSI/null/fullwidth/反斜杠/空字面量）在掩码之后进行，
  //   防止混淆绕过（hermes alignment round4）。
  const visible = shellVisibleText(cmd);
  const normalized = normalizeCommand(visible);

  // 硬线地板（hermes approval_floors 语义）：任何安全等级都硬拦，不接受审批。
  // _CMDPOS 把行首、`;`、`&`、`|`、换行、`$(`、反引号都当作命令起始位置，
  // 所以 `ls\nrm -rf /`、`$(rm -rf /)` 依然命中，而引号里的同名文本是数据。
  const hardline = checkHardline(normalized);
  const hardlineReason = hardline.blocked ? hardline.reason : undefined;
  const floor = hardlineReason ? { hardlineReason } : {};

  // 1. 空命令已在上方拦截；INJECTION_RULES 保留为空表（语义占位）。
  for (const rule of INJECTION_RULES) {
    if (rule.re.test(cmd) || rule.re.test(normalized)) {
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

/**
 * 硬拦命令的可执行恢复指引（拼在 shell_exec 的 blocked 错误之后）。
 *
 * 关键不变式：硬线地板（删根 / 写盘 / fork bomb / 关机…）在**任何**安全等级下都硬拦，
 * 所以绝不能提示「调低安全等级可放开」——那会误导模型反复重试，或直接把
 * 「被拦截」误判成「沙箱环境不可用」而放弃（v12 压测 Task 2 实证：模型反复
 * 内联命令被拦，最终 0 交付）。改为给出真正可用的路径：写脚本文件再执行，
 * 或改用 execute_code。
 *
 * ★ hermes 对齐（2026-11-26）：换行 / `$()` / 反引号不再硬拦（见文件头注释），
 *   所以「改用脚本文件 / execute_code」的旧话术只对真正的硬线命令保留。
 */
export function shellBlockGuidance(assessment: ShellRiskAssessment): string {
  if (assessment.hardlineReason) {
    return " 该命令命中无条件高危模式（如删根 / 写盘 / fork bomb / 关机等），任何安全等级都不会执行，也无法通过审批放开。" +
      " 若确实需要，请把操作拆成只读的核查步骤，危险动作交由用户手工执行。";
  }
  if (assessment.level === "blocked") {
    return " 该命令被安全策略硬拦，不接受审批。请改用 file_write 写脚本文件后用 shell_exec 只执行该文件，或改用 execute_code。";
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
