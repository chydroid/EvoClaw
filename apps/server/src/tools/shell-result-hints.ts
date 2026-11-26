/**
 * shell_exec 结果注解：退出码语义 + 失败恢复提示 + 掩盖成功告警。
 *
 * 对标 hermes-agent `tools/terminal_tool_result.py`（`_interpret_exit_code` /
 * `_interpret_signal_exit` / `_EXIT_CODE_SEMANTICS`）与 `tools/terminal_hints.py`
 * （`annotate_failure` / `annotate_masked_success`）。
 *
 * 为什么需要：EvoClaw 的 shell_exec 此前只回 `exitCode` 数字。模型看到
 * `grep` 返回 1、`diff` 返回 1、`test` 返回 1 时会当成真失败，白白多跑一轮
 * 调查；看到 `137` 不知道是 OOM；看到 `command not found` 反复重试同一条
 * 命令。hermes 用一张「非零但正常」的语义表 + 一组按出现频率排序的输出模式
 * 提示把这一类浪费全部消掉。
 *
 * ★ 两层概念必须分开（EvoClaw 特有，hermes 没有 success 概念故不需要）：
 *   - `exit_code_meaning`：**给模型看的语义说明**，宽——`git` 的 1、`curl` 的
 *     7 都值得解释（「常常正常」「连不上主机」）。
 *   - `non_error_exit`：**给失败记账用的豁免**，窄——只有 grep/diff/test 这类
 *     「退出码就是答案」的才豁免。`curl` 连不上仍是失败，不能豁免，否则失败链
 *     与自动续跑都不触发。见 `NON_ERROR_EXITS`。
 *
 * 纪律：
 *   - **纯函数**，无 IO、无配置读取；
 *   - **绝不改写退出码**——只追加 `exit_code_meaning` / `hint` /
 *     `non_error_exit` 三个可选字段；
 *   - 失败提示只看前 4000 字符（错误头在开头），首个匹配即返回；
 *   - 退出码 0 时只可能给「掩盖成功」告警，且必须同时满足
 *     「掩盖形态」+「强失败特征」+「非只读命令头」三个条件（保守）。
 */

/** 扫描窗口：错误头在输出开头，深部上下文不算。 */
const SCAN_CHARS = 4000;

// ─────────────────────────── 信号终止 ───────────────────────────

/**
 * 信号 → 说明。同时覆盖两种编码：
 *   - 负数（subprocess 语义，确定是信号终止）
 *   - 128+signum（shell 约定，程序也可能自己 `exit 139`，故措辞留余地）
 * 130/SIGINT 故意缺席：executor 的中断标记路径自己处理它。
 */
const SIGNAL_EXIT_NOTES: Record<number, string> = {
  3: "SIGQUIT（键盘 quit）",
  4: "SIGILL（非法指令——二进制损坏或架构不匹配）",
  6: "SIGABRT（abort——断言失败、运行时致命错误或 glibc abort）",
  7: "SIGBUS（总线错误——越界/未映射内存访问）",
  8: "SIGFPE（致命算术错误，如整数除零）",
  9: "SIGKILL——常见于内核 OOM killer 内存耗尽，或显式 kill -9",
  11: "SIGSEGV（段错误——程序崩溃）",
  13: "SIGPIPE（写入已关闭的管道——如输出管道对端已退出）",
  15: "SIGTERM（被终止——kill/超时或关闭请求）",
  24: "SIGXCPU（CPU 时间上限超限）",
  25: "SIGXFSZ（文件大小上限超限）",
};

/** 信号终止说明；非信号退出返回 null。 */
export function interpretSignalExit(exitCode: number): string | null {
  if (!Number.isFinite(exitCode)) return null;
  if (exitCode < 0) {
    // ★ -1 在本代码库是「退出码不可得」哨兵（`closeInfo.code ?? -1`），不是
    //   SIGHUP。若照 -signum 解读会凭空断言「被信号 1 终止」——给模型注入
    //   一条假事实。真被 SIGHUP 杀掉时也只能看到 -1，宁可不说也不要说错。
    if (exitCode === -1) return null;
    const signum = -exitCode;
    if (signum === 2) return null; // SIGINT 由中断标记路径负责
    const note = SIGNAL_EXIT_NOTES[signum];
    return note
      ? `命令被信号 ${signum} 终止：${note}`
      : `命令被信号 ${signum} 终止`;
  }
  if (exitCode > 128) {
    const note = SIGNAL_EXIT_NOTES[exitCode - 128];
    if (note) {
      return `退出码 ${exitCode} 通常表示命令被信号 ${exitCode - 128} 终止：${note}`;
    }
  }
  return null;
}

