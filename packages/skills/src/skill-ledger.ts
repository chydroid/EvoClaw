/**
 * skill ledger — 编辑级审计账本 + 单条回滚（对齐 Hermes tools/skill_ledger.py）。
 *
 * Hermes 语义（skill_ledger.py docstring）：
 *  - 每次技能变异（任何 actor）向追加式 JSONL 追加一条记录，before/after 文件清单的
 *    内容以内容寻址（sha256 去重）存储在 blob 目录。JSONL 而非状态库：持久、可 grep、
 *    不随状态库重置丢失。
 *  - 遥测而非闸门（TELEMETRY, NOT A GATE）：所有公开写入路径吞异常并记日志——
 *    唯一例外 rollback_entry，其安全抓取失败时 fail-closed 中止回滚、不动任何文件。
 *  - 单编辑回滚：rollback 写入每个 before 文件、删除 only-after 文件，并要求先追加
 *    pre-rollback 安全条目（记录回滚起点的当前状态），使回滚本身可再回滚。
 *
 * EvoClaw 异同：
 *  - 路径：ledger = <storeDir>/ledger.jsonl（Hermes 是 skills/.curator_ledger.jsonl），
 *    blobs = <storeDir>/ledger-blobs/<sha256>，锁 = <storeDir>/locks/ledger.lock
 *    （CrossProcessLock，追加与维护共用同一把锁——见 Hermes _ledger_lock）。
 *  - completePackage（tarball 补全）：Hermes 从 curator 备份 tar 包union 文件使回滚恢复
 *    完整技能。EvoClaw 无 curator tarball 栈，但 archiveSkill 先整体移动目录再记录，
 *    归档前快照天然完整，因此该参数保留 API 兼容、不产生额外填充（见 captureBefore）。
 *  - 维护：上限 skills.ledger_max_bytes（默认 5 MB），超限 compact（delta 去重）→
 *    trim 到低水位 0.8×（否则下一次追加即再超，每轮都要付维护代价）→ 仅实际丢弃行后
 *    gc_blobs（3600s 宽限期内的 blob 可能是在途抓取，绝不删）。
 */

