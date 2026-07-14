/**
 * Coding-context — 编码姿态检测与工作区简报注入。
 *
 * 对标 Hermes `agent/coding_context.py`：
 *   当 cwd 是代码工作区（git repo 或含 pyproject.toml/package.json/Cargo.toml 等
 *   manifest，或顶层有 .py/.ts/.go 等源文件）时，切换到"编码姿态"：
 *   1. 注入编码简报到 stable system prompt 层
 *   2. 注入工作区快照（git 分支/状态/最近提交 + 项目清单）
 *   3. 提供验证命令（test/lint/typecheck）给模型，省去每次重新发现
 *
 * 缓存安全：模式在 prompt-build 时解析一次，烘焙进 stable tier，
 *   不会 per-turn 重新探测（否则会击穿 prompt cache）。
 *
 * 模式（config `agent.coding_context`）：
 *   - auto（默认）：交互表面 + cwd 是代码工作区时启用
 *   - focus：auto + 收窄 toolset 到 coding + enabled MCP
 *   - on：强制启用（即使非工作区）
 *   - off：禁用
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

/** 编码 toolset 标识 */
export const CODING_TOOLSET = "coding";

/** 交互编码表面（messaging 平台不在此列） */
const INTERACTIVE_CODING_PLATFORMS = new Set(["cli", "tui", "acp", "desktop", ""]);

/** 项目根标识文件 — 命中即视为代码工作区（无需 git） */
export const PROJECT_MARKERS: ReadonlyArray<string> = [
  "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt",
  "package.json", "tsconfig.json", "deno.json",
  "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
  "Gemfile", "composer.json", "mix.exs", "pubspec.yaml",
  "CMakeLists.txt", "Makefile", "Dockerfile",
  "AGENTS.md", "CLAUDE.md", ".cursorrules",
];

/** Agent 指令文件（与 manifest 分开呈现在快照里） */
const CONTEXT_FILES: ReadonlyArray<string> = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];

/** 源文件扩展名 — git repo 含这些扩展才视为代码工作区（避免 notes/writing 误判） */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".py", ".pyi", ".ipynb", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".rb", ".php", ".c", ".h",
  ".cc", ".cpp", ".hpp", ".cs", ".swift", ".m", ".mm", ".dart", ".ex", ".exs",
  ".lua", ".sh", ".bash", ".zsh", ".sql", ".vue", ".svelte", ".r", ".jl",
  ".hs", ".clj", ".erl", ".pl",
]);

/** 扫描时跳过的目录（deps/build/vcs/venv 噪声） */
export const CODE_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", "venv", ".venv", "__pycache__", "dist", "build",
  "target", ".next", ".turbo", "vendor",
]);

/** 扫描条目上限（编码工作区在前几条就能识别） */
const CODE_SCAN_MAX_ENTRIES = 500;

/** Lockfile → package manager（按优先级检查） */
const PY_LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ["uv.lock", "uv"],
  ["poetry.lock", "poetry"],
  ["Pipfile.lock", "pipenv"],
];
const JS_LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** package.json scripts / Makefile targets 值得呈现为 verify 命令 */
const VERIFY_TARGETS: ReadonlyArray<string> = [
  "test", "tests", "lint", "typecheck", "check", "build", "fmt", "format",
];
const MAX_VERIFY_COMMANDS = 8;
const MAX_FACT_FILE_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 2500;

/** 编码姿态简报（对标 Hermes CODING_AGENT_GUIDANCE） */
export const CODING_AGENT_GUIDANCE = `You are a coding agent pairing with the user inside their codebase. Operate like a careful senior engineer.

Gather context first:
- Read the relevant files with read_file and locate code with search_files before changing anything. Trace a symbol to its definition and usages rather than guessing its shape.
- Batch independent lookups: when several reads/searches don't depend on each other, issue them together in one turn instead of one at a time.
- Never invent files, symbols, APIs, or imports. If you haven't seen it in the repo, go look. Don't assume a library is available — check the project manifest (pyproject.toml / package.json / Cargo.toml / go.mod) and how neighbouring files import it.

Make changes through the tools, not the chat:
- Edit with patch/write_file. Do NOT print code blocks to the user as a substitute for editing — apply the change, then summarise it. Only show code when the user explicitly asks to see it.
- Match the project's existing style and conventions; AGENTS.md / CLAUDE.md / .cursorrules already in context win over your defaults. Touch only what the task needs — no drive-by refactors, renames, or reformatting — and add any imports/dependencies your code requires.
- If an edit fails to apply, re-read the file to get the current exact contents before retrying — don't repeat a stale patch. If the same region fails twice, rewrite the enclosing function or file with write_file instead of attempting a third patch.

Verify, and know when to stop:
- Use terminal for git, builds, tests, and inspection. Run the relevant tests/linter/build and confirm they pass before claiming the work is done.
- Terminal state persists across calls: current directory and exported environment variables carry forward. Activate a virtualenv or export setup vars once, then reuse that state instead of re-sourcing it before every test command.
- Fix root causes, not symptoms: when you find a bug, check sibling call paths for the same flaw and fix the class, not just the reported site.
- When fixing linter/type errors on a file, stop after about three attempts on the same file and ask the user rather than looping.
- Track multi-step work with todo. Reference code as path:line instead of pasting whole files.

Respect the user's repo: don't commit, push, or rewrite history unless asked, and never read, print, or commit secrets — leave .env and credential files alone unless the user explicitly asks. The Workspace block below is a snapshot from session start — re-run git status/git branch before relying on it. Be concise: lead with the change or answer, not a preamble.`;

