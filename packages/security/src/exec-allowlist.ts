/**
 * Exec Allowlist — 命令白名单匹配
 *
 * 借鉴 openclaw-main exec-allowlist-canonical + exec-allowlist-match 设计：
 *   - 按"二进制名 + 可选 path + 可选 args 规则"三维度匹配
 *   - argsAllowlist：每个参数必须命中至少一个允许前缀
 *   - argsDenylist：参数序列禁止出现指定 token 序列（如 "push --force"）
 *   - path：若指定则要求 args[0] 完整路径严格匹配
 *
 * 默认装载一组只读安全命令（git 只读子命令、ls、pwd、cat、echo 等）。
 */

/** 单条白名单条目 */
export interface AllowlistEntry {
  /** 二进制名（如 "git"），小写匹配 */
  name: string;
  /** 完整路径（如 "/usr/bin/git"）— 若指定则 args[0] 必须严格匹配 */
  path?: string;
  /** 允许的参数前缀（如 ["status", "log", "diff"]）；未指定则不限制参数 */
  argsAllowlist?: string[];
  /** 禁止的参数 token 序列（如 ["push --force", "reset --hard"]）；命中即拒绝 */
  argsDenylist?: string[];
}

/** 取二进制 basename 并小写 */
function binaryNameOf(token: string): string {
  if (!token) return "";
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase();
}

/** 将空格分隔的 token 序列切分为数组 */
function tokenizeSequence(seq: string): string[] {
  return seq.trim().split(/\s+/).filter((t) => t.length > 0);
}

/**
 * 命令白名单：按 name 索引多条 AllowlistEntry，逐一匹配。
 */
export class ExecAllowlist {
  private readonly entries = new Map<string, AllowlistEntry[]>();

  constructor() {
    // 默认安全命令白名单（只读、无副作用）
    this.add({ name: "git", argsAllowlist: ["status", "log", "diff", "branch", "show", "ls-files"] });
    this.add({ name: "ls" });
    this.add({ name: "pwd" });
    this.add({ name: "cat" });
    this.add({ name: "echo" });
    this.add({ name: "node", argsAllowlist: ["--version", "--help"] });
    this.add({ name: "python", argsAllowlist: ["--version", "--help"] });
  }

  /** 新增白名单条目（同名可叠加多条） */
  add(entry: AllowlistEntry): void {
    const name = entry.name?.trim().toLowerCase();
    if (!name) return;
    const list = this.entries.get(name) ?? [];
    list.push({ ...entry, name });
    this.entries.set(name, list);
  }

  /** 移除指定 name 的所有条目；返回是否实际移除 */
  remove(name: string): boolean {
    const key = name?.trim().toLowerCase();
    if (!key) return false;
    return this.entries.delete(key);
  }

  /** 列出所有条目（扁平化） */
  list(): AllowlistEntry[] {
    const out: AllowlistEntry[] = [];
    for (const list of this.entries.values()) {
      out.push(...list);
    }
    return out;
  }

  /**
   * 检查命令是否命中白名单。
   *
   * 二进制名从 `command`（已归一化）首 token 解析，以识别别名映射后的真实命令；
   * 参数与路径匹配使用 `args`（保留原始路径信息）。
   *
   * @param command 归一化后的命令字符串（首 token 已应用别名映射）
   * @param args 已解析参数数组，args[0] 为二进制名或完整路径
   * @returns 命中返回 true
   */
  matches(command: string, args: string[]): boolean {
    const cmdFirst = (command ?? "").trim().split(/\s+/)[0] ?? "";
    if (!cmdFirst) return false;
    const binName = binaryNameOf(cmdFirst);
    const list = this.entries.get(binName);
    if (!list || list.length === 0) return false;

    // 参数：优先用 args.slice(1)，否则从 command 解析剩余 token
    let restArgs: string[];
    let binTokenForPath: string;
    if (args && args.length > 0) {
      binTokenForPath = args[0];
      restArgs = args.slice(1);
    } else {
      binTokenForPath = cmdFirst;
      restArgs = (command ?? "").trim().split(/\s+/).slice(1);
    }
    for (const entry of list) {
      if (this.matchEntry(entry, binTokenForPath, restArgs)) return true;
    }
    return false;
  }

  private matchEntry(entry: AllowlistEntry, binToken: string, restArgs: string[]): boolean {
    // path 严格匹配（若指定）
    if (entry.path) {
      // 比较 binToken 与 entry.path（跨平台归一化分隔符）
      const normToken = binToken.replace(/\\/g, "/").toLowerCase();
      const normPath = entry.path.replace(/\\/g, "/").toLowerCase();
      if (normToken !== normPath) return false;
    }

    // argsDenylist 命中即拒绝（检查完整参数序列）
    if (entry.argsDenylist && entry.argsDenylist.length > 0) {
      for (const denySeq of entry.argsDenylist) {
        if (this.argsContainSequence(restArgs, tokenizeSequence(denySeq))) {
          return false;
        }
      }
    }

    // argsAllowlist：首个参数（子命令）必须命中至少一个允许前缀。
    // 后续 flags/values 不受限——argsAllowlist 表示"允许的子命令集合"。
    if (entry.argsAllowlist && entry.argsAllowlist.length > 0) {
      if (restArgs.length === 0) return false;
      const firstArg = restArgs[0];
      const matched = entry.argsAllowlist.some(
        (prefix) => firstArg === prefix || firstArg.startsWith(prefix),
      );
      if (!matched) return false;
    }

    return true;
  }

  /** 检查 args 中是否包含连续的 token 序列 */
  private argsContainSequence(args: string[], seq: string[]): boolean {
    if (seq.length === 0) return false;
    if (args.length < seq.length) return false;
    for (let i = 0; i <= args.length - seq.length; i++) {
      let match = true;
      for (let j = 0; j < seq.length; j++) {
        if (args[i + j] !== seq[j]) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
    return false;
  }
}