import { randomBytes, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { atomicWriteFileSync } from "@evoclaw/core";
import { CrossProcessLock } from "@evoclaw/infrastructure";

/** 快照清单条目：{path, sha256} */
export interface ManifestItem {
  path: string;
  sha256: string;
}

/** 账本条目（一行 JSONL）。 */
export interface LedgerEntry {
  id: string;
  ts: string;
  actor: string;
  action: string;
  skill: string;
  evidence: Record<string, unknown>;
  before: ManifestItem[];
  after: ManifestItem[];
}

/** 回滚结果（rollback fail-closed 语义：ok=false 时磁盘零改动）。 */
export interface RollbackOutcome {
  ok: boolean;
  message: string;
}

/**
 * 瞬态/可再生的本地产物——无论嵌套多深都不能扫进快照：
 * 误入的 venv/node_modules 会把 KB 级账本抓成 GB 级 blob（Hermes #107539）。
 */
const TRANSIENT_DIRS = new Set([
  ".venv", "venv", "env", ".env",
  "node_modules", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".git",
]);

/** 回滚必须恢复完整技能包的动作集合（层策略语义，capture 即全树）。 */
const PACKAGE_RESTORE_ACTIONS = new Set(["delete", "archive", "purge"]);

const VALID_ACTORS = new Set(["curator", "agent", "user"]);
const DEFAULT_LEDGER_MAX_BYTES = 5 * 1024 * 1024; // skills.ledger_max_bytes 默认 5 MB
const TRIM_LOW_WATER = 0.8; // trim 目标 = 上限的低水位
const BLOB_GC_GRACE_SECS = 3600; // 新 blob 可能属于在途抓取：绝不 GC
const HEX64_RE = /^[0-9a-f]{64}$/;

export interface SkillLedgerConfig {
  /** 技能根目录（回滚路径校验根之一）。 */
  skillsDir: string;
  /** 归档目录（回滚路径校验根之一）。 */
  archiveDir: string;
  /** 账本存储目录（ledger.jsonl / ledger-blobs / locks）。 */
  storeDir: string;
  /** skills.ledger_max_bytes（0 禁用维护裁剪）。 */
  ledgerMaxBytes?: number;
  /** skills.ledger 开关（默认开）。 */
  ledgerEnabled?: boolean;
}

/**
 * 追加式审计账本 + fail-closed 单编辑回滚。
 *
 * 并发模型（对齐 Hermes）：追加与维护（compact/trim/GC）共用一把跨进程锁，
 * 锁内完成「追加 → 维护」序列。Hermes 的注释正是警告：若并发追加者在
 * compact/trim 的 os.replace 之前用 O_APPEND 写同一行，该行会被静默丢失——
 * 锁是必需的。
 */
export class SkillLedger {
  private readonly ledgerPath: string;
  private readonly blobsDir: string;
  private readonly skillsDir: string;
  private readonly archiveDir: string;
  private readonly lock: CrossProcessLock;
  private readonly maxBytes: number;
  private readonly enabled: boolean;

  constructor(config: SkillLedgerConfig) {
    this.enabled = config.ledgerEnabled ?? true;
    this.ledgerPath = path.join(config.storeDir, "ledger.jsonl");
    this.blobsDir = path.join(config.storeDir, "ledger-blobs");
    this.skillsDir = config.skillsDir;
    this.archiveDir = config.archiveDir;
    this.maxBytes = config.ledgerMaxBytes ?? DEFAULT_LEDGER_MAX_BYTES;
    // CrossProcessLock 构造时会 mkdir lockDir（递归）；锁文件 <storeDir>/locks/ledger.lock
    this.lock = new CrossProcessLock(path.join(config.storeDir, "locks"), "ledger");
  }

  // ── blob 存储（内容寻址，sha256 去重）──

  /** 原子写入 *data*（键=sha256；已存在则保持原样）。失败向上抛——调用方决定致命性。 */
  storeBlob(data: Buffer): string {
    const digest = createHash("sha256").update(data).digest("hex");
    const dest = path.join(this.blobsDir, digest);
    if (!fs.existsSync(dest)) {
      // atomicWriteFileSync = temp + fsync + rename（崩溃安全，AGENTS.md 硬约束）
      atomicWriteFileSync(dest, data);
    }
    return digest;
  }

  /** 读取 blob 内容；缺失/非法哈希 → null。 */
  readBlob(sha256: string): Buffer | null {
    if (!sha256 || !HEX64_RE.test(sha256)) return null;
    const p = path.join(this.blobsDir, sha256);
    try {
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  }

  // ── 快照 ──

  /**
   * 抓取 root 下每个文件的 {path, sha256}（内容存入 blob）。root 为 None/缺失 → []。
   * 瞬态目录（venv/node_modules/缓存/.git）在任意深度排除——与 Hermes
   * snapshot_paths 的 parts[:-1] 排除语义一致（祖先段命中即排除该文件）。
   * 失效路径抛 I/O 错误——回滚安全抓取场景致命、遥测场景由调用方吞。
   */
  snapshotPaths(root?: string): ManifestItem[] {
    if (!root) return [];
    const rootNorm = path.resolve(root);
    let files: string[] = [];
    // 静态语义（对齐 Hermes root.is_file()/is_dir() 双假 → []）：
    // root 已消失 → []，不抛。
    if (!fs.existsSync(rootNorm)) return [];
    if (fs.statSync(rootNorm).isFile()) {
      files = [rootNorm];
    } else if (fs.statSync(rootNorm).isDirectory()) {
      const walk = (dir: string): void => {
        for (const name of fs.readdirSync(dir).sort()) {
          const full = path.join(dir, name);
          const st = fs.statSync(full);
          if (st.isDirectory()) {
            // 祖先段命中瞬态名 → 不进入（对齐 Hermes parts[:-1] 排除：文件基名不在此列）
            if (TRANSIENT_DIRS.has(name)) continue;
            walk(full);
          } else {
            files.push(full);
          }
        }
      };
      walk(rootNorm);
    }
    return files.map((f) => ({ path: f, sha256: this.storeBlob(fs.readFileSync(f)) }));
  }

  /**
   * 变异前抓取：尽力而为，失败/禁用 → null（捕获后残缺时调用方仍应记录）。
   * `completePackage=true`（delete/archive/purge）：回滚必须恢复完整技能包。
   * EvoClaw 台账无 curator tarball 栈，但归档/移动类变异在磁盘操作**前**整体抓整树，
   * 快照天然完整——该参数保留 API 兼容、不产生额外填充。
   */
  captureBefore(root?: string, completePackage?: boolean, skill?: string): ManifestItem[] | null {
    void completePackage; // 见类头注释：EvoClaw 归档前即整树快照
    void skill;
    if (!this.enabled) return null;
    try {
      if (!root || !fs.existsSync(root)) return [];
      return this.snapshotPaths(root);
    } catch (err) {
      this.warn(`before-capture failed (${this.errMsg(err)}) — mutation unaffected`);
      return null;
    }
  }

  // ── 账本追加（遥测：永不抛）──

  /** 仅保留两侧哈希不同的路径——rollback 会写全部 before 并删 only-after，
   * 双向不变文件是死重（Hermes：4000 文件技能每次 patch 的账本从 1.5MB 降下来）。 */
  private delta(
    before: ManifestItem[],
    after: ManifestItem[]
  ): [ManifestItem[], ManifestItem[]] {
    // 旧账本行/外部写入可能携带字符串形态 before/after（中间版本数据）：
    // 遥测对脏数据不抛——降级为空清单（对齐 Hermes with suppress 调用点语义）。
    const b = Array.isArray(before) ? before : [];
    const a = Array.isArray(after) ? after : [];
    const bSha = new Map(b.map((i) => [i.path, i.sha256]));
    const aSha = new Map(a.map((i) => [i.path, i.sha256]));
    const same = new Set<string>();
    for (const [p, sha] of bSha) if (aSha.get(p) === sha) same.add(p);
    return [
      b.filter((i) => !same.has(i.path)),
      a.filter((i) => !same.has(i.path)),
    ];
  }

  /**
   * 追加一条账本条目 → id；禁用/写失败 → null（永不抛）。
   * pre-rollback 故意跳过 delta（before == after 表达"每个被触路径的当前状态"）。
   */
  async appendEntry(
    action: string,
    skill: string,
    before?: ManifestItem[],
    after?: ManifestItem[],
    actor?: string,
    evidence?: Record<string, unknown>
  ): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const preRollback = action === "pre-rollback";
      const [b, a] = preRollback
        ? [before ?? [], after ?? []]
        : this.delta(before ?? [], after ?? []);
      const entry: LedgerEntry = {
        // 12 hex chars — 对齐 Hermes uuid4().hex[:12]。
        id: randomBytes(6).toString("hex"),
        ts: new Date().toISOString(),
        actor: actor && VALID_ACTORS.has(actor) ? actor : "curator",
        action,
        skill,
        evidence: evidence ?? {},
        before: b,
        after: a,
      };
      const line = JSON.stringify(entry) + "\n";
      const firstAppend = !fs.existsSync(this.ledgerPath);
      if (firstAppend) {
        fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      }
      // 锁内追加 + 维护：appendFileSync 是单次 O_APPEND write（对常规文件原子），
      // 与 Hermes open("a")+单次 fh.write 等价；锁保证维护 rewrite 不丢并发追加行。
      await this.lock.withLock(async () => {
        fs.appendFileSync(this.ledgerPath, line);
        this.maintainSizeLocked();
      });
      return entry.id;
    } catch (err) {
      this.warn(`failed to append entry (${this.errMsg(err)}) — mutation unaffected`);
      return null;
    }
  }

  /**
   * 变异钩子：after 状态从 afterRoot 抓取（before 用预捕获清单或从 beforeRoot 抓），
   * 然后追加。永不抛（对齐 Hermes with suppress(Exception) 调用点）。
   */
  async recordMutation(
    action: string,
    skill: string,
    beforeRoot?: string | null,
    before?: ManifestItem[] | null,
    afterRoot?: string | null,
    actor?: string,
    evidence?: Record<string, unknown>
  ): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      // 删除/归档/清除类变异：before 快照即整树，天然完整（EvoClaw 无 tarball 栈）。
      if (before === null || before === undefined) {
        before = beforeRoot ? this.snapshotPaths(beforeRoot) : [];
      }
      const after = afterRoot ? this.snapshotPaths(afterRoot) : [];
      void PACKAGE_RESTORE_ACTIONS; // 层语义由调用方保证（capture 在移动前）
      return await this.appendEntry(action, skill, before, after, actor, evidence);
    } catch (err) {
      this.warn(`record_mutation failed (${this.errMsg(err)}) — mutation unaffected`);
      return null;
    }
  }

  // ── 读取 ──

  /** 读取账本字节；无法解码（非 UTF-8）或不存在按参数返回 null（缺失时安静）。 */
  private readLedgerBytes(what: string, quietMissing: boolean): Buffer | null {
    try {
      const raw = fs.readFileSync(this.ledgerPath);
      // Windows 编辑器可能加 UTF-8 BOM：剥掉，避免首行被当成畸形。
      // fatal 解码：非法 UTF-8 字节视为账本不可读（Hermes 显式 UnicodeError，非替换为 U+FFFD）。
      const canonical = raw.subarray(raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0);
      new TextDecoder("utf-8", { fatal: true }).decode(canonical);
      return canonical;
    } catch (err) {
      if (quietMissing && (err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      this.warn(`ledger unreadable (${this.errMsg(err)}); ${what}`);
      return null;
    }
  }

  /** 账本条目列表（最新在前）；畸形行跳过；账本缺失/不可读 → []。 */
  listEntries(skill?: string, limit?: number): LedgerEntry[] {
    const raw = this.readLedgerBytes("listing empty", true);
    if (raw === null) return [];
    const rows: LedgerEntry[] = [];
    for (const line of raw.toString("utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as LedgerEntry;
        if (typeof row === "object" && row !== null && (!skill || row.skill === skill)) {
          rows.push(row);
        }
      } catch { /* 畸形行跳过 */ }
    }
    rows.reverse();
    return typeof limit === "number" && limit >= 0 ? rows.slice(0, limit) : rows;
  }

  /** 按 id 取条目。 */
  getEntry(entryId: string): LedgerEntry | null {
    if (!entryId) return null;
    return this.listEntries().find((r) => r.id === entryId) ?? null;
  }

  // ── 回滚（唯一 fail-closed 的路径）──

  /**
   * 每个 before/after 路径都必须落在本账本可写根（skillsDir / archiveDir）之下——
   * 手改的账本不能变成任意写原语（Hermes 校验 HERMES_HOME 为单一根的对应物）。
   * 返回错误描述或 null（null = 全部通过）。
   */
  private validateEntryPaths(entry: LedgerEntry): string | null {
    for (const section of ["before", "after"] as const) {
      for (const item of entry[section]) {
        const norm = path.normalize(item.path);
        if (!this.isUnder(this.skillsDir, norm) && !this.isUnder(this.archiveDir, norm)) {
          return `entry references a path outside ledger roots: ${item.path}`;
        }
      }
    }
    return null;
  }

  private isUnder(root: string, p: string): boolean {
    const normRoot = path.normalize(root);
    const rel = path.relative(normRoot, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /**
   * 恢复变异 entry_id 之前的 before 状态。fail-closed（对齐 Hermes rollback_entry）：
   *  1. 条目不存在 → 失败；
   *  2. 路径校验不过 → 拒绝；
   *  3. 全部 before blob 存在性预检——绝不半途失败；
   *  4. 先追加 pre-rollback 安全条目（触路径当前状态，before==after）绑定 rollback_target；
   *     追加失败 → 中止，磁盘不动；
   *  5. 写回 before 文件、删除 only-after 文件、追加 rollback 证据条目。
   */
  async rollbackEntry(entryId: string): Promise<RollbackOutcome> {
    const entry = this.getEntry(entryId);
    if (entry === null) {
      return { ok: false, message: `no ledger entry with id '${entryId}'` };
    }
    const pathErr = this.validateEntryPaths(entry);
    if (pathErr !== null) {
      return { ok: false, message: `refusing rollback: ${pathErr}` };
    }
    const before = entry.before;
    const after = entry.after;

    // 预检所有 blob：缺一即整体中止，绝不能出现"恢复了一部分"的半途状态。
    for (const item of before) {
      if (this.readBlob(item.sha256) === null) {
        return {
          ok: false,
          message: `missing blob ${item.sha256} for ${item.path}; rollback aborted, nothing was changed`,
        };
      }
    }

    // 安全条目：触路径的当前状态，使本次回滚本身可再回滚。
    const touched = new Set<string>();
    for (const item of [...before, ...after]) if (item.path) touched.add(item.path);
    let safetyBefore: ManifestItem[] = [];
    let safetyId: string | null = null;
    try {
      safetyBefore = [...touched]
        .sort()
        .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile())
        .map((p) => ({ path: p, sha256: this.storeBlob(fs.readFileSync(p)) }));
    } catch (err) {
      return {
        ok: false,
        message: `pre-rollback safety capture failed (${this.errMsg(err)}); rollback aborted and current skills were not changed`,
      };
    }
    safetyId = await this.appendEntry(
      "pre-rollback",
      entry.skill || "?",
      safetyBefore,
      safetyBefore,
      "user",
      { rollback_target: entryId }
    );
    if (safetyId === null) {
      return {
        ok: false,
        message:
          "pre-rollback safety capture failed (ledger disabled or unwritable); rollback aborted and current skills were not changed",
      };
    }

    // 恢复：写每个 before 文件，删除变异创建的文件。
    const beforePaths = new Set(before.map((i) => i.path));
    let restored = 0;
    for (const item of before) {
      const blob = this.readBlob(item.sha256);
      if (blob === null) continue; // 预检过——理论上不可达
      fs.mkdirSync(path.dirname(item.path), { recursive: true });
      atomicWriteFileSync(item.path, blob);
      restored++;
    }
    let removed = 0;
    for (const item of after) {
      if (!item.path || beforePaths.has(item.path)) continue;
      try {
        if (fs.existsSync(item.path) && fs.statSync(item.path).isFile()) {
          fs.unlinkSync(item.path);
          removed++;
        }
      } catch (err) {
        this.warn(`could not remove ${item.path} during rollback: ${this.errMsg(err)}`);
      }
    }

    await this.appendEntry(
      "rollback",
      entry.skill || "?",
      safetyBefore,
      before,
      "user",
      { rollback_target: entryId, restored, removed }
    );
    return {
      ok: true,
      message:
        `rolled back entry ${entryId} (${entry.action} on ` +
        `'${entry.skill}'): ${restored} file(s) restored, ${removed} removed. ` +
        `Safety entry ${safetyId} captured the pre-rollback state.`,
    };
  }

  /**
   * skill_restore_latest_edit 语义：回滚指定技能最近一条变异条目。
   * 不给 skill 则回滚全账本最新一条（对齐 Hermes 工具默认）。
   */
  async restoreLatestEdit(skill?: string): Promise<RollbackOutcome> {
    const latest = this.listEntries(skill, 1);
    if (latest.length === 0) {
      return { ok: false, message: `no ledger entries for skill '${skill ?? "*"}' to restore` };
    }
    return this.rollbackEntry(latest[0].id);
  }

  // ── 维护（compact / trim / gc）锁内同步 ──

  /** 把账本重写为 delta 形态（ids/顺序/回滚语义不变）；畸形行原样保留。
   * 返回 (kept, bytesBefore, bytesAfter)。不变量：新文件只有完整写完才替换旧文件。 */
  async compactLedger(): Promise<{ entries: number; before: number; after: number }> {
    return this.lock.withLock(async () => this.compactLedgerLocked());
  }

  private compactLedgerLocked(): { entries: number; before: number; after: number } {
    const raw = this.readLedgerBytes("compaction skipped", true);
    if (raw === null) {
      // 账本不可读（含畸形字节）：不动手、不重写；但按真实字节数回报诊断尺寸。
      const size = this.ledgerSize();
      return { entries: 0, before: size, after: size };
    }
    const text = raw.toString("utf-8");
    const outLines: string[] = [];
    let kept = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: LedgerEntry | null = null;
      let parsed = true;
      try {
        const obj = JSON.parse(line);
        if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
          row = obj as LedgerEntry;
        } else {
          parsed = false; // 合法 JSON 但非对象（数/串/数组）：像 Python 的非 dict 分支
        }
      } catch {
        parsed = false; // 畸形行：保留原样，不计数（对齐 Hermes except: out.append; continue）
      }
      if (!parsed || row === null) {
        outLines.push(line);
        if (parsed) kept++; // 非 dict 的合法 JSON 膨胀计数
        continue;
      }
      if (row.action !== "pre-rollback") {
        const [b, a] = this.delta(row.before ?? [], row.after ?? []);
        row.before = b;
        row.after = a;
        const compacted = JSON.stringify(row);
        outLines.push(compacted);
        kept++;
        continue;
      }
      outLines.push(line);
      kept++; // pre-rollback 保留整包，但计数
    }
    const expected = this.serializeLedger(outLines);
    if (raw.equals(expected)) {
      return { entries: kept, before: raw.length, after: raw.length }; // 已是 delta（追加时即算）→ 免重写
    }
    // 仅在确有变化时原子重写（对齐 Hermes：已是 compact 则不动文件）。
    const rewritten = this.rewriteLedgerLocked(
      outLines.map((l) => Buffer.from(l, "utf-8")),
      "compact"
    );
    if (rewritten !== expected.length) {
      // 理论上不可达：两者由同一序列化路径产出
      this.warn(`compact produced unexpected size ${rewritten} vs ${expected.length}`);
    }
    return { entries: kept, before: raw.length, after: expected.length };
  }

  /**
   * 原子重写账本（物理行粒度，UTF-8 安全）。
   * atomicWriteFileSync = temp + fsync + rename（比 Hermes 的 tmp+replace 更强：多了 fsync，
   * 崩溃时不会产生截断账本）。调用方须持有锁。返回字节数。
   */
  private rewriteLedgerLocked(lines: Buffer[], _op: string): number {
    const data = this.serializeLedger(lines);
    atomicWriteFileSync(this.ledgerPath, data);
    return data.length;
  }

  private serializeLedger(lines: Array<string | Buffer>): Buffer {
    if (lines.length === 0) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    for (const l of lines) {
      parts.push(Buffer.isBuffer(l) ? l : Buffer.from(l, "utf-8"));
      parts.push(Buffer.from("\n"));
    }
    return Buffer.concat(parts);
  }

  /**
   * 丢弃最旧行直到账本 ≤ maxBytes；最新条目永远存活。
   * 保留的行绝不重写/解析——畸形行原样存活；丢弃按物理行序（无论形态）。
   * 返回丢弃行数（0 = 未动）。
   */
  async trimOldest(maxBytes: number): Promise<number> {
    return this.lock.withLock(async () => this.trimOldestLocked(maxBytes));
  }

  private trimOldestLocked(maxBytes: number): number {
    const raw = this.readLedgerBytes("trim skipped", true);
    if (raw === null) return 0;
    // 仅按物理行终止符切分：splitlines 会把 U+2028/U+2029/U+0085 也当分隔符，
    // 但 ensure_ascii=False 的条目可能合法包含它们（对齐 Hermes 的刻意实现）。
    const lines = raw.toString("latin1").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const kept: Buffer[] = [];
    let size = 0;
    for (const line of lines.reverse()) {
      const addition = line.length + 1; // 行末 "\n"
      if (kept.length > 0 && size + addition > maxBytes) break;
      const buf = Buffer.from(line, "latin1");
      kept.push(buf);
      size += addition;
    }
    kept.reverse();
    const dropped = lines.length - kept.length;
    if (dropped === 0) return 0;
    this.rewriteLedgerLocked(kept, "trim");
    return dropped;
  }

  /** 维护清扫：上限超限 → compact → trim 到低水位 → 仅实际丢行后 GC blob。 */
  private maintainSizeLocked(): void {
    const max = this.maxBytes;
    if (max <= 0) return;
    try {
      if (!fs.existsSync(this.ledgerPath)) return;
      const size = fs.statSync(this.ledgerPath).size;
      if (size <= max) return;
      const composite = this.compactLedgerLocked();
      const lowWater = Math.floor(max * TRIM_LOW_WATER);
      const dropped = composite.after > lowWater ? this.trimOldestLocked(lowWater) : 0;
      if (dropped > 0) this.gcBlobsLocked();
    } catch (err) {
      this.warn(`maintenance sweep failed (${this.errMsg(err)}) — ledger left as-is`);
    }
  }

  /**
   * 删除无账本条目引用的 blob；返回 (deleted, freed)。
   * 账本不可读/畸形行 → 中止（不删任何 blob：条目可能仍引用它）。
   * 小于宽限期的 blob 保留（在途抓取：snapshot_paths 先存 blob 后追加引用行）。
   */
  async gcBlobs(): Promise<{ deleted: number; freed: number }> {
    return this.lock.withLock(async () => this.gcBlobsLocked());
  }

  private gcBlobsLocked(): { deleted: number; freed: number } {
    if (!fs.existsSync(this.blobsDir) || !fs.statSync(this.blobsDir).isDirectory()) {
      return { deleted: 0, freed: 0 };
    }
    const raw = this.readLedgerBytes("blob GC skipped", true);
    if (raw === null) return { deleted: 0, freed: 0 }; // 不可读账本不是"blob 无引用"的证据
    const referenced = new Set<string>();
    let malformed = false;
    for (const line of raw.toString("utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as LedgerEntry;
        if (typeof row !== "object" || row === null) {
          malformed = true;
          break;
        }
        for (const item of [...(row.before ?? []), ...(row.after ?? [])]) {
          referenced.add(item.sha256);
        }
      } catch {
        malformed = true;
        break; // 无法读取的行 → 保守中止
      }
    }
    if (malformed) {
      this.warn("malformed ledger line; blob GC skipped");
      return { deleted: 0, freed: 0 };
    }
    const freshAfter = Date.now() / 1000 - BLOB_GC_GRACE_SECS;
    let deleted = 0;
    let freed = 0;
    for (const entry of fs.readdirSync(this.blobsDir).sort()) {
      const blobPath = path.join(this.blobsDir, entry);
      if (!fs.statSync(blobPath).isFile()) continue;
      if (referenced.has(entry)) continue;
      try {
        const st = fs.statSync(blobPath);
        if (st.mtimeMs / 1000 > freshAfter) continue; // 在途抓取（含 .tmp-*）
        const size = st.size;
        fs.unlinkSync(blobPath);
        deleted++;
        freed += size;
      } catch {
        // stat/unlink 失败 → 单文件跳过
      }
    }
    return { deleted, freed };
  }

  /** 供诊断：当前账本大小（不存在 → 0）。 */
  ledgerSize(): number {
    try {
      return fs.statSync(this.ledgerPath).size;
    } catch {
      return 0;
    }
  }

  private warn(msg: string): void {
    process.stderr.write(`[skill-ledger] ${msg}\n`);
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