// ── Context profiles ────────────────────────────────────────

export interface ContextProfile {
  readonly name: string;
  readonly toolset: string | null;
  readonly guidance: string;
  readonly modelHint: string | null;
  readonly memoryPolicy: string;
  readonly compactSkillCategories: ReadonlyArray<string>;
}

export const GENERAL_PROFILE: ContextProfile = {
  name: "general",
  toolset: null,
  guidance: "",
  modelHint: null,
  memoryPolicy: "default",
  compactSkillCategories: [],
};

/** 非编码技能类别 — focus 模式下 demote 到 names-only */
const NON_CODING_SKILL_CATEGORIES: ReadonlyArray<string> = [
  "apple", "communication", "cooking", "creative", "email", "finance",
  "gaming", "gifs", "health", "media", "music", "note-taking",
  "productivity", "shopping", "smart-home", "social-media", "travel",
  "yuanbao",
];

export const CODING_PROFILE: ContextProfile = {
  name: "coding",
  toolset: CODING_TOOLSET,
  guidance: CODING_AGENT_GUIDANCE,
  modelHint: "coding",
  memoryPolicy: "project",
  compactSkillCategories: NON_CODING_SKILL_CATEGORIES,
};

const PROFILES: Record<string, ContextProfile> = {
  general: GENERAL_PROFILE,
  coding: CODING_PROFILE,
};

export function getProfile(name: string): ContextProfile {
  return PROFILES[name] ?? GENERAL_PROFILE;
}

// ── RuntimeMode（解析后的会话姿态，不可变） ─────────────────

export interface RuntimeMode {
  readonly profile: ContextProfile;
  readonly surface: string;
  readonly cwd: string;
  readonly configMode: "auto" | "focus" | "on" | "off";
  readonly model: string | null;
  readonly instructions: string;
}

export function isCodingMode(mode: RuntimeMode): boolean {
  return mode.profile.name === "coding";
}

/**
 * 解析会话的编码姿态。廉价 — 几次 stat 调用。
 *
 * 在 prompt-build 时调用一次并缓存结果。Detection 本身不缓存
 * （长生命周期进程可服务不同 cwd 的会话）。
 */
export function resolveRuntimeMode(opts: {
  platform?: string | null;
  cwd?: string | null;
  config?: Record<string, unknown> | null;
  model?: string | null;
}): RuntimeMode {
  const resolvedCwd = opts.cwd ?? process.cwd();
  const mode = parseCodingMode(opts.config);
  const name = detectProfileName(mode, opts.platform ?? "", resolvedCwd);
  return {
    profile: getProfile(name),
    surface: opts.platform ?? "",
    cwd: resolvedCwd,
    configMode: mode,
    model: opts.model ?? null,
    instructions: parseCodingInstructions(opts.config),
  };
}

function parseCodingMode(config: Record<string, unknown> | null | undefined): RuntimeMode["configMode"] {
  const raw = ((config?.agent as Record<string, unknown>) ?? {}).coding_context ?? "auto";
  const mode = String(raw).trim().toLowerCase();
  if (mode === "focus" || mode === "strict" || mode === "lean") return "focus";
  if (["on", "true", "yes", "1", "always"].includes(mode)) return "on";
  if (["off", "false", "no", "0", "never"].includes(mode)) return "off";
  return "auto";
}

