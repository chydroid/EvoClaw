/**
 * Dev Experience Tools — 开发体验工具集
 *
 * 提供三个开发态高频工具，用于在对话中直接验证代码改动：
 *   - run_tests: 运行测试（自动检测 vitest/jest/pytest）
 *   - lint: 运行 linter（自动检测 eslint/prettier）
 *   - codebase_search: 轻量级语义代码搜索（基于文本匹配，无嵌入模型依赖）
 *
 * 设计原则：
 *   - 不依赖嵌入模型 / onnxruntime（避免重量级原生依赖）
 *   - 命令通过 spawn 执行，超时可控
 *   - 输出截断保护，避免单次工具返回过大
 */

import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import type { AgentModelExecutor } from "@evoclaw/agent";

/** 转义正则元字符，用于安全的字面量匹配 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 简化 glob 匹配：支持 * 和 ? */
function matchGlob(filename: string, pattern: string): boolean {
  // 先转义正则元字符（除 * 和 ?），再替换 glob 通配符
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(regex, "i").test(filename);
}

/** 提取最佳代码片段：找到关键词命中度最高的行，返回周围上下文 */
function extractSnippet(
  content: string,
  terms: string[],
  maxLen: number,
): { text: string; lines: string } {
  const lines = content.split("\n");
  let bestLine = 0;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lower.includes(term)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  const start = Math.max(0, bestLine - 2);
  const end = Math.min(lines.length, bestLine + 3);
  const snippet = lines.slice(start, end).join("\n");
  return {
    text: snippet.length > maxLen ? snippet.substring(0, maxLen) + "..." : snippet,
    lines: `${start + 1}-${end}`,
  };
}

/** 异步运行命令，捕获 stdout/stderr，超时控制 */
function runCommand(
  cmd: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        sigkillTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }, 5000);
        sigkillTimer.unref();
        resolve({ stdout, stderr, code: null, timedOut: true });
      }
    }, options.timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > 5 * 1024 * 1024) {
        try { child.stdout?.destroy(); } catch { /* ignore */ }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > 5 * 1024 * 1024) {
        try { child.stderr?.destroy(); } catch { /* ignore */ }
      }
    });

    child.stdout?.on("error", (err: Error) => {
      process.stderr.write(`[dev-tools] stdout error: ${err.message}\n`);
    });

    child.stderr?.on("error", (err: Error) => {
      process.stderr.write(`[dev-tools] stderr error: ${err.message}\n`);
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve({ stdout, stderr, code, timedOut: false });
      }
    });

    child.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve({ stdout, stderr: stderr + " (spawn error)", code: -1, timedOut: false });
      }
    });
  });
}

/** 读取并解析 package.json 的 devDependencies，用于框架自动检测 */
function readDevDeps(dir: string): Record<string, string> {
  try {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    }
  } catch { /* ignore */ }
  return {};
}

