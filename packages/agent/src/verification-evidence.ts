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
    }
    return event;
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
    if (this.lastEditAt === null) return []; // 验证有效
    const lastEvent = this.events[this.events.length - 1];
    if (this.lastEditAt < lastEvent.timestamp) return []; // 编辑发生在验证之前
    return [...this.editedPaths];
  }

  /** 最后一条验证事件（供调试/轨迹） */
  getLastEvent(): VerificationEvent | null {
    return this.events[this.events.length - 1] ?? null;
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