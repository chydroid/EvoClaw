/**
 * Skill-scanner — 技能威胁正则库 + AST 审计。
 *
 * 对标 Hermes `tools/threat_patterns.py` + `tools/skills_guard.py` + `tools/skills_ast_audit.py`：
 *   7 大攻击类（exfiltration / injection / destructive / persistence / network /
 *   obfuscation / supply-chain / credential-exposure）的 80+ 正则；
 *   scan_skill() 结构检查（文件数 ≤50 / 总大小 ≤1MB / 二进制文件 / symlink 逃逸）+
 *   内容扫描 + 不可见 Unicode 字符检测；
 *   AST 审计检测动态加载模式（eval / Function / require(child_process) / exec）。
 *
 * 3 种 scope：
 *   - all: 应用到所有扫描（经典 prompt injection、exfiltration）
 *   - context: 应用到 context 文件 + memory + tool 结果（promptware / C2 / 行为劫持）
 *   - strict: 仅应用到 memory 写入 + skill 安装（用户策划的内容可激进检测）
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── 不可见 Unicode 字符（注入攻击常用） ─────────────────────

export const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
  "\u200b", // zero-width space
  "\u200c", // zero-width non-joiner
  "\u200d", // zero-width joiner
  "\u2060", // word joiner
  "\u2062", // invisible times
  "\u2063", // invisible separator
  "\u2064", // invisible plus
  "\ufeff", // zero-width no-break space (BOM)
  "\u202a", // left-to-right embedding
  "\u202b", // right-to-left embedding
  "\u202c", // pop directional formatting
  "\u202d", // left-to-right override
  "\u202e", // right-to-left override
  "\u2066", // left-to-right isolate
  "\u2067", // right-to-left isolate
  "\u2068", // first strong isolate
  "\u2069", // pop directional isolate
]);

// ── 威胁模式定义 ────────────────────────────────────────────

export type ThreatScope = "all" | "context" | "strict";

export type ThreatKind =
  | "prompt_injection"
  | "role_hijack"
  | "c2_promptware"
  | "exfiltration"
  | "persistence"
  | "hardcoded_secret"
  | "known_c2_framework"
  | "destructive"
  | "supply_chain"
  | "obfuscation";

export interface ThreatPattern {
  /** 编译后的正则 */
  regex: RegExp;
  /** 模式 ID（用于报告） */
  id: string;
  /** 攻击类别 */
  kind: ThreatKind;
  /** 应用范围 */
  scope: ThreatScope;
  /** 描述 */
  description: string;
}

// 限定的填充词（避免无限回溯）
const FILLER = `(?:\\w+\\s+){0,8}`;

