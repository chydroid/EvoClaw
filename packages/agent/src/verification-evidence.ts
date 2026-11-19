// EvoClaw 验证证据账本（借鉴 hermes-agent verification_evidence.py）
//
// hermes 的完整账本是 SQLite 持久化、跨 session 共享、带 LRU 清理的
// 「被动」账本——它从不跑测试、从不阻断完成。EvoClaw 这里只移植其
// **核心不变式**（edit-invalidation ledger）为内存存储：
//   - 一次验证覆盖某些路径 → 记一条事件（含时间戳）
//   - 之后又编辑了这些路径 → 该验证**失效**（stale）
//   - 验证门据此区分「从未验证」与「验证过但已被改动」，只对失效路径
//     要求**定向**复验（targeted proof），而不是每次都全量重跑。
//
// 不做 SQLite/跨 session：EvoClaw 的验证门已在 turn 内工作，
// 这里补的是「编辑会让之前的验证作废」这一层语义。

export interface VerificationEvent {
  id: number;
  /** 该次验证覆盖的文件路径 */
  paths: string[];
  /** 验证命令（如 `pnpm test` / `tsc --noEmit`） */
  command: string;
  /** 退出码（0 = 通过） */
  exitCode: number;
  /** 记录时间戳 */
  timestamp: number;
}

export interface VerificationState {
  /** 最后一条验证事件 */
  lastEvent: VerificationEvent | null;
  /** 最后一次编辑的时间戳（null = 从未编辑过，或已被成功验证清空） */
  lastEditAt: number | null;
  /** 最后一次编辑涉及的路径（成功验证后清空） */
  editedPaths: string[];
}

/**
 * 验证证据存储（per-session 内存）。
 *
 * 三种操作恰好对应 hermes 的三个入口：
 *   record()     → record_verify_run（记一条验证事件，成功则清空编辑记录）
 *   markEdited() → mark_workspace_edited（编辑后标记证据失效）
 *   getStale()   → 判断上次验证是否已被后续编辑作废
 */
export class VerificationEvidenceStore {
  private events: VerificationEvent[] = [];
  private lastEditAt: number | null = null;
  private editedPaths: string[] = [];
  private nextId = 1;
  /**
   * 最近一条「退出码不可归因」的验证命令（hermes verification_evidence 的
   * `_UNATTRIBUTED_RUNS` 语义）。
   *
   * 形如 `node --test x.js 2>&1 | tail -20`：shell 的退出码来自管道尾部
   * （tail 恒 0），无法区分检查命令自身是否失败。这类运行**绝不能**记成
   * 通过证据——否则测试全红也会把工作区标记成「已验证」、让验证门闭嘴。
   * 记录命令文本仅供 nudge 精确提示「请直接运行检查，不要接管道」。
   */
  private unattributedRun: string | null = null;

  /**
   * 记录一次验证运行。
   * 成功（exitCode === 0）的验证会清空编辑记录——与 hermes 语义一致：
   * 「全量通过的验证证明工作区没问题」，之后的编辑才需要重新验证。
   */
  record(paths: string[], command: string, exitCode: number): VerificationEvent {
    const event: VerificationEvent = {
      id: this.nextId++,
      paths: [...paths],
      command,
      exitCode,
      timestamp: Date.now(),
    };
    this.events.push(event);
    if (exitCode === 0) {
      this.lastEditAt = null;
      this.editedPaths = [];
      this.unattributedRun = null;
      // ★ 2026-11-19（v18 Task 1）：成功验证覆盖更早的失败——「测试红门」
      //   只看最后一条可归因事件，成功事件入账后失败事实自然失效（隐含
      //   在 getLastFailedAttributable 的扫描里），此处无需额外状态。
    }
    return event;
  }

  /**
   * 记录一条「退出码不可归因」的验证运行（不记为通过证据）。
   * 调用方应**跳过** `record()`，让工作区保持 unverified，验证门继续要求复验。
   */
  markUnattributedRun(command: string): void {
    this.unattributedRun = command;
  }

  /** 最近一条不可归因的验证命令（供验证门 nudge 提示），无则 null。 */
  getLastUnattributedRun(): string | null {
    return this.unattributedRun;
  }

