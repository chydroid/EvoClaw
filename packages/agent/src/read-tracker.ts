/**
 * ReadTracker — per-session 读追踪（dedup / 循环检测 / 覆盖账 / 写基线）。
 *
 * 对标 hermes `tools/file_tools_read_tracking.py` 的简化版（R11 GAP-6 接线）。
 * hermes 按 task_id 键控并带 sandbox 前缀；EvoClaw 用 sessionId（来自
 * ToolRuntimeContext），语义一致：同一会话反复读同一文件不再全额付费。
 *
 * 职责：
 * 1. dedup：同一 (path, offset, limit) 在文件未变时的重复读 → 第 1 次 stub、
 *    第 2 次起硬 BLOCK（weak tool-follower 防死循环）。
 * 2. 连续循环检测：同一读连续 3 次警告、4 次硬拒（真实读路径，hermes count>=4）。
 * 3. 覆盖账（coverage）：分页读按 version 合并区间，1..totalLines 覆盖满 =
 *    全文读 → 建写基线（未全文读不准整文件覆盖）。
 * 4. fullWriteBaselines：写文件成功 → 记 version 基线；覆盖写入前检查。
 * 5. advanceGeneration()：压缩边界前进 generation——dedup 保留（未变文件继续
 *    stub），generation-served 清空（压缩后首次读回全文，hermes reset_file_dedup）。
 * 6. 上限 cap：所有容器有硬上限，长会话不膨胀。
 *
 * 与 FileStateRegistry 的分工：FileStateRegistry 管**跨 agent** 的 mtime/hash
 * staleness；ReadTracker 管**会话内**的重复读与全文基线。两者互补。
 */

/** 每会话追踪数据 */
interface SessionTracker {
  /** dedup map：key → 文件 version（文件未变才 stub） */
  dedup: Map<string, string>;
  /** dedup 命中计数：key → stub 次数（>=2 硬 BLOCK） */
  dedupHits: Map<string, number>;
  /** 本 generation 内已 served 的 dedup key（压缩后清空 → 首读回全文） */
  generationServed: Set<string>;
  /** 连续重复读检测：lastKey / consecutive */
  lastKey: string | null;
  consecutive: number;
  /** 覆盖账：resolvedPath → { version, ranges, truncated } */
  coverage: Map<string, CoverageEntry>;
  /** 全文写基线：resolvedPath → 文件 version */
  fullWriteBaselines: Map<string, string>;
  /** 连续 patch/edit 失败计数：resolvedPath → count（>=3 升级提示） */
  editFailures: Map<string, number>;
}

/** 覆盖账条目 */
interface CoverageEntry {
  version: string;
  /** 已读行区间（1-based、闭区间）合并后列表 */
  ranges: Array<[number, number]>;
  /** 其中是否出现过截断读（16K char 截断不可作为全文证据） */
  truncated: boolean;
}

/** 阈值与上限（对标 hermes 常量） */
const DEDUP_CAP = 1000;
const COVERAGE_CAP = 256;
const BASELINE_CAP = 1000;
const EDIT_FAILURE_PATHS_CAP = 64;
/** 连续重复读：>=4 硬拒（hermes count >= 4 硬拒、>=3 警告） */
export const CONSECUTIVE_READ_BLOCK = 4;
export const CONSECUTIVE_READ_WARN = 3;
/** 同一文件连续 edit 失败升级提示阈值（hermes _record_patch_failure） */
export const EDIT_FAILURE_ESCALATE = 3;
/** 覆盖账最大合并区间数（超限重置，防碎片化膨胀） */
const COVERAGE_RANGES_CAP = 256;

/** 读请求记账结果 */
export interface ReadVerdict {
  /** allow = 真读；stub = 回 "unchanged" 占位；block = 硬拒 */
  action: "allow" | "stub" | "block";
  /** 连续重复读次数（1 = 首次/非连续） */
  consecutive: number;
}

/** 读追踪器（单例） */
export class ReadTracker {
  private static instance: ReadTracker | null = null;

  private sessions = new Map<string, SessionTracker>();

  private constructor() {}

  static getInstance(): ReadTracker {
    if (!ReadTracker.instance) {
      ReadTracker.instance = new ReadTracker();
    }
    return ReadTracker.instance;
  }

  static resetInstance(): void {
    ReadTracker.instance = null;
  }