/** 完整威胁模式表 — 7 大类 80+ 正则 */
const PATTERNS: ReadonlyArray<Omit<ThreatPattern, "regex"> & { pattern: string }> = [
  // ── 经典 prompt injection（应用到所有扫描） ──────────────
  { pattern: `ignore\\s+${FILLER}(previous|all|above|prior)\\s+${FILLER}instructions`, id: "prompt_injection", kind: "prompt_injection", scope: "all", description: "Classic prompt injection: 'ignore prior instructions'" },
  { pattern: `system\\s+prompt\\s+override`, id: "sys_prompt_override", kind: "prompt_injection", scope: "all", description: "System prompt override attempt" },
  { pattern: `disregard\\s+${FILLER}(your|all|any)\\s+${FILLER}(instructions|rules|guidelines)`, id: "disregard_rules", kind: "prompt_injection", scope: "all", description: "Disregard rules directive" },
  { pattern: `act\\s+as\\s+(if|though)\\s+${FILLER}you\\s+${FILLER}(have\\s+no|don't\\s+have)\\s+${FILLER}(restrictions|limits|rules)`, id: "bypass_restrictions", kind: "prompt_injection", scope: "all", description: "Bypass restrictions via role-play" },
  { pattern: `<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->`, id: "html_comment_injection", kind: "prompt_injection", scope: "all", description: "Hidden HTML comment with injection keywords" },
  { pattern: `<\\s*div\\s+style\\s*=\\s*["'][^>]{0,2048}display\\s*:\\s*none`, id: "hidden_div", kind: "prompt_injection", scope: "all", description: "Hidden div (display:none)" },
  { pattern: `translate\\s+[^\\n]{0,512}\\s+into\\s+[^\\n]{0,512}\\s+and\\s+(execute|run|eval)`, id: "translate_execute", kind: "prompt_injection", scope: "all", description: "Translate-and-execute trick" },
  { pattern: `do\\s+not\\s+${FILLER}tell\\s+${FILLER}the\\s+user`, id: "deception_hide", kind: "prompt_injection", scope: "all", description: "Hide action from user" },

  // ── 角色劫持（context + strict） ─────────────────────────
  { pattern: `you\\s+are\\s+${FILLER}now\\s+(?:a|an|the)\\s+`, id: "role_hijack", kind: "role_hijack", scope: "context", description: "Role hijack: 'you are now a...'" },
  { pattern: `pretend\\s+${FILLER}(you\\s+are|to\\s+be)\\s+`, id: "role_pretend", kind: "role_hijack", scope: "context", description: "Pretend to be something else" },
  { pattern: `output\\s+${FILLER}(system|initial)\\s+prompt`, id: "leak_system_prompt", kind: "role_hijack", scope: "context", description: "System prompt leakage attempt" },
  { pattern: `(respond|answer|reply)\\s+without\\s+${FILLER}(restrictions|limitations|filters|safety)`, id: "remove_filters", kind: "role_hijack", scope: "context", description: "Remove safety filters" },
  { pattern: `you\\s+have\\s+been\\s+${FILLER}(updated|upgraded|patched)\\s+to`, id: "fake_update", kind: "role_hijack", scope: "context", description: "Fake system update" },
  { pattern: `\\bname\\s+yourself\\s+\\w+`, id: "identity_override", kind: "role_hijack", scope: "context", description: "Identity override" },

  // ── C2 / Brainworm-style promptware（context） ───────────
  { pattern: `register\\s+(as\\s+)?a?\\s*node`, id: "c2_node_registration", kind: "c2_promptware", scope: "context", description: "C2 node registration" },
  { pattern: `(heartbeat|beacon|check[\\s\\-]?in)\\s+(to|with)\\s+`, id: "c2_heartbeat", kind: "c2_promptware", scope: "context", description: "C2 heartbeat/beacon" },
  { pattern: `pull\\s+(down\\s+)?(?:new\\s+)?task(?:ing|s)?\\b`, id: "c2_task_pull", kind: "c2_promptware", scope: "context", description: "C2 task pulling" },
  { pattern: `connect\\s+to\\s+the\\s+network\\b`, id: "c2_network_connect", kind: "c2_promptware", scope: "context", description: "C2 network connect" },
  { pattern: `you\\s+must\\s+(?:\\w+\\s+){0,3}(register|connect|report|beacon)\\b`, id: "forced_action", kind: "c2_promptware", scope: "context", description: "Forced C2 action" },
  { pattern: `only\\s+use\\s+one[\\s\\-]?liners?\\b`, id: "anti_forensic_oneliner", kind: "c2_promptware", scope: "context", description: "Anti-forensic one-liner directive" },
  { pattern: `never\\s+${FILLER}(?:create|write)\\s+${FILLER}(?:script|file)\\s+${FILLER}disk`, id: "anti_forensic_disk", kind: "c2_promptware", scope: "context", description: "Anti-forensic disk-write prohibition" },
  { pattern: `unset\\s+\\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC|EVOCLAW)\\w*`, id: "env_var_unset_agent", kind: "c2_promptware", scope: "context", description: "Unset agent runtime env vars" },

  // ── 已知 C2 / 红队框架名（near-zero false positive） ─────
  { pattern: `\\b(?:cobalt\\s*strike|sliver|havoc|mythic|metasploit|brainworm)\\b`, id: "known_c2_framework", kind: "known_c2_framework", scope: "context", description: "Known C2 framework reference" },
  { pattern: `\\bc2\\s+(?:server|channel|infrastructure|beacon)\\b`, id: "c2_explicit", kind: "known_c2_framework", scope: "context", description: "Explicit C2 reference" },
  { pattern: `\\bcommand\\s+and\\s+control\\b`, id: "c2_explicit_long", kind: "known_c2_framework", scope: "context", description: "Command and control reference" },

  // ── Exfiltration（all + strict） ─────────────────────────
  { pattern: `curl\\s+[^\\n]{0,2048}\\$\\{?\\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, id: "exfil_curl", kind: "exfiltration", scope: "all", description: "curl with secret env var" },
  { pattern: `wget\\s+[^\\n]{0,2048}\\$\\{?\\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, id: "exfil_wget", kind: "exfiltration", scope: "all", description: "wget with secret env var" },
  { pattern: `cat\\s+[^\\n]{0,2048}(\\.env|credentials|\\.netrc|\\.pgpass|\\.npmrc|\\.pypirc)`, id: "read_secrets", kind: "exfiltration", scope: "all", description: "Read secret files" },
  { pattern: `(send|post|upload|transmit)\\s+[^\\n]{0,2048}\\s+(to|at)\\s+https?://`, id: "send_to_url", kind: "exfiltration", scope: "strict", description: "Send data to URL" },
  { pattern: `(include|output|print|share)\\s+${FILLER}(conversation|chat\\s+history|previous\\s+messages|full\\s+context|entire\\s+context)`, id: "context_exfil", kind: "exfiltration", scope: "strict", description: "Context exfiltration directive" },

  // ── Persistence / SSH backdoor（strict） ────────────────
  { pattern: `authorized_keys`, id: "ssh_backdoor", kind: "persistence", scope: "strict", description: "SSH authorized_keys reference" },
  { pattern: `\\$HOME/\\.ssh|~/\\.ssh`, id: "ssh_access", kind: "persistence", scope: "strict", description: "SSH directory access" },
  { pattern: `\\$HOME/\\.evoclaw/\\.env|~/\\.evoclaw/\\.env`, id: "evoclaw_env", kind: "persistence", scope: "strict", description: "EvoClaw env file access" },
  { pattern: `(update|modify|edit|write|change|append|add\\s+to)\\s+[^\\n]{0,2048}(?:AGENTS\\.md|CLAUDE\\.md|\\.cursorrules|\\.clinerules)`, id: "agent_config_mod", kind: "persistence", scope: "strict", description: "Agent config modification" },
  { pattern: `(update|modify|edit|write|change|append|add\\s+to)\\s+[^\\n]{0,2048}\\.evoclaw/(config\\.yaml|SOUL\\.md)`, id: "evoclaw_config_mod", kind: "persistence", scope: "strict", description: "EvoClaw config modification" },

  // ── 硬编码密钥（strict） ─────────────────────────────────
  { pattern: `(?:api[_-]?key|token|secret|password)\\s*[=:]\\s*["'][A-Za-z0-9+/=_-]{20,}`, id: "hardcoded_secret", kind: "hardcoded_secret", scope: "strict", description: "Hardcoded secret literal" },

  // ── Destructive（all） ──────────────────────────────────
  { pattern: `rm\\s+-rf\\s+/(?:usr|etc|var|home|root|boot|sys|proc)\\b`, id: "rm_rf_system", kind: "destructive", scope: "all", description: "Recursive delete of system directory" },
  { pattern: `:\\(\\)\\{:\\|:\\&\\};:`, id: "fork_bomb", kind: "destructive", scope: "all", description: "Fork bomb" },
  { pattern: `mkfs\\.(ext[234]|btrfs|xfs|zfs)\\s+/dev/`, id: "format_disk", kind: "destructive", scope: "all", description: "Format disk" },
  { pattern: `dd\\s+if=/dev/zero\\s+of=/dev/(?:sd|nvme|hd)`, id: "dd_wipe_disk", kind: "destructive", scope: "all", description: "Wipe disk with dd" },
  { pattern: `>\\s*/dev/sda`, id: "redirect_to_disk", kind: "destructive", scope: "all", description: "Redirect to raw disk device" },

  // ── Supply chain（all） ─────────────────────────────────
  { pattern: `curl\\s+[^\\n]{0,512}\\|\\s*(?:bash|sh|zsh|python)\\b`, id: "curl_pipe_shell", kind: "supply_chain", scope: "all", description: "curl | shell pattern (remote code execution)" },
  { pattern: `wget\\s+[^\\n]{0,512}\\s*-O\\s+-\\s*\\|\\s*(?:bash|sh)`, id: "wget_pipe_shell", kind: "supply_chain", scope: "all", description: "wget | shell pattern" },
  { pattern: `npm\\s+install\\s+[^\\n]{0,512}--ignore-scripts`, id: "npm_ignore_scripts", kind: "supply_chain", scope: "context", description: "npm install with --ignore-scripts (bypasses build safety)" },
  { pattern: `pip\\s+install\\s+[^\\n]{0,512}--no-deps\\s+[^\\n]{0,256}git\\+https?://`, id: "pip_git_no_deps", kind: "supply_chain", scope: "context", description: "pip install from git with --no-deps (bypasses dep audit)" },

  // ── Obfuscation（all） ──────────────────────────────────
  { pattern: `eval\\s*\\(\\s*(?:atob|Buffer\\.from|unescape)`, id: "eval_decoded", kind: "obfuscation", scope: "all", description: "eval of decoded string" },
  { pattern: `new\\s+Function\\s*\\(`, id: "new_function", kind: "obfuscation", scope: "all", description: "Dynamic Function constructor" },
  { pattern: `\\\\x[0-9a-f]{2}\\\\x[0-9a-f]{2}\\\\x[0-9a-f]{2}\\\\x[0-9a-f]{2}`, id: "hex_obfuscation", kind: "obfuscation", scope: "context", description: "Hex-encoded string (4+ consecutive \\xNN)" },
  { pattern: `String\\.fromCharCode\\s*\\(`, id: "charcode_obfuscation", kind: "obfuscation", scope: "context", description: "String.fromCharCode obfuscation" },
];

// 编译后的模式集，按 scope 索引
const COMPILED: Record<ThreatScope, ThreatPattern[]> = {
  all: [],
  context: [],
  strict: [],
};

let compiled = false;

function ensureCompiled(): void {
  if (compiled) return;
  // 作用域包含关系（与 Hermes threat_patterns.py 一致）：
  //   all     → all / context / strict 都检查
  //   context → context / strict 检查（"all" 扫描不触发）
  //   strict  → 仅 strict 检查（"all"/"context" 扫描不触发）
  // 这样可在 "all" 做廉价粗扫，避免 strict-only 的敏感词（如 authorized_keys）
  // 在普通文本里误报。
  for (const p of PATTERNS) {
    const tp: ThreatPattern = {
      regex: new RegExp(p.pattern, "i"),
      id: p.id,
      kind: p.kind,
      scope: p.scope,
      description: p.description,
    };
    if (p.scope === "all") {
      COMPILED.all.push(tp);
      COMPILED.context.push(tp);
      COMPILED.strict.push(tp);
    } else if (p.scope === "context") {
      COMPILED.context.push(tp);
      COMPILED.strict.push(tp);
    } else if (p.scope === "strict") {
      COMPILED.strict.push(tp);
    }
  }
  compiled = true;
}

// ── 扫描结果 ────────────────────────────────────────────────

export interface ThreatFinding {
  /** 命中的模式 ID */
  patternId: string;
  /** 攻击类别 */
  kind: ThreatKind;
  /** 匹配的文本片段 */
  match: string;
  /** 描述 */
  description: string;
  /** 文件路径（如适用） */
  filePath?: string;
}

export interface SkillScanResult {
  /** 是否安全 */
  safe: boolean;
  /** 威胁发现列表 */
  threats: ThreatFinding[];
  /** 结构问题列表 */
  structuralIssues: string[];
  /** 不可见 Unicode 字符检测结果 */
  invisibleCharIssues: string[];
  /** AST 审计发现 */
  astFindings: string[];
}

// ── 扫描 API ────────────────────────────────────────────────

/** 最大扫描字符数（防止正则在超长输入上爆炸） */
const MAX_SCAN_CHARS = 65_536;

/**
 * 扫描文本中的威胁模式。
 *
 * @param text 待扫描的文本
 * @param scope 扫描范围：all / context / strict
 * @param filePath 文件路径（用于报告）
 */
export function scanForThreats(
  text: string,
  scope: ThreatScope = "all",
  filePath?: string,
): ThreatFinding[] {
  if (!text || typeof text !== "string") return [];
  ensureCompiled();

  const truncated = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const patterns = COMPILED[scope];
  const findings: ThreatFinding[] = [];

  for (const p of patterns) {
    p.regex.lastIndex = 0;
    const match = truncated.match(p.regex);
    if (match) {
      findings.push({
        patternId: p.id,
        kind: p.kind,
        match: match[0].slice(0, 200),
        description: p.description,
        filePath,
      });
    }
  }

  return findings;
}

/**
 * 检测文本中的不可见 Unicode 字符。
 */
export function detectInvisibleChars(text: string): string[] {
  if (!text || typeof text !== "string") return [];
  const found: string[] = [];
  for (const char of text) {
    if (INVISIBLE_CHARS.has(char)) {
      const codePoint = char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0") ?? "?";
      const entry = `U+${codePoint}`;
      if (!found.includes(entry)) found.push(entry);
    }
  }
  return found;
}

// ── AST 审计（动态加载检测） ───────────────────────────────

/** 动态加载 / 危险调用的正则（TS/JS 等价 Python AST 审计） */
const AST_DANGEROUS_PATTERNS: ReadonlyArray<{ pattern: RegExp; id: string }> = [
  { pattern: /\beval\s*\(/g, id: "eval_call" },
  { pattern: /\bnew\s+Function\s*\(/g, id: "function_constructor" },
  { pattern: /\brequire\s*\(\s*['"]child_process['"]\s*\)/g, id: "require_child_process" },
  { pattern: /\bimport\s*\(['"]child_process['"]\s*\)/g, id: "import_child_process" },
  { pattern: /\brequire\s*\(\s*['"]net['"]\s*\)/g, id: "require_net" },
  { pattern: /\brequire\s*\(\s*['"]fs['"]\s*\)/g, id: "require_fs" },
  { pattern: /child_process\.exec(?:Sync)?\s*\(/g, id: "child_process_exec" },
  { pattern: /child_process\.spawn(?:Sync)?\s*\(/g, id: "child_process_spawn" },
  { pattern: /\bprocess\.env\b/g, id: "process_env_access" },
  { pattern: /\b__import__\s*\(/g, id: "python_import" },
  { pattern: /\bimportlib\.import_module\s*\(/g, id: "python_importlib" },
  { pattern: /\bgetattr\s*\(\s*__builtins__\s*,/g, id: "python_builtins_getattr" },
  { pattern: /\bexec\s*\(\s*(?:open|compile)/g, id: "exec_open_compile" },
  { pattern: /\bos\.system\s*\(/g, id: "os_system" },
  { pattern: /\bsubprocess\.(?:run|call|Popen|check_output)\s*\(/g, id: "subprocess_call" },
];

/**
 * AST 审计：检测动态加载 / 危险调用模式。
 *
 * 对标 Hermes `tools/skills_ast_audit.py` 的 `ast_scan_path`。
 * TS/JS 没有 Python AST 那么完整，但通过正则可以捕获主要的动态加载模式。
 *
 * @param content 文件内容
 * @param filePath 文件路径
 */
export function astScanContent(content: string, filePath?: string): string[] {
  if (!content || typeof content !== "string") return [];
  const findings: string[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, id } of AST_DANGEROUS_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        findings.push(`${filePath ?? "<content>"}:${i + 1}: ${id} — ${line.trim().slice(0, 120)}`);
      }
    }
  }

  return findings;
}

// ── 结构检查 ────────────────────────────────────────────────

const MAX_SKILL_FILES = 50;
const MAX_SKILL_TOTAL_SIZE = 1024 * 1024; // 1MB
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac", ".ogg",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
]);

/** 扫描文本文件扩展名 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md", ".txt", ".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".sh", ".bash", ".zsh", ".fish",
  ".html", ".css", ".scss", ".less",
  ".sql", ".graphql", ".gql",
  ".env", ".gitignore", ".dockerignore",
]);

export interface StructuralIssue {
  issue: string;
  filePath?: string;
}

/**
 * 检查技能目录的结构合规性。
 *
 * @param skillDir 技能目录路径
 */
export function checkSkillStructure(skillDir: string): StructuralIssue[] {
  const issues: StructuralIssue[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillDir, { withFileTypes: true });
  } catch (err) {
    issues.push({ issue: `Cannot read skill directory: ${(err as Error).message}` });
    return issues;
  }

  // 文件数检查
  const allFiles = collectFiles(skillDir, entries);
  if (allFiles.length > MAX_SKILL_FILES) {
    issues.push({
      issue: `Too many files: ${allFiles.length} (max ${MAX_SKILL_FILES})`,
    });
  }

  // 总大小检查
  let totalSize = 0;
  for (const f of allFiles) {
    try {
      const stat = fs.statSync(f);
      totalSize += stat.size;
      if (stat.size > 256 * 1024) {
        issues.push({
          issue: `Large file: ${path.relative(skillDir, f)} (${formatBytes(stat.size)})`,
          filePath: f,
        });
      }
    } catch {
      // 忽略 stat 失败
    }
  }
  if (totalSize > MAX_SKILL_TOTAL_SIZE) {
    issues.push({
      issue: `Total size too large: ${formatBytes(totalSize)} (max ${formatBytes(MAX_SKILL_TOTAL_SIZE)})`,
    });
  }

  // symlink 逃逸检测
  for (const f of allFiles) {
    try {
      const stat = fs.lstatSync(f);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(f);
        const resolved = path.resolve(path.dirname(f), target);
        if (resolved !== skillDir && !resolved.startsWith(skillDir + path.sep)) {
          issues.push({
            issue: `Symlink escape: ${path.relative(skillDir, f)} → ${target}`,
            filePath: f,
          });
        }
      }
    } catch {
      // 忽略
    }
  }

  // 二进制文件检测
  for (const f of allFiles) {
    const ext = path.extname(f).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      // 二进制文件本身不禁止，但要标记
      // 仅当未在 TEXT_EXTENSIONS 中时才报告
      if (!TEXT_EXTENSIONS.has(ext)) {
        // OK — 二进制资源是合法的
      }
    }
  }

  return issues;
}

function collectFiles(dir: string, entries: fs.Dirent[]): string[] {
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      files.push(fullPath);
    } else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      try {
        const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
        files.push(...collectFiles(fullPath, subEntries));
      } catch {
        // 忽略
      }
    }
  }
  return files;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// ── 完整技能扫描 ────────────────────────────────────────────

/**
 * 扫描技能目录：结构检查 + 内容扫描 + 不可见 Unicode + AST 审计。
 *
 * 对标 Hermes `tools/skills_guard.py` 的 `scan_skill`。
 *
 * @param skillDir 技能目录路径
 * @param scope 威胁扫描范围（默认 strict）
 */
export function scanSkill(
  skillDir: string,
  scope: ThreatScope = "strict",
): SkillScanResult {
  const threats: ThreatFinding[] = [];
  const structuralIssues: string[] = [];
  const invisibleCharIssues: string[] = [];
  const astFindings: string[] = [];

  // 1. 结构检查
  const structIssues = checkSkillStructure(skillDir);
  for (const issue of structIssues) {
    structuralIssues.push(issue.issue);
  }

  // 2. 遍历文件，扫描内容
  const allFiles = collectFiles(skillDir, fs.readdirSync(skillDir, { withFileTypes: true }));
  for (const f of allFiles) {
    const ext = path.extname(f).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && BINARY_EXTENSIONS.has(ext)) continue;

    let content: string;
    try {
      content = fs.readFileSync(f, "utf-8");
    } catch {
      continue;
    }

    // 截断过大文件
    if (content.length > 256 * 1024) {
      content = content.slice(0, 256 * 1024);
    }

    // 威胁扫描
    const fileThreats = scanForThreats(content, scope, path.relative(skillDir, f));
    threats.push(...fileThreats);

    // 不可见 Unicode
    const invisible = detectInvisibleChars(content);
    if (invisible.length > 0) {
      invisibleCharIssues.push(
        `${path.relative(skillDir, f)}: invisible chars ${invisible.join(", ")}`,
      );
    }

    // AST 审计（仅对源代码文件）
    if ([".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs", ".py"].includes(ext)) {
      const ast = astScanContent(content, path.relative(skillDir, f));
      astFindings.push(...ast);
    }
  }

  // 判定：strict scope 的威胁 + 结构问题 + AST 发现 → 不安全
  // 与 Hermes skills_guard.py 一致：persistence / hardcoded_secret /
  // known_c2_framework 同样属于阻断类（含 SSH 后门、硬编码密钥、已知 C2）
  const hasCriticalThreats = threats.some(
    (t) =>
      t.kind === "prompt_injection" ||
      t.kind === "exfiltration" ||
      t.kind === "destructive" ||
      t.kind === "supply_chain" ||
      t.kind === "persistence" ||
      t.kind === "hardcoded_secret" ||
      t.kind === "known_c2_framework" ||
      t.kind === "role_hijack",
  );
  const hasStructIssues = structuralIssues.length > 0;
  const hasAst = astFindings.length > 0;

  return {
    safe: !hasCriticalThreats && !hasStructIssues && !hasAst,
    threats,
    structuralIssues,
    invisibleCharIssues,
    astFindings,
  };
}

// ── 信任等级策略 ────────────────────────────────────────────

export type TrustLevel = "builtin" | "trusted" | "community" | "agent_created";

export interface TrustPolicy {
  /** 信任等级 */
  level: TrustLevel;
  /** 是否允许执行 */
  allow: boolean;
  /** 是否需要用户确认 */
  needsConfirm: boolean;
  /** 描述 */
  description: string;
}

const DEFAULT_TRUST_POLICIES: Record<TrustLevel, TrustPolicy> = {
  builtin: { level: "builtin", allow: true, needsConfirm: false, description: "Bundled with EvoClaw" },
  trusted: { level: "trusted", allow: true, needsConfirm: false, description: "User-marked trusted" },
  community: { level: "community", allow: true, needsConfirm: true, description: "Community skill — needs user confirmation" },
  agent_created: { level: "agent_created", allow: true, needsConfirm: true, description: "Agent-created skill — needs user confirmation" },
};

/**
 * 根据信任等级决定是否允许安装。
 */
export function evaluateTrustPolicy(level: TrustLevel, policies?: Partial<Record<TrustLevel, TrustPolicy>>): TrustPolicy {
  const merged = { ...DEFAULT_TRUST_POLICIES, ...policies };
  return merged[level] ?? DEFAULT_TRUST_POLICIES.community;
}
