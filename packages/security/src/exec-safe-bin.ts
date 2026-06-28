/**
 * Exec Safe-Bin — 二进制名称归一化与安全策略
 *
 * 借鉴 openclaw-main exec-safe-bin-normalize + exec-safe-bin-policy 设计：
 *   - ExecSafeBinNormalizer：跨平台命令归一化（别名映射、shell 元字符间隔化）
 *   - ExecSafeBinPolicy：unsafe 二进制集合管理
 *
 * 归一化策略（用于规则匹配，不影响实际执行）：
 *   1. 去除前后空白、折叠多空白
 *   2. 解析首 token 并应用别名映射（ll/la → ls、del → rm 等）
 *   3. 将 shell 元字符 ; | & $ ` > < 归一化为"前后单空格"分隔形式
 *      （保留语义结构以便正则匹配，例如 "curl X|sh" → "curl X | sh"）
 *   4. 检测不可见控制字符（\x00-\x1f、\x7f），供调用方预警
 */

// ── 别名映射（跨平台兼容） ──────────────────────────────────
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ls: "ls", ll: "ls", la: "ls",
  rm: "rm", del: "rm", // Windows del
  cp: "cp", copy: "cp",
  mv: "mv", move: "mv",
  cat: "cat", type: "cat", // Windows type
  grep: "grep", findstr: "grep",
  python3: "python", python: "python",
  node: "node", nodejs: "node",
  sh: "sh", bash: "bash",
});

// shell 元字符：归一化为前后单空格分隔
const SHELL_META_CHARS = /[;&$`<>|]/g;

// 不可见控制字符：\x00-\x1f（除 \t \n 外）+ \x7f
const HIDDEN_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * 二进制名称归一化器：将原始命令字符串转换为规则匹配用的稳定形式。
 *
 * 注意：归一化结果仅用于规则匹配与审计日志，实际进程执行仍使用原始命令。
 */
export class ExecSafeBinNormalizer {
  /** 别名表（测试与扩展用） */
  static readonly ALIASES = ALIASES;

  /**
   * 归一化命令字符串。
   *
   * @param command 原始命令
   * @returns 归一化后的命令（首 token 已应用别名映射，shell 元字符前后已加空格）
   */
  normalize(command: string): string {
    if (!command) return "";

    // 1. 折叠前后空白与多空白
    let cmd = command.trim().replace(/\s+/g, " ");
    if (!cmd) return "";

    // 2. 将 shell 元字符归一化为"前后单空格"分隔
    cmd = cmd.replace(SHELL_META_CHARS, (ch) => ` ${ch} `);
    // 折叠因插入空格产生的连续空白
    cmd = cmd.replace(/\s+/g, " ").trim();
    if (!cmd) return "";

    // 3. 解析首 token 并应用别名映射
    const firstSpace = cmd.indexOf(" ");
    const head = firstSpace === -1 ? cmd : cmd.slice(0, firstSpace);
    const tail = firstSpace === -1 ? "" : cmd.slice(firstSpace);

    // 取 basename（处理 ./bin/ls 形式）
    const baseName = head.split(/[\\/]/).pop() ?? head;
    const lower = baseName.toLowerCase();
    const aliased = ALIASES[lower] ?? baseName;

    // 4. 重组（保留 tail 原样）
    return tail ? `${aliased}${tail}` : aliased;
  }

  /**
   * 检测命令中是否包含可疑隐藏字符（控制字符、DEL 等）。
   *
   * @returns 命中的字符码点列表（如 ["U+00","U+1B"]），空数组表示无命中
   */
  detectHiddenChars(command: string): string[] {
    if (!command) return [];
    const hits: string[] = [];
    const seen = new Set<string>();
    const matches = command.match(HIDDEN_CHAR_RE);
    if (!matches) return [];
    for (const ch of matches) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      const code = ch.charCodeAt(0);
      hits.push(`U+${code.toString(16).toUpperCase().padStart(2, "0")}`);
    }
    return hits;
  }
}

// ── Safe-Bin Policy ──────────────────────────────────────

/**
 * 二进制安全策略：维护一组公认"unsafe"二进制名，
 * 供调用方在 allowlist 之外做额外约束（如要求 path 限定）。
 */
export class ExecSafeBinPolicy {
  private readonly unsafeBins: Set<string>;

  constructor(initialUnsafe?: Iterable<string>) {
    const defaults = ["rm", "mkfs", "dd", "shutdown", "reboot", "halt", "poweroff"];
    this.unsafeBins = new Set(initialUnsafe ?? defaults);
  }

  /** 判断二进制名是否安全（不在 unsafe 集合中） */
  isSafeBin(name: string): boolean {
    if (!name) return true;
    const base = name.split(/[\\/]/).pop() ?? name;
    return !this.unsafeBins.has(base.toLowerCase());
  }

  /** 新增 unsafe 二进制 */
  addSafeBin(name: string): void {
    const trimmed = name?.trim();
    if (!trimmed) return;
    this.unsafeBins.add(trimmed.toLowerCase());
  }

  /** 移除 unsafe 二进制标记（即标记为安全） */
  removeSafeBin(name: string): boolean {
    const trimmed = name?.trim().toLowerCase();
    if (!trimmed) return false;
    return this.unsafeBins.delete(trimmed);
  }

  /** 列出当前 unsafe 二进制 */
  listUnsafeBins(): string[] {
    return Array.from(this.unsafeBins).sort();
  }
}