function parseCodingInstructions(config: Record<string, unknown> | null | undefined): string {
  const raw = ((config?.agent as Record<string, unknown>) ?? {}).coding_instructions ?? "";
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s).trim()).filter(Boolean).join("\n");
  }
  return String(raw ?? "").trim();
}

function detectProfileName(mode: RuntimeMode["configMode"], platform: string, cwdStr: string): string {
  if (mode === "off") return GENERAL_PROFILE.name;
  // "on" 和 "focus" 都是用户显式 opt-in → 强制 coding profile。
  // 区别在于 configMode 保留 "focus" 让下游收窄 toolset（见 ContextProfile.toolset）。
  if (mode === "on" || mode === "focus") return CODING_PROFILE.name;
  if (platform && !INTERACTIVE_CODING_PLATFORMS.has(platform.trim().toLowerCase())) {
    return GENERAL_PROFILE.name;
  }
  const cwd = path.resolve(cwdStr);
  if (markerRoot(cwd) !== null) return CODING_PROFILE.name;
  const root = gitRoot(cwd);
  const home = homeDir();
  const effectiveRoot = root && home && root === home ? null : root;
  if (effectiveRoot !== null && hasCodeFiles(effectiveRoot)) {
    return CODING_PROFILE.name;
  }
  return GENERAL_PROFILE.name;
}

// ── 工作区检测 helpers ─────────────────────────────────────