// ─────────────────────── 按命令的「非零但正常」 ───────────────────────

/** 非零退出码在某些命令上是信息性的，不是错误。 */
const EXIT_CODE_SEMANTICS: Record<string, Record<number, string>> = {
  grep: { 1: "没有匹配（不是错误）" },
  egrep: { 1: "没有匹配（不是错误）" },
  fgrep: { 1: "没有匹配（不是错误）" },
  rg: { 1: "没有匹配（不是错误）" },
  ag: { 1: "没有匹配（不是错误）" },
  ack: { 1: "没有匹配（不是错误）" },
  diff: { 1: "文件有差异（预期结果，不是错误）" },
  colordiff: { 1: "文件有差异（预期结果，不是错误）" },
  test: { 1: "条件为假（预期结果，不是错误）" },
  "[": { 1: "条件为假（预期结果，不是错误）" },
  find: { 1: "部分目录不可访问（结果可能仍有效）" },
  curl: {
    6: "无法解析主机名",
    7: "无法连接主机",
    22: "HTTP 响应码表示错误（如 404、500）",
    28: "操作超时",
  },
  git: { 1: "非零退出（常常正常——如 'git diff' 有差异时返回 1）" },
};

/** 取最后一段命令的首个「非 VAR=val」词作为 base command。 */
function baseCommandOf(command: string): string {
  const segments = String(command || "").split(/\s*(?:\|\||&&|[|;])\s*/);
  const last = (segments[segments.length - 1] || "").trim();
  for (const word of last.split(/\s+/)) {
    if (!word) continue;
    // 跳过 VAR=val 赋值（但 `-x` 这类参数不是赋值）
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return word.replace(/\\/g, "/").split("/").pop() || "";
  }
  return "";
}

/**
 * 「该退出码**确定不是错误**」的命令表——注意与 `EXIT_CODE_SEMANTICS` **不同**：
 * 后者只是给模型看的语义说明，其中混着「常常正常」与「确实是失败」两类
 * （`git` 的 1 常常正常、`curl` 的 7 就是连不上、`find` 的 1 是权限问题）。
 * 只有前者可以豁免失败记账，后者绝不可以——否则 `curl` 连不上会被当成
 * 「非错误退出」，失败链与自动续跑都不会触发。
 *
 * hermes 的 terminal 结果只有 exit_code + exit_code_meaning，没有 success
 * 概念，所以不存在这个区分；EvoClaw 的 `non_error_exit` 是桥接既有失败记账
 * 的新概念，边界必须自己钉死。
 */
const NON_ERROR_EXITS: Record<string, readonly number[]> = {
  grep: [1],
  egrep: [1],
  fgrep: [1],
  rg: [1],
  ag: [1],
  ack: [1],
  diff: [1],
  colordiff: [1],
  test: [1],
  "[": [1],
};

/**
 * 该退出码是否**确定不是命令失败**（grep/diff/test 的 1 = 没匹配/有差异/条件为假）。
 * 信号终止（137/139）与 curl/git/find 的码**不在此列**。
 *
 * 调用方据此给结果加 `non_error_exit: true`，让失败分类器（extractToolFailure）
 * 不把它计进 failedTools——否则 `grep -c foo f`（无匹配=1）会被当成失败工具，
 * 触发无谓的自动续跑与「本轮失败工具」措辞。
 */
export function isInformationalExit(command: string, exitCode: number): boolean {
  if (exitCode === 0) return false;
  return (NON_ERROR_EXITS[baseCommandOf(command)] ?? []).includes(exitCode);
}

/**
 * 非零退出码的语义说明（信息性而非错误），或 null。
 * 顺序同 hermes：信号终止优先，再看按命令的语义表。
 */
export function interpretExitCode(command: string, exitCode: number): string | null {
  if (exitCode === 0) return null;
  const signalNote = interpretSignalExit(exitCode);
  if (signalNote) return signalNote;
  const table = EXIT_CODE_SEMANTICS[baseCommandOf(command)];
  return table ? (table[exitCode] ?? null) : null;
}

// ─────────────────────────── 失败恢复提示 ───────────────────────────