  /**
   * 标记一次编辑：编辑会让**之后**的验证失效——但不会让**之前**的验证
   * 失效（hermes 语义：last_edit_at 记的是「最近一次编辑」，
   * 只要 last_edit_at > last_event.timestamp，上次验证即作废）。
   */
  markEdited(paths: string[]): void {
    this.lastEditAt = Date.now();
    for (const p of paths) {
      if (!this.editedPaths.includes(p)) this.editedPaths.push(p);
    }
  }

  /**
   * 上次验证是否已被后续编辑作废？
   * - 从未验证过 → null（调方按「从未验证」处理）
   * - 验证过且之后没编辑过 → 空数组（验证仍然有效）
   * - 验证过但之后编辑过 → 返回失效路径列表（需定向复验）
   *
   * 注意比较用**严格小于**：编辑与验证在同一毫秒内发生时（`lastEditAt ==
   * lastEvent.timestamp`）仍判为失效——编辑发生在验证之后，哪怕只差
   * 1ms，验证覆盖也不再可信。
   */
  getStalePaths(): string[] | null {
    if (this.events.length === 0) return null; // 从未验证
    const lastEvent = this.events[this.events.length - 1];
    // ★ 2026-11-16 修复：失败的验证（exitCode !== 0）永远不能证明工作区没问题。
    //   旧实现只比较时间戳，一旦失败事件时间戳晚于最后一次编辑（不同毫秒），
    //   就误判为「验证有效」并让验证门闭嘴。必须显式排除失败事件。
    if (lastEvent.exitCode !== 0) {
      return this.editedPaths.length > 0 ? [...this.editedPaths] : null;
    }
    if (this.lastEditAt === null) return []; // 验证有效
    if (this.lastEditAt < lastEvent.timestamp) return []; // 编辑发生在验证之前
    return [...this.editedPaths];
  }

  /** 最后一条验证事件（供调试/轨迹） */
  getLastEvent(): VerificationEvent | null {
    return this.events[this.events.length - 1] ?? null;
  }

  /**
   * ★ 2026-11-19（v18 压测 Task 1）：最后一条**可归因失败**的验证事件。
   *
   * v18 故障签名：模型跑了自测套件、测试红了（exitCode≠0 可归因——退出码
   * 未被管道掩盖），却在回复里声称「测试全绿」直接收尾。旧语义只防
   * 「变更后未验证就收尾」（验证门），不防「验证了、验证失败、仍收尾」——
   * 失败事件进了账本但没人拦。
   *
   * 返回语义与 getStalePaths() 对齐：
   * - null   → 从无可归因验证事件（或从未验证）
   * - 对象   → 最后一次可归因验证是失败，且其后没有成功的可归因验证覆盖
   *            （成功即清空，与 record() 清空 editedPaths 同语义）
   */
  getLastFailedAttributable(): { command: string; exitCode: number } | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev.exitCode === 0) return null; // 最近的成功验证已覆盖一切更早的失败
      return { command: ev.command, exitCode: ev.exitCode };
    }
    return null;
  }

  /** 当前状态快照 */
  getState(): VerificationState {
    return {
      lastEvent: this.getLastEvent(),
      lastEditAt: this.lastEditAt,
      editedPaths: [...this.editedPaths],
    };
  }

  /** 清空（新 turn / 新 session） */
  clear(): void {
    this.events = [];
    this.lastEditAt = null;
    this.editedPaths = [];
    this.unattributedRun = null;
    this.nextId = 1;
  }
}

// ── 单例（per-process，按 session 隔离） ────────────────────────────────────

const storeMap = new Map<string, VerificationEvidenceStore>();

export function getVerificationEvidenceStore(sessionId: string): VerificationEvidenceStore {
  let store = storeMap.get(sessionId);
  if (!store) {
    store = new VerificationEvidenceStore();
    storeMap.set(sessionId, store);
  }
  return store;
}

export function resetVerificationEvidenceStore(sessionId: string): void {
  storeMap.delete(sessionId);
}

// ── 验证命令识别（hermes _kind_for_command 的 TS 移植） ──────────────────────