function gitRoot(cwd: string): string | null {
  let current = path.resolve(cwd);
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function homeDir(): string | null {
  try {
    return require("node:os").homedir();
  } catch {
    return null;
  }
}

function markerRoot(cwd: string): string | null {
  let current = path.resolve(cwd);
  const home = homeDir();
  for (let depth = 0; depth <= 6; depth++) {
    if (current === home) {
      // $HOME 下的 marker 是用户全局配置，不是项目根
    } else {
      for (const marker of PROJECT_MARKERS) {
        if (fs.existsSync(path.join(current, marker))) return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function hasCodeFiles(root: string): boolean {
  let seen = 0;
  const stack: Array<{ dir: string; isRoot: boolean }> = [{ dir: root, isRoot: true }];
  while (stack.length > 0) {
    const { dir, isRoot } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen++;
      if (seen > CODE_SCAN_MAX_ENTRIES) return false;
      try {
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (CODE_EXTENSIONS.has(ext)) return true;
        } else if (isRoot && entry.isDirectory() &&
          !CODE_SCAN_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          stack.push({ dir: path.join(dir, entry.name), isRoot: false });
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

// ── 项目清单 / verify 命令探测 ─────────────────────────────

export interface ProjectFacts {
  readonly manifests: string[];
  readonly packageManagers: string[];
  readonly verifyCommands: string[];
  readonly contextFiles: string[];
}

/**
 * 探测项目清单、包管理器、验证命令、上下文文件。
 * 廉价：stat + 几个小文件读。是 prompt 快照与 gateway UI 的单一真相源。
 */
export function detectProjectFacts(root: string): ProjectFacts {
  const manifests = PROJECT_MARKERS.filter(
    (m) => !CONTEXT_FILES.includes(m) && fs.existsSync(path.join(root, m)),
  );

  const packageManagers: string[] = [];
  for (const [lock, pm] of [...PY_LOCKFILES, ...JS_LOCKFILES]) {
    if (fs.existsSync(path.join(root, lock))) packageManagers.push(pm);
  }

  const verify: string[] = [];
  if (fs.existsSync(path.join(root, "scripts", "run_tests.sh"))) {
    verify.push("scripts/run_tests.sh");
  }
  if (fs.existsSync(path.join(root, "package.json"))) {
    let scripts: Record<string, unknown> = {};
    try {
      const content = readSmall(path.join(root, "package.json"));
      if (content) scripts = (JSON.parse(content).scripts ?? {}) as Record<string, unknown>;
    } catch {
      scripts = {};
    }
    const jsPm = JS_LOCKFILES.find(([lock]) => fs.existsSync(path.join(root, lock)))?.[1] ?? "npm";
    for (const target of VERIFY_TARGETS) {
      if (target in scripts) verify.push(`${jsPm} run ${target}`);
    }
  }
  if (fs.existsSync(path.join(root, "pytest.ini")) ||
    readSmall(path.join(root, "pyproject.toml")).includes("[tool.pytest")) {
    verify.push("pytest");
  }
  const makefile = readSmall(path.join(root, "Makefile"));
  if (makefile) {
    for (const target of VERIFY_TARGETS) {
      const re = new RegExp(`^${escapeRegex(target)}\\s*:`, "m");
      if (re.test(makefile)) verify.push(`make ${target}`);
    }
  }

  const dedupVerify = [...new Set(verify)].slice(0, MAX_VERIFY_COMMANDS);
  const contextFiles = CONTEXT_FILES.filter((c) => fs.existsSync(path.join(root, c)));

  return {
    manifests,
    packageManagers: [...new Set(packageManagers)],
    verifyCommands: dedupVerify,
    contextFiles,
  };
}

function readSmall(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FACT_FILE_BYTES) return "";
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── 工作区快照（注入 stable system prompt） ────────────────

/**
 * 构建工作区快照块，注入 stable system prompt tier。
 *
 * 包含 git 状态（分支/状态/最近提交）+ 项目清单（manifest/包管理器/verify 命令）。
 * marker-only（非 git）项目也能获得快照。
 *
 * 缓存安全：在 prompt-build 时构建一次，字符串须保持字节稳定。
 */
export function buildCodingWorkspaceBlock(cwd?: string | null): string {
  const resolvedCwd = path.resolve(cwd ?? process.cwd());
  const gitR = gitRoot(resolvedCwd);
  const root = gitR ?? markerRoot(resolvedCwd);
  if (root === null) return "";

  const lines: string[] = [
    "Workspace (snapshot at session start — re-check with `git` before acting on it):",
    `- Root: ${root}`,
  ];

  if (gitR !== null) {
    const status = git(gitR, "status", "--porcelain=2", "--branch");
    const parsed = parseGitStatus(status);
    const head = parsed.branch.head;
    if (head && head !== "(detached)") {
      let line = `- Branch: ${head}`;
      if (parsed.branch.upstream) {
        line += ` → ${parsed.branch.upstream}`;
        const ahead = parsed.branch.ahead ?? "0";
        const behind = parsed.branch.behind ?? "0";
        if (ahead !== "0" || behind !== "0") {
          line += ` (ahead ${ahead}, behind ${behind})`;
        }
      }
      lines.push(line);
    } else if (head === "(detached)") {
      lines.push("- Branch: (detached HEAD)");
    }

    const dirty: string[] = [];
    if (parsed.counts.staged) dirty.push(`${parsed.counts.staged} staged`);
    if (parsed.counts.modified) dirty.push(`${parsed.counts.modified} modified`);
    if (parsed.counts.untracked) dirty.push(`${parsed.counts.untracked} untracked`);
    if (parsed.counts.conflicts) dirty.push(`${parsed.counts.conflicts} conflicts`);
    lines.push(`- Status: ${dirty.length > 0 ? dirty.join(", ") : "clean"}`);

    const recent = git(gitR, "log", "-3", "--pretty=%h %s");
    if (recent) {
      lines.push("- Recent commits:");
      for (const c of recent.split("\n")) {
        if (c) lines.push(`    ${c}`);
      }
    }
  }

  // 项目清单
  const facts = detectProjectFacts(root);
  if (facts.manifests.length > 0) {
    let line = `- Project: ${facts.manifests.slice(0, 6).join(", ")}`;
    if (facts.packageManagers.length > 0) {
      line += ` (${facts.packageManagers.join("/")})`;
    }
    lines.push(line);
  }
  if (facts.verifyCommands.length > 0) {
    lines.push(`- Verify: ${facts.verifyCommands.join("; ")}`);
  }
  if (facts.contextFiles.length > 0) {
    lines.push(`- Context files: ${facts.contextFiles.join(", ")}`);
  }

  return lines.join("\n");
}

function git(cwd: string, ...args: string[]): string {
  try {
    // 用 execFileSync（不经过 shell）而非 execSync，避免 cwd 含 `"`/`&`
    // 等 shell 元字符时的命令注入风险。args 作为数组传递，无需转义。
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return "";
  }
}

interface ParsedStatus {
  branch: { head?: string; upstream?: string; ahead?: string; behind?: string };
  counts: { staged: number; modified: number; untracked: number; conflicts: number };
}

function parseGitStatus(porcelain: string): ParsedStatus {
  const result: ParsedStatus = {
    branch: {},
    counts: { staged: 0, modified: 0, untracked: 0, conflicts: 0 },
  };
  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head")) {
      result.branch.head = line.split(/\s+/).slice(2).join(" ");
    } else if (line.startsWith("# branch.upstream")) {
      result.branch.upstream = line.split(/\s+/).slice(2).join(" ");
    } else if (line.startsWith("# branch.ab")) {
      const parts = line.split(/\s+/);
      result.branch.ahead = parts[2]?.replace(/^\+/, "");
      result.branch.behind = parts[3]?.replace(/^-/, "");
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.split(/\s+/)[1] ?? "";
      // xy 格式为两个字符（如 "M.", ".D", "MM"），空字符串或长度不足时不应计入 staged/modified
      if (xy.length >= 1 && xy[0] !== ".") result.counts.staged++;
      if (xy.length >= 2 && xy[1] !== ".") result.counts.modified++;
    } else if (line.startsWith("u ")) {
      result.counts.conflicts++;
    } else if (line.startsWith("? ")) {
      result.counts.untracked++;
    }
  }
  return result;
}

// ── Stable system prompt blocks（brief + workspace） ───────

/**
 * 返回当前姿态的 stable system-prompt blocks（编码姿态返回 brief+workspace，通用返回空）。
 *
 * `model` 用于 steering 编辑格式 nudge 到模型所属家族。
 */
export function codingSystemBlocks(opts: {
  platform?: string | null;
  cwd?: string | null;
  config?: Record<string, unknown> | null;
  model?: string | null;
}): string[] {
  const mode = resolveRuntimeMode(opts);
  if (!isCodingMode(mode)) return [];
  const blocks: string[] = [];
  if (mode.profile.guidance) {
    let brief = mode.profile.guidance;
    const editLine = editFormatLine(opts.model ?? null);
    if (editLine) brief = `${brief}\n${editLine}`;
    blocks.push(brief);
  }
  const workspace = buildCodingWorkspaceBlock(mode.cwd);
  if (workspace) blocks.push(workspace);
  if (mode.instructions) {
    blocks.push(`Operator instructions (from config):\n${mode.instructions}`);
  }
  return blocks;
}

/** Per-model 编辑格式 steering（patch vs replace） */
const EDIT_FORMAT_GUIDANCE: Record<string, { needles: string[]; line: string }> = {
  patch: {
    needles: ["gpt", "codex"],
    line: "- Edit format: author new files with write_file; for edits to existing code use patch with mode='patch' (V4A diff) — including single-file edits. It's the edit format you handle most reliably.",
  },
  replace: {
    needles: [
      "claude", "sonnet", "opus", "haiku",
      "gemini", "gemma", "deepseek", "qwen", "kimi", "glm", "grok",
      "hermes", "llama", "mistral", "devstral", "minimax",
    ],
    line: "- Edit format: author new files with write_file; for edits to existing code prefer patch in mode='replace' — match a unique snippet and swap it. Reach for mode='patch' (V4A) only when an edit genuinely spans several files at once.",
  },
};

export function editFormatLine(model: string | null): string {
  if (!model) return "";
  const lowered = model.toLowerCase();
  for (const { needles, line } of Object.values(EDIT_FORMAT_GUIDANCE)) {
    if (needles.some((n) => lowered.includes(n))) return line;
  }
  return "";
}

/**
 * 是否在编码姿态（便捷封装）。
 */
export function isCodingContext(opts: {
  platform?: string | null;
  cwd?: string | null;
  config?: Record<string, unknown> | null;
}): boolean {
  return isCodingMode(resolveRuntimeMode(opts));
}

/**
 * focus 模式下要 demote 到 names-only 的技能类别。
 * 非 focus / 非编码姿态返回空集。
 */
export function codingCompactSkillCategories(opts: {
  platform?: string | null;
  cwd?: string | null;
  config?: Record<string, unknown> | null;
}): ReadonlySet<string> {
  const mode = resolveRuntimeMode(opts);
  if (!isCodingMode(mode) || mode.configMode !== "focus") return new Set();
  return new Set(mode.profile.compactSkillCategories);
}

/**
 * 给非 prompt 消费者（如 desktop verify UI）的结构化项目清单。
 * 工作区外返回 null。
 */
export function projectFactsFor(cwd?: string | null): {
  root: string;
  manifests: string[];
  packageManagers: string[];
  verifyCommands: string[];
  contextFiles: string[];
} | null {
  const resolved = path.resolve(cwd ?? process.cwd());
  const root = gitRoot(resolved) ?? markerRoot(resolved);
  if (root === null) return null;
  const f = detectProjectFacts(root);
  return {
    root,
    manifests: f.manifests,
    packageManagers: f.packageManagers,
    verifyCommands: f.verifyCommands,
    contextFiles: f.contextFiles,
  };
}