/** 退出码兜底提示（语义表不覆盖的通用码）。 */
const EXIT_CODE_HINTS: Record<number, string> = {
  124: "退出码 124：命令命中了超时。提高 timeout 参数（上限 1200s），或改用后台任务。",
  126: "退出码 126：文件存在但不可执行——`chmod +x` 它，或用解释器调用（如 `bash script.sh`）。",
  127: "退出码 127：命令未找到（PATH 上没有该程序）。先用 `which <cmd>` 确认，再安装或改用绝对路径。",
  137: "退出码 137：进程被 SIGKILL——通常是内存耗尽或被外部击杀。先降内存占用或看 `dmesg | tail` 再重试。",
};

/** `command not found` 的高频特例：发行版只装 python3/pip3。 */
const MISSING_COMMAND_HINTS: Record<string, string> = {
  python: "本机没有裸 `python`——用 `python3`，或项目 venv 的解释器（如 .venv/bin/python）。",
  pip: "本机没有裸 `pip`——用 `pip3`、`python3 -m pip`，或项目 venv 的 pip。",
};

function missingCommandHint(missing: string): string {
  return (
    MISSING_COMMAND_HINTS[missing] ??
    `\`${missing}\` 未安装或不在 PATH 上。先用 \`which ${missing}\` 确认，再安装或改用绝对路径——不要原样重试。`
  );
}

interface OutputHint {
  re: RegExp;
  hint: (m: RegExpExecArray) => string;
}

/** 按生产出现频率排序；首个匹配即返回。 */
const OUTPUT_HINTS: OutputHint[] = [
  {
    re: /Unknown JSON field: "?(\w+)/,
    hint: (m) =>
      `当前 gh 版本不支持 JSON 字段 '${m[1]}'。上面输出已列出合法字段——只用其中字段重试。`,
  },
  {
    re: /^CONFLICT |Automatic merge failed|needs merge/m,
    hint: () =>
      "Git 合并冲突。不要原样重试：解决上面列出的冲突文件（编辑后 `git add`），再继续" +
      "（`git rebase --continue` / 提交合并），或用 `--abort` 放弃。",
  },
  {
    re: /(?:bash: line \d+: |bash: |sh: \d*:? ?)?([\w.+-]+): command not found/,
    hint: (m) => missingCommandHint(m[1]),
  },
  {
    re: /(?:ModuleNotFoundError|ImportError): No module named '?([\w.]+)/,
    hint: (m) =>
      `Python 无法导入 '${m[1]}'。最常见原因是跑错解释器：激活项目 venv（如 \`source .venv/bin/activate\`）` +
      `或直接用它调用；只有确实缺包时才 pip install。`,
  },
  {
    re: /(?:fatal|error):.*?'([^']+)' already exists/,
    hint: (m) =>
      `'${m[1]}' 已存在——原样重试会一直失败。复用、换个名字，或确认它确实过时后再删除。`,
  },
  {
    re: /API rate limit|was submitted too quickly/,
    hint: () => "触发 API 限流——立即重试会继续失败。先做别的工作，稍后再重试该操作。",
  },
  {
    re: /Permission denied|EACCES/,
    hint: () =>
      "权限不足。用 `ls -la` 检查目标路径的属主/模式；优先写到用户可写位置。" +
      "只有任务确实需要时才提权。",
  },
];

/**
 * 失败命令的一条恢复提示；退出码 0 返回 null。
 * 先按输出模式匹配（更具体），再退到通用退出码提示。
 */
export function annotateFailure(command: string, exitCode: number, output: string): string | null {
  if (exitCode === 0) return null;
  const window = (output || "").slice(0, SCAN_CHARS);
  if (window) {
    for (const { re, hint } of OUTPUT_HINTS) {
      const m = re.exec(window);
      if (m) return hint(m);
    }
  }
  return EXIT_CODE_HINTS[exitCode] ?? null;
}

// ─────────────────────────── 掩盖成功 ───────────────────────────

/** 退出状态与上游命令无关的管道消费者。 */
const PASSTHROUGH_CONSUMERS = "(?:tail|head|cat|tee|less|more|wc|sort|uniq)";