/** 判为验证类的命令关键字（按 hermes 口径：test/lint/typecheck/build/fmt 分组） */
const VERIFY_KIND_KEYWORDS: [string[], string][] = [
  [["test", "pytest", "vitest", "jest", "mocha"], "test"],
  [["lint", "eslint", "ruff", "pylint"], "lint"],
  [["typecheck", "tsc", "mypy", "pyright", "ty"], "typecheck"],
  [["build"], "build"],
  [["fmt", "format", "prettier"], "format"],
];

/**
 * 判定一条命令是否属于「验证」类（test / lint / typecheck / build / fmt）。
 * hermes 的口径：「check」只在命令本身不是 test 命令时才算；这里按
* 关键词分组，任一组命中即判为验证。
 */
export function classifyVerificationCommand(command: string): string | null {
  if (!command) return null;
  const lower = command.toLowerCase();
  for (const [keywords, kind] of VERIFY_KIND_KEYWORDS) {
    if (keywords.some((kw) => lower.includes(kw))) return kind;
  }
  return null;
}

/**
 * 验证命令的退出码是否**可归因**（即 shell 的退出状态就是检查命令自身的结果）。
 *
 * 对标 hermes `verification_evidence` 对 `_UNATTRIBUTED_RUNS` 的处理：一条命令
 * 只要经管道/`;`/`||` 串接，shell 的退出码就来自（或可能来自）检查之外的片段，
 * 不能当作「检查通过」的证据。典型事故：
 *
 *   node --test x.js 2>&1 | tail -20   # tail 恒 0 → 测试全红也报「通过」
 *   node --test x.js; echo done        # echo 的 0 覆盖测试失败
 *   node --test x.js || true           # 失败被吞掉
 *
 * `&&` 链是安全的：左侧失败会短路并原样传播退出码（`cd x && node --test`
 * 仍能反映测试结果），所以不视为不可归因。
 *
 * 返回 false 时调用方必须**跳过** `record()`，只调 `markUnattributedRun()`。
 */
/**
 * 从工具原始结果中读取**可信**的退出码。
 *
 * ★ 2026-11-17 压测修复（v15 Task 3）：旧接线用 `exitCode ?? 0` 兜底，于是
 *   shell_exec 超时/进程启动失败（结果里没有 exitCode）会被当成 exit 0 记入
 *   证据账本，清空编辑记录、让验证门误以为工作区已验证。缺少退出码与
 *   「退出码被管道掩盖」等价：无法归因，必须按未验证处理（fail-closed）。
 *
 * 返回 null 表示结果中没有可用的数字退出码，调用方应 markUnattributedRun()
 * 而不是 record()。
 */
export function resolveVerificationExitCode(rawResult: unknown): number | null {
  if (!rawResult || typeof rawResult !== "object") return null;
  const exitCode = (rawResult as { exitCode?: unknown }).exitCode;
  return typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode : null;
}

/** 取最后一个顶层 `;` 之后的命令片段；单/双引号与反引号内的 `;` 不算分隔符。 */
function lastTopLevelSegment(command: string): string {
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === ";") start = i + 1;
  }
  return command.slice(start);
}

// 恒返回 0 的收尾命令：`检查; echo "test-exit=$?"` 的退出码来自 echo，
// 检查失败会被完全掩盖（v16 Task 4 实证：test_redact.py 2 失败仍记 exit 0）。
const STATUS_SENTINEL = /^\s*(?:echo|printf|true)(?:\s|$)|^\s*:\s|^\s*exit\s+0(?:\s|$)/;

export function isVerificationExitAttributable(command: string): boolean {
  if (!command) return false;
  // 管道：`a | b`（排除 `||`）——退出码来自管道尾部
  if (/(^|[^|])\|([^|]|$)/.test(command)) return false;
  // 或链：`a || b`——检查失败会被吞掉
  if (/\|\|/.test(command)) return false;
  // 顺序分隔 + 状态哨兵：`python3 test.py; echo "exit=$?"` 的 shell 退出码
  // 恒 0。只判「最后一个顶层片段是 echo/printf/true/:」这一明确形态，
  // `cd x; node --test y` 这类仍可归因；引号内的 `;`（内联脚本语句分隔符）
  // 由 lastTopLevelSegment 跳过，避免误伤 execute_code 风格命令。
  if (STATUS_SENTINEL.test(lastTopLevelSegment(command))) return false;
  return true;
}