/** 在 dir 起向上查找包含指定文件的目录（用于检测框架配置） */
function findConfigUpward(
  startDir: string,
  filenames: string[],
  maxUp = 4,
): string | null {
  let dir = startDir;
  for (let i = 0; i <= maxUp; i++) {
    for (const name of filenames) {
      if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function registerDevTools(
  executor: AgentModelExecutor,
  options?: { workspaceRoot?: string },
): void {
  const workspaceRoot =
    options?.workspaceRoot || path.resolve(__dirname, "..", "..", "..", "..");

  // ── run_tests: 运行测试 ─────────────────────────────────────
  executor.registerTool(
    "run_tests",
    {
      name: "run_tests",
      description:
        "Run tests for the project or a specific test file. Auto-detects test framework (vitest/jest/pytest). Returns pass/fail counts and failure details. Use this to verify code changes.",
      parameters: {
        target: {
          type: "string",
          description:
            "Test file path or directory to run (optional, default: all tests). Pass a specific file like 'packages/agent/src/code-intelligence.test.ts' to run a single test.",
        },
        framework: {
          type: "string",
          description:
            "Force a specific test framework: 'vitest', 'jest', 'pytest', 'auto' (default: auto-detect)",
        },
        watch: {
          type: "boolean",
          description: "Run in watch mode (default: false)",
        },
        timeout: {
          type: "string",
          description: "Timeout in seconds (default: 120)",
        },
      },
    },
    async (params: Record<string, unknown>) => {
      const target = params.target ? String(params.target) : "";
      const forcedFramework = params.framework ? String(params.framework).toLowerCase() : "auto";
      const watch = params.watch === true;
      const timeoutSec = Math.max(1, Math.min(parseInt(String(params.timeout ?? "120"), 10) || 120, 1200));

      // 路径校验：阻止 path traversal 逃逸工作区
      let targetAbs = workspaceRoot;
      if (target) {
        if (target.startsWith("-")) {
          return { success: false, error: "target cannot start with '-'" };
        }
        targetAbs = path.resolve(workspaceRoot, target);
        if (!targetAbs.startsWith(workspaceRoot + path.sep) && targetAbs !== workspaceRoot) {
          return { success: false, error: `Path traversal blocked: ${target}` };
        }
      }
      const detectDir = fs.existsSync(targetAbs) && fs.statSync(targetAbs).isDirectory()
        ? targetAbs
        : workspaceRoot;

      // ── 框架自动检测 ──
      let framework = forcedFramework;
      if (framework === "auto") {
        const devDeps = readDevDeps(detectDir);
        const hasVitestConfig =
          findConfigUpward(detectDir, ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"]) !== null;
        const hasJestConfig =
          findConfigUpward(detectDir, ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs"]) !== null;
        const hasPytestConfig =
          findConfigUpward(detectDir, ["pytest.ini", "setup.cfg", "pyproject.toml"]) !== null;

        if (hasVitestConfig || "vitest" in devDeps) {
          framework = "vitest";
        } else if (hasJestConfig || "jest" in devDeps) {
          framework = "jest";
        } else if (hasPytestConfig) {
          // 进一步检查 pyproject.toml 是否含 [tool.pytest]
          framework = "pytest";
        } else {
          return {
            success: false,
            error: "Could not auto-detect test framework. Specify 'framework' parameter explicitly (vitest/jest/pytest).",
            detectDir,
          };
        }
      }

      // ── 构建命令 ──
      let cmd: string;
      let args: string[];
      const isWin = process.platform === "win32";
      const npx = isWin ? "npx.cmd" : "npx";

      if (framework === "vitest") {
        if (watch) {
          cmd = npx;
          args = ["vitest", target].filter(Boolean);
        } else {
          cmd = npx;
          args = ["vitest", "run", target, "--reporter=verbose"].filter(Boolean);
        }
      } else if (framework === "jest") {
        cmd = npx;
        args = ["jest", target, "--verbose"].filter(Boolean);
      } else if (framework === "pytest") {
        cmd = isWin ? "python" : "python3";
        args = ["-m", "pytest", target, "-v"].filter(Boolean);
      } else {
        return { success: false, error: `Unsupported framework: ${framework}` };
      }

      // ── 执行 ──
      const result = await runCommand(cmd, args, {
        cwd: workspaceRoot,
        timeoutMs: timeoutSec * 1000,
      });

      const combinedOutput = result.stdout + "\n" + result.stderr;

      // ── 解析测试结果 ──
      let passed = 0;
      let failed = 0;
      let skipped = 0;
      const failures: Array<{ name: string; file: string; error: string }> = [];

      if (framework === "vitest") {
        // 格式: "Tests  45 passed | 2 failed | 1 skipped"
        const m = combinedOutput.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?/);
        if (m) {
          passed = parseInt(m[1] || "0", 10);
          failed = parseInt(m[2] || "0", 10);
          skipped = parseInt(m[3] || "0", 10);
        }
      } else if (framework === "jest") {
        // 格式: "Tests: 45 passed, 2 failed, 1 skipped"
        const m = combinedOutput.match(/Tests:\s+(\d+)\s+passed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?/);
        if (m) {
          passed = parseInt(m[1] || "0", 10);
          failed = parseInt(m[2] || "0", 10);
          skipped = parseInt(m[3] || "0", 10);
        }
      } else if (framework === "pytest") {
        // 格式: "===== 45 passed, 2 failed, 1 skipped in 12.3s ====="
        const m = combinedOutput.match(/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?/);
        if (m) {
          passed = parseInt(m[1] || "0", 10);
          failed = parseInt(m[2] || "0", 10);
          skipped = parseInt(m[3] || "0", 10);
        }
      }

      // 提取失败测试详情（最多 10 个）
      const failureBlocks = combinedOutput.split(/\n(?=FAIL|✗|×|FAILED|FAIL\s)/);
      for (const block of failureBlocks) {
        if (!/FAIL|✗|×|FAILED/i.test(block)) continue;
        if (failures.length >= 10) break;
        const firstLine = block.split("\n")[0].slice(0, 200);
        const errMatch = block.match(/(?:Error|error)[:\s]([^\n]{1,300})/);
        failures.push({
          name: firstLine,
          file: target || "(multiple)",
          error: errMatch ? errMatch[1].trim() : block.split("\n").slice(0, 3).join(" | ").slice(0, 300),
        });
      }

      const durationMatch = combinedOutput.match(/(\d+\.?\d*)\s*s(?:\s|$|,)/);
      return {
        success: result.code === 0 && !result.timedOut,
        framework,
        passed,
        failed,
        skipped,
        duration: durationMatch ? `${durationMatch[1]}s` : undefined,
        timedOut: result.timedOut,
        exitCode: result.code,
        failures,
        output: combinedOutput.slice(-2000),
      };
    },
  );

  // ── lint: 运行 linter ───────────────────────────────────────
  executor.registerTool(
    "lint",
    {
      name: "lint",
      description:
        "Run linter (eslint/prettier) on files or directories. Auto-detects config. Returns error/warning counts and fix suggestions. Use --fix to auto-fix issues.",
      parameters: {
        target: {
          type: "string",
          description: "File or directory to lint (default: current workspace)",
        },
        fix: {
          type: "boolean",
          description: "Auto-fix issues (default: false)",
        },
        linter: {
          type: "string",
          description: "Force a specific linter: 'eslint', 'prettier', 'auto' (default: auto-detect)",
        },
      },
    },
    async (params: Record<string, unknown>) => {
      const target = params.target ? String(params.target) : ".";
      const fix = params.fix === true;
      const forcedLinter = params.linter ? String(params.linter).toLowerCase() : "auto";

      // 路径校验：阻止 path traversal 逃逸工作区
      if (target.startsWith("-")) {
        return { success: false, error: "target cannot start with '-'" };
      }
      const targetAbs = path.resolve(workspaceRoot, target);
      if (!targetAbs.startsWith(workspaceRoot + path.sep) && targetAbs !== workspaceRoot) {
        return { success: false, error: `Path traversal blocked: ${target}` };
      }
      const detectDir = fs.existsSync(targetAbs) && fs.statSync(targetAbs).isDirectory()
        ? targetAbs
        : workspaceRoot;

      // ── linter 自动检测 ──
      let linter = forcedLinter;
      if (linter === "auto") {
        const hasEslintConfig =
          findConfigUpward(detectDir, [
            ".eslintrc",
            ".eslintrc.js",
            ".eslintrc.cjs",
            ".eslintrc.json",
            ".eslintrc.yml",
            ".eslintrc.yaml",
            "eslint.config.js",
            "eslint.config.mjs",
            "eslint.config.cjs",
          ]) !== null;
        const hasPrettierConfig =
          findConfigUpward(detectDir, [
            ".prettierrc",
            ".prettierrc.js",
            ".prettierrc.cjs",
            ".prettierrc.json",
            ".prettierrc.yml",
            ".prettierrc.yaml",
            "prettier.config.js",
            "prettier.config.cjs",
          ]) !== null;

        if (hasEslintConfig) {
          linter = "eslint";
        } else if (hasPrettierConfig) {
          linter = "prettier";
        } else {
          return {
            success: false,
            error: "Could not auto-detect linter. Specify 'linter' parameter explicitly (eslint/prettier).",
            detectDir,
          };
        }
      }

      const isWin = process.platform === "win32";
      const npx = isWin ? "npx.cmd" : "npx";

      // ── eslint: 用 --format json 解析结构化输出 ──
      if (linter === "eslint") {
        const args = [target, "--format", "json"];
        if (fix) args.push("--fix");
        const result = await runCommand(npx, ["eslint", ...args], {
          cwd: workspaceRoot,
          timeoutMs: 120 * 1000,
        });

        // eslint 退出码: 0=无错误, 1=有错误, 2=配置错误
        let files: Array<{
          file: string;
          errors: number;
          warnings: number;
          messages: Array<{ line: number; column: number; message: string; rule?: string }>;
        }> = [];
        let errorCount = 0;
        let warningCount = 0;
        let fixedCount = 0;

        try {
          const parsed = JSON.parse(result.stdout);
          if (Array.isArray(parsed)) {
            for (const entry of parsed) {
              const fileErrors = entry.errorCount || 0;
              const fileWarnings = entry.warningCount || 0;
              errorCount += fileErrors;
              warningCount += fileWarnings;
              fixedCount += (entry.fixableErrorCount || 0) + (entry.fixableWarningCount || 0);
              if (fileErrors > 0 || fileWarnings > 0) {
                files.push({
                  file: entry.filePath ? path.relative(workspaceRoot, entry.filePath).replace(/\\/g, "/") : "(unknown)",
                  errors: fileErrors,
                  warnings: fileWarnings,
                  messages: (entry.messages || []).slice(0, 10).map((m: Record<string, unknown>) => ({
                    line: Number(m.line) || 0,
                    column: Number(m.column) || 0,
                    message: String(m.message || ""),
                    rule: m.ruleId ? String(m.ruleId) : undefined,
                  })),
                });
              }
            }
            files = files.slice(0, 20);
          }
        } catch {
          // JSON 解析失败：返回原始输出
          return {
            success: result.code === 0,
            linter: "eslint",
            errorCount: 0,
            warningCount: 0,
            fixedCount: 0,
            files: [],
            output: (result.stdout + "\n" + result.stderr).slice(-2000),
            parseError: "Failed to parse eslint JSON output",
          };
        }

        return {
          success: errorCount === 0,
          linter: "eslint",
          errorCount,
          warningCount,
          fixedCount: fix ? fixedCount : 0,
          files,
          output: result.stderr.slice(-2000) || "lint complete",
        };
      }

      // ── prettier: --check / --write ──
      if (linter === "prettier") {
        const args = [fix ? "--write" : "--check", target];
        const result = await runCommand(npx, ["prettier", ...args], {
          cwd: workspaceRoot,
          timeoutMs: 120 * 1000,
        });

        // prettier 输出未格式化的文件列表，每行一个文件路径
        const unformattedFiles = result.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("[") && !l.includes("warn"))
          .slice(0, 20);

        return {
          success: result.code === 0,
          linter: "prettier",
          errorCount: unformattedFiles.length,
          warningCount: 0,
          fixedCount: fix ? unformattedFiles.length : 0,
          files: unformattedFiles.map((f) => ({
            file: f.replace(/\\/g, "/"),
            errors: 1,
            warnings: 0,
            messages: [{ line: 0, column: 0, message: "Formatting issue" }],
          })),
          output: (result.stdout + "\n" + result.stderr).slice(-2000),
        };
      }

      return { success: false, error: `Unsupported linter: ${linter}` };
    },
  );

  // ── codebase_search: 轻量级语义代码搜索 ─────────────────────
  executor.registerTool(
    "codebase_search",
    {
      name: "codebase_search",
      description:
        "Search the codebase semantically using natural language queries. Uses file content matching with fuzzy scoring. Returns relevant code snippets with file paths and line numbers. More powerful than grep for finding code by intent.",
      parameters: {
        query: {
          type: "string",
          description:
            "Natural language search query (e.g. 'how does authentication work', 'database connection pool', 'error handling for API calls')",
        },
        maxResults: {
          type: "string",
          description: "Maximum number of results (default: 20)",
        },
        filePattern: {
          type: "string",
          description:
            "Glob pattern to filter files (e.g. '*.ts', '*.py', 'src/**/*'). Default: all files.",
        },
      },
    },
    async (params: Record<string, unknown>) => {
      const query = String(params.query || "");
      const maxResults = parseInt(String(params.maxResults || "20"), 10) || 20;
      const filePattern = params.filePattern ? String(params.filePattern) : null;

      if (!query) return { success: false, error: "Query is required" };

      const queryTerms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2);
      if (queryTerms.length === 0) {
        return { success: false, error: "Query must contain at least one term longer than 2 characters" };
      }

      const results: Array<{ file: string; score: number; snippet: string; lines: string }> = [];

      const excludeDirs = new Set([
        "node_modules",
        "dist",
        ".git",
        "data",
        ".cache",
        "coverage",
        "build",
        ".next",
        "target",
      ]);
      const excludeExts = new Set([
        ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2",
        ".ttf", ".eot", ".mp4", ".webm", ".zip", ".gz", ".tar", ".db",
        ".sqlite", ".lock", ".bin", ".exe", ".dll", ".so", ".dylib",
      ]);
      const maxFileSize = 100 * 1024; // 100KB
      const MAX_RESULTS_WALK = maxResults * 3;
      const maxDepth = 20;
      const maxFiles = 10000;
      let filesScanned = 0;

      const walkDir = (dir: string, depth: number): void => {
        if (depth > maxDepth || results.length >= MAX_RESULTS_WALK) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (results.length >= MAX_RESULTS_WALK || filesScanned >= maxFiles) return;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!excludeDirs.has(entry.name)) {
              walkDir(fullPath, depth + 1);
            }
          } else if (entry.isFile()) {
            filesScanned++;
            const ext = path.extname(entry.name).toLowerCase();
            if (excludeExts.has(ext)) continue;

            if (filePattern && !matchGlob(entry.name, filePattern)) continue;

            let stat: fs.Stats;
            try {
              stat = fs.statSync(fullPath);
            } catch {
              continue;
            }
            if (stat.size > maxFileSize || stat.size === 0) continue;

            let content: string;
            try {
              content = fs.readFileSync(fullPath, "utf-8");
            } catch {
              continue;
            }

            const lowerContent = content.toLowerCase();
            let score = 0;
            for (const term of queryTerms) {
              const count = (lowerContent.match(new RegExp(escapeRegex(term), "g")) || []).length;
              if (count > 0) {
                // TF 归一化：词频 / log(文件长度)，避免长文件天然占优
                score += count * (1 / Math.log(Math.max(content.length, 10)));
              }
            }

            // 文件名匹配加分
            const lowerName = entry.name.toLowerCase();
            for (const term of queryTerms) {
              if (lowerName.includes(term)) score += 5;
            }

            if (score > 0) {
              const snippet = extractSnippet(content, queryTerms, 200);
              const relativePath = path.relative(workspaceRoot, fullPath).replace(/\\/g, "/");
              results.push({
                file: relativePath,
                score,
                snippet: snippet.text,
                lines: snippet.lines,
              });
            }
          }
        }
      };

      walkDir(workspaceRoot, 0);
      results.sort((a, b) => b.score - a.score);

      return {
        query,
        results: results.slice(0, maxResults),
        totalMatches: results.length,
      };
    },
  );
}