  private session(sessionId: string): SessionTracker {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        dedup: new Map(),
        dedupHits: new Map(),
        generationServed: new Set(),
        lastKey: null,
        consecutive: 0,
        coverage: new Map(),
        fullWriteBaselines: new Map(),
        editFailures: new Map(),
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  // ── 读路径 ────────────────────────────────────────────────

  /**
   * 读前判定：该 (path, offset, limit) 读是否可 stub/硬拒。
   *
   * @param fileVersion 文件当前 version（mtime+hash 键控；未知传 null → 不 dedup）
   * @param offset 读起始行（1-based）
   * @param limit 行数上限（undefined = 全文/到 16K 截断）
   */
  checkBeforeRead(
    sessionId: string,
    filePath: string,
    fileVersion: string | null,
    offset: number,
    limit: number | undefined,
  ): ReadVerdict {
    const s = this.session(sessionId);
    const key = filePath + "\u0000" + offset + "\u0000" + (limit ?? "all");

    // 连续循环计数（任何其他 key 都重置）
    if (s.lastKey === key) {
      s.consecutive++;
    } else {
      s.lastKey = key;
      s.consecutive = 1;
    }

    // dedup 命中：文件未变 + 本 generation 已 served 过完整内容 → stub 或 block
    const cachedVersion = s.dedup.get(key);
    if (
      fileVersion !== null &&
      cachedVersion !== undefined &&
      cachedVersion === fileVersion &&
      s.generationServed.has(key)
    ) {
      const hits = (s.dedupHits.get(key) ?? 0) + 1;
      s.dedupHits.set(key, hits);
      if (hits >= 2) return { action: "block", consecutive: s.consecutive };
      return { action: "stub", consecutive: s.consecutive };
    }
    return { action: "allow", consecutive: s.consecutive };
  }

  /**
   * 真实读完成后记账：dedup、覆盖账、全文基线。
   *
   * @param fileVersion 文件 version（null = 无法确定，不建 dedup/基线）
   * @param endLine 本次读到的最后一行（1-based）
   * @param totalLines 文件总行数
   * @param truncated 是否被 16K char 截断（截断页不作全文证据）
   */
  noteReadServed(
    sessionId: string,
    filePath: string,
    fileVersion: string | null,
    offset: number,
    limit: number | undefined,
    endLine: number,
    totalLines: number,
    truncated: boolean,
  ): void {
    const s = this.session(sessionId);
    const key = filePath + "\u0000" + offset + "\u0000" + (limit ?? "all");

    if (fileVersion !== null) {
      // dedup 记账（连续同 key 读 >=4 时会硬拒，dedup 失效；hermes 同语义：
      // count >= 4 时 pop dedup，让读真正失败而不是永远 stub）
      if (s.consecutive >= CONSECUTIVE_READ_BLOCK) {
        s.dedup.delete(key);
        s.generationServed.delete(key);
      } else {
        if (s.dedup.size >= DEDUP_CAP) {
          const first = s.dedup.keys().next().value;
          if (first !== undefined) s.dedup.delete(first);
        }
        s.dedup.set(key, fileVersion);
        s.generationServed.add(key);
        if (s.generationServed.size > DEDUP_CAP) {
          // generationServed 无序 Set：超限时清空（保守、无正确性风险——只影响 stub 时机）
          s.generationServed.clear();
          s.generationServed.add(key);
        }
      }

      // 覆盖账合并
      const entry = s.coverage.get(filePath);
      const fresh =
        !entry || entry.version !== fileVersion || entry.ranges.length > COVERAGE_RANGES_CAP;
      const cov = fresh
        ? { version: fileVersion, ranges: [] as Array<[number, number]>, truncated: false }
        : entry!;
      cov.truncated = cov.truncated || truncated;
      const merged: Array<[number, number]> = [];
      for (const [st, en] of [...cov.ranges, [offset, endLine] as [number, number]].sort(
        (a, b) => a[0] - b[0],
      )) {
        if (merged.length > 0 && st <= merged[merged.length - 1][1] + 1) {
          const last = merged[merged.length - 1];
          merged[merged.length - 1] = [last[0], Math.max(last[1], en)];
        } else {
          merged.push([st, en]);
        }
      }
      cov.ranges = merged;
      if (s.coverage.size >= COVERAGE_CAP && !s.coverage.has(filePath)) {
        const first = s.coverage.keys().next().value;
        if (first !== undefined) s.coverage.delete(first);
      }
      s.coverage.set(filePath, cov);

      // 覆盖满 1..totalLines 且无截断 → 全文基线
      if (
        !cov.truncated &&
        totalLines > 0 &&
        cov.ranges[0][0] <= 1 &&
        cov.ranges[cov.ranges.length - 1][1] >= totalLines
      ) {
        this.markFullWriteBaseline(sessionId, filePath, fileVersion);
      }
    }

    // cap（保底：dedupHits / coverage）
    if (s.dedupHits.size > DEDUP_CAP) {
      s.dedupHits.clear();
    }
  }

  // ── 写路径 ────────────────────────────────────────────────

  /** 记全文写基线（全文读覆盖满 或 本会话成功写入后调用） */
  markFullWriteBaseline(sessionId: string, filePath: string, fileVersion: string): void {
    const s = this.session(sessionId);
    if (s.fullWriteBaselines.size >= BASELINE_CAP && !s.fullWriteBaselines.has(filePath)) {
      const first = s.fullWriteBaselines.keys().next().value;
      if (first !== undefined) s.fullWriteBaselines.delete(first);
    }
    s.fullWriteBaselines.set(filePath, fileVersion);
  }

  /**
   * 整文件覆盖前检查（对标 _stale_overwrite_blocker 的「全文基线」半边）。
   * 文件不存在 → 放行（net-new）；存在但无有效基线 → 拒绝理由；有基线且 version
   * 匹配 → 放行。
   *
   * @param fileExists 文件是否存在于磁盘
   * @param fileVersion 文件当前 version（不存在时传 null）
   */
  checkOverwriteBaseline(
    sessionId: string,
    filePath: string,
    fileExists: boolean,
    fileVersion: string | null,
  ): string | null {
    if (!fileExists) return null; // net-new 文件
    const s = this.session(sessionId);
    const baseline = s.fullWriteBaselines.get(filePath);
    if (baseline !== undefined && baseline === fileVersion) return null;
    return (
      `${filePath} exists but this session has not seen its full current content ` +
      "(never read, read only partially, or changed since the last full read). " +
      "Read the file — every page of it, if it needs offset/limit — or use " +
      "file_write action=edit for a targeted edit; a stale conversation copy must " +
      "not overwrite the current disk content."
    );
  }

  /** 本会话成功写入后：刷新基线 + 清该路径 dedup（下次读回新内容）+ 清覆盖账 */
  noteWriteServed(sessionId: string, filePath: string, fileVersion: string): void {
    const s = this.session(sessionId);
    this.markFullWriteBaseline(sessionId, filePath, fileVersion);
    for (const k of [...s.dedup.keys()]) {
      if (k.startsWith(filePath + "\u0000")) s.dedup.delete(k);
    }
    for (const k of [...s.generationServed]) {
      if (k.startsWith(filePath + "\u0000")) s.generationServed.delete(k);
    }
    s.coverage.delete(filePath);
    s.editFailures.delete(filePath);
  }

  // ── edit 失败计数（hermes _record_patch_failure）─────────

  /** 记一次 edit 失败，返回连续失败次数 */
  recordEditFailure(sessionId: string, filePath: string): number {
    const s = this.session(sessionId);
    if (s.editFailures.size >= EDIT_FAILURE_PATHS_CAP && !s.editFailures.has(filePath)) {
      const first = s.editFailures.keys().next().value;
      if (first !== undefined) s.editFailures.delete(first);
    }
    const n = (s.editFailures.get(filePath) ?? 0) + 1;
    s.editFailures.set(filePath, n);
    return n;
  }

  /** edit 成功后清失败计数 */
  clearEditFailures(sessionId: string, filePath: string): void {
    this.session(sessionId).editFailures.delete(filePath);
  }

  // ── 压缩边界（hermes reset_file_dedup）────────────────────

  /**
   * 压缩完成后调用：generation 前进。
   * - dedup map **保留**（未变文件继续 stub，不给已回收的上下文重新膨胀）
   * - generationServed **清空**（压缩后每个 key 的首次读回全文——摘要可能丢了字节）
   * - dedupHits 清空（硬 BLOCK 计数重新开始）
   * - 连续循环计数清空
   */
  advanceGeneration(sessionId?: string): void {
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.generationServed.clear();
        s.dedupHits.clear();
        s.lastKey = null;
        s.consecutive = 0;
      }
      return;
    }
    for (const s of this.sessions.values()) {
      s.generationServed.clear();
      s.dedupHits.clear();
      s.lastKey = null;
      s.consecutive = 0;
    }
  }

  /** 清空全部（测试用） */
  clearAll(): void {
    this.sessions.clear();
  }

  /** 任意其他工具调用后重置连续读计数（hermes notify_other_tool_call） */
  notifyOtherToolCall(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.lastKey = null;
      s.consecutive = 0;
    }
  }
}