/** 吞掉上游退出码的命令形态（按序检查）。 */
const MASKING_SHAPES: Array<{ re: RegExp; note: string }> = [
  {
    re: new RegExp(`(?<!\\|)\\|(?!\\|)\\s*${PASSTHROUGH_CONSUMERS}\\b[^|]*$`),
    note:
      "这里的 exit_code 0 是管道最后一条命令（tail/head/cat/…）的状态，不是管道前那条命令的——" +
      "而输出里有失败特征。在证实之前按**失败**处理：去掉管道重跑原命令拿真实退出码" +
      "（输出会自动截断并落盘，不需要再接 tail/head）。",
  },
  {
    re: /\|\|\s*(?:echo\b|printf\b|true\b|:\s|:$)/,
    note:
      "这里的 exit_code 0 是 `||` 兜底命令（echo/true）的状态，不是前面那条命令的——" +
      "而输出里有失败特征。在证实之前按**失败**处理：去掉 `|| …` 裸跑原命令拿真实退出码。",
  },
];

/** 只读命令头：它们的输出本来就可能是错误文本（grep 源码里的 error 字样）。 */
const READONLY_HEADS = new Set([
  "grep", "rg", "ag", "find", "ls", "cat", "head", "tail", "jq", "awk",
  "sed", "strings", "zcat", "journalctl", "dmesg", "echo", "printf",
]);

/** 强失败特征（按具体工具锚定，避免命中 diff/日志/提交信息里的 error 字样）。 */
const FAILURE_SHAPES = new RegExp(
  [
    "error\\[E\\d+\\]", // rustc
    "error: could not compile", // cargo
    "error: aborting due to", // rustc 汇总
    "Traceback \\(most recent call last\\)", // python
    "(?:^|\\n)\\s*(?:=+ )?\\d+ failed", // pytest 汇总
    "(?:^|\\n)FAILED (?:\\S+::|\\S+\\.py)", // pytest 逐条
    "compilation terminated\\.", // gcc/clang
    "npm ERR!", // npm
    "BUILD FAILED|Build FAILED", // gradle/msbuild
    "FAILED: ", // ninja
    "(?:^|\\n)make(?:\\[\\d+\\])?: \\*\\*\\*", // make
  ].join("|"),
);

/** 命令头（跳过前置 VAR=val 赋值）。 */
function firstToken(command: string): string {
  for (const tok of String(command || "").trim().split(/\s+/)) {
    if (!tok) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    return tok.replace(/\\/g, "/").split("/").pop() || "";
  }
  return "";
}

/**
 * 退出码 0 但很可能掩盖了上游失败时的告警（仅告警，**不改退出码**）。
 * 三个条件同时成立才触发：掩盖形态 + 强失败特征 + 非只读命令头。
 */
export function annotateMaskedSuccess(command: string, output: string): string | null {
  const cmd = command || "";
  const window = (output || "").slice(0, SCAN_CHARS);
  if (!cmd || !window) return null;
  if (READONLY_HEADS.has(firstToken(cmd))) return null;
  if (!FAILURE_SHAPES.test(window)) return null;
  return MASKING_SHAPES.find(({ re }) => re.test(cmd))?.note ?? null;
}

/**
 * 统一入口：为一次 shell_exec 结果生成可选注解字段。
 *
 * 只返回需要追加的键；调用方用 `Object.assign` 合并，绝不覆盖既有字段。
 * `output` 应传 stdout+stderr 的合并文本（错误可能在任一管道）。
 */
export function shellResultAnnotations(
  command: string,
  exitCode: number,
  output: string,
): { exit_code_meaning?: string; hint?: string; non_error_exit?: true } {
  const out: { exit_code_meaning?: string; hint?: string; non_error_exit?: true } = {};
  const meaning = interpretExitCode(command, exitCode);
  if (meaning) out.exit_code_meaning = meaning;
  // ★ 信息性退出码（grep/diff/test 的 1）打上 non_error_exit 标记，
  //   失败分类器据此不把它计进 failedTools。此前 grep 无匹配会让
  //   success:false 进失败链 → 无谓的自动续跑 + 「本轮失败工具」措辞。
  if (isInformationalExit(command, exitCode)) out.non_error_exit = true;
  if (exitCode === 0) {
    const masked = annotateMaskedSuccess(command, output);
    if (masked) out.hint = masked;
  } else if (!meaning) {
    // hermes 语义：已有 exit_code_meaning（信息性码）时不再给失败提示，
    // 避免「没有匹配」和「命令失败」两种信号同时出现把模型搞糊涂。
    const hint = annotateFailure(command, exitCode, output);
    if (hint) out.hint = hint;
  }
  return out;
}
