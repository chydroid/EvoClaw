/**
 * lsp-verdicts — 延迟语法裁决（对标 hermes-agent agent/turn_stop_gates.py::_late_lsp_verdicts）
 *
 * 问题：模型编辑文件后声称完成，但语法错误可能在工具结果返回后才暴露。
 * 没有 LSP 服务器时，我们用轻量语法检查器在回合结束时收集「延迟裁决」，
 * 作为系统备注注入，让模型在下一轮修复。
 *
 * 关键设计（对标 hermes）：
 *   - DeferredVerdictTracker：跟踪回合中的文件编辑
 *   - DiagnosticChecker：可插拔的诊断检查器接口
 *   - NodeSyntaxChecker：默认检查器（node --check for JS，brace-balance for TS）
 *   - collectLateVerdicts：在停止门收集延迟裁决，返回系统备注字符串
 *   - 仅在停止门触发——不在每次编辑后运行，避免性能开销
 *   - 仅检查变更文件——不检查未修改的文件
 *   - 有错误才注入备注——无错误时静默通过
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ── 类型 ──────────────────────────────────────────────

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
}

export interface DiagnosticChecker {
  checkFile(filePath: string, content?: string): Promise<Diagnostic[]>;
}

// ── 延迟编辑跟踪器 ───────────────────────────────────

/**
 * 跟踪回合中的文件编辑。
 * 在回合开始时创建，编辑发生时调用 trackEdit()，
 * 停止门调用 collectVerdicts() 获取延迟裁决。
 */
export class DeferredVerdictTracker {
  private pendingEdits = new Set<string>();
  private checker: DiagnosticChecker;
  private maxEdits: number;

  constructor(checker: DiagnosticChecker, maxEdits = 50) {
    this.checker = checker;
    this.maxEdits = maxEdits;
  }

  /** 跟踪一个文件编辑 */
  trackEdit(filePath: string): void {
    if (this.pendingEdits.size >= this.maxEdits) return;
    // 归一化路径
    const normalized = path.resolve(filePath);
    this.pendingEdits.add(normalized);
  }

  /** 批量跟踪多个文件编辑 */
  trackEdits(filePaths: string[]): void {
    for (const p of filePaths) this.trackEdit(p);
  }

  /** 获取待检查的文件列表 */
  getPendingEdits(): string[] {
    return Array.from(this.pendingEdits);
  }

  /** 清除所有待检查文件 */
  clear(): void {
    this.pendingEdits.clear();
  }

  /** 收集延迟裁决——对每个待检查文件运行诊断 */
  async collectVerdicts(timeoutMs = 5000): Promise<Diagnostic[]> {
    const files = this.getPendingEdits();
    if (files.length === 0) return [];

    const allDiagnostics: Diagnostic[] = [];

    for (const file of files) {
      try {
        // 使用 Promise.race 实现超时
        const diagnostics = await Promise.race([
          this.checker.checkFile(file),
          new Promise<Diagnostic[]>((resolve) =>
            setTimeout(() => resolve([]), timeoutMs / Math.max(files.length, 1)),
          ),
        ]);
        allDiagnostics.push(...diagnostics);
      } catch (err) {
        // 检查失败——不阻断流程
        process.stderr.write(
          `[lsp-verdicts] ⚠ 检查失败 ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    return allDiagnostics;
  }
}

// ── 默认诊断检查器 ───────────────────────────────────

/**
 * 基于 node --check 的语法检查器。
 * 对 JS 文件使用 node --check（精确语法检查）。
 * 对 TS 文件使用简化的括号平衡检查（快速，不精确但够用）。
 * 其他文件类型跳过。
 */
export class NodeSyntaxChecker implements DiagnosticChecker {
  async checkFile(filePath: string, content?: string): Promise<Diagnostic[]> {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      return this.checkJsFile(filePath, content);
    }
    if (ext === ".ts") {
      return this.checkTsFile(filePath, content);
    }

    return [];
  }

  private async checkJsFile(filePath: string, content?: string): Promise<Diagnostic[]> {
    try {
      await execFileAsync(process.execPath, ["--check", filePath], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      return [];
    } catch (err) {
      // execFile 的错误对象带有 stderr 属性（非标准 Error 子类）
      const execErr = err as { stderr?: string; message?: string };
      const stderr = execErr.stderr || execErr.message || String(err);
      return this.parseNodeCheckOutput(filePath, stderr);
    }
  }

  private parseNodeCheckOutput(filePath: string, output: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    // node --check 输出格式：
    // /path/to/file.js:12
    // SyntaxError: Unexpected token
    //     at ...
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/^(.+):(\d+)$/);
      if (match) {
        const [, file, lineStr] = match;
        const lineNum = parseInt(lineStr, 10);
        // 下一行是错误消息
        const nextLine = lines[lines.indexOf(line) + 1] || "";
        const msgMatch = nextLine.match(/SyntaxError:\s*(.+)/);
        diagnostics.push({
          file: path.resolve(file),
          line: lineNum,
          column: 0,
          severity: "error",
          message: msgMatch ? msgMatch[1].trim() : "语法错误",
          source: "node-check",
        });
      }
    }
    // 如果没解析到行号，放一个通用错误
    if (diagnostics.length === 0 && output.includes("SyntaxError")) {
      diagnostics.push({
        file: path.resolve(filePath),
        line: 0,
        column: 0,
        severity: "error",
        message: output.match(/SyntaxError:\s*(.+)/)?.[1]?.trim() || "语法错误",
        source: "node-check",
      });
    }
    return diagnostics;
  }

  private checkTsFile(filePath: string, content?: string): Diagnostic[] {
    let src: string;
    try {
      src = content ?? fs.readFileSync(filePath, "utf8");
    } catch {
      return [];
    }

    // 简化的 TS 语法检查：括号平衡 + 未终止字符串
    const diagnostics: Diagnostic[] = [];

    // 去除字符串和注释后检查括号平衡
    let cleaned = this.stripStringsAndComments(src);

    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const stack: Array<{ char: string; line: number; col: number }> = [];

    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      const line = src.slice(0, i).split("\n").length;
      const col = i - src.lastIndexOf("\n", i);

      if (ch === "(" || ch === "[" || ch === "{") {
        stack.push({ char: ch, line, col });
      } else if (ch === ")" || ch === "]" || ch === "}") {
        const top = stack.pop();
        if (!top || top.char !== pairs[ch]) {
          diagnostics.push({
            file: path.resolve(filePath),
            line,
            column: col,
            severity: "error",
            message: `未匹配的括号 "${ch}"`,
            source: "brace-balance",
          });
        }
      }
    }

    // 未闭合的括号
    for (const item of stack) {
      diagnostics.push({
        file: path.resolve(filePath),
        line: item.line,
        column: item.col,
        severity: "error",
        message: `未闭合的括号 "${item.char}"`,
        source: "brace-balance",
      });
    }

    // 检查未终止的模板字符串（通过 stripStringsAndComments 的清理结果间接检测）
    // 如果模板字符串未终止，stripStringsAndComments 会消耗剩余内容，
    // 导致括号平衡检查无法捕获——此处不做额外检查。

    return diagnostics;
  }

  /**
   * 去除字符串字面量和注释，保留括号结构。
   * 用于括号平衡检查。
   */
  private stripStringsAndComments(src: string): string {
    let result = "";
    let i = 0;
    let inString: string | null = null;  // '"' or "'"
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;

    while (i < src.length) {
      const ch = src[i];
      const next = src[i + 1];

      if (inLineComment) {
        if (ch === "\n") inLineComment = false;
        i++;
        continue;
      }
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (inString) {
        if (ch === "\\") { i += 2; continue; }
        if (ch === inString) inString = null;
        i++;
        continue;
      }
      if (inTemplate) {
        if (ch === "\\") { i += 2; continue; }
        if (ch === "`") inTemplate = false;
        i++;
        continue;
      }

      // 不在字符串/注释中
      if (ch === "/" && next === "/") { inLineComment = true; i += 2; continue; }
      if (ch === "/" && next === "*") { inBlockComment = true; i += 2; continue; }
      if (ch === '"') { inString = '"'; result += " "; i++; continue; }
      if (ch === "'") { inString = "'"; result += " "; i++; continue; }
      if (ch === "`") { inTemplate = true; result += " "; i++; continue; }

      result += ch;
      i++;
    }

    return result;
  }
}

// ── 便捷函数 ──────────────────────────────────────────

/**
 * 收集延迟裁决并格式化为系统备注字符串。
 * 在停止门调用——对变更文件运行语法检查，有错误时返回备注。
 *
 * @param changedPaths 回合中变更的文件路径列表
 * @param checker 诊断检查器（默认 NodeSyntaxChecker）
 * @param timeoutMs 每个文件的超时时间（毫秒，默认 5000）
 * @returns 系统备注字符串数组（无错误时为空数组）
 */
export async function collectLateVerdicts(
  changedPaths: string[],
  checker?: DiagnosticChecker,
  timeoutMs = 5000,
): Promise<string[]> {
  if (changedPaths.length === 0) return [];

  const checkerImpl = checker ?? new NodeSyntaxChecker();
  const tracker = new DeferredVerdictTracker(checkerImpl);
  tracker.trackEdits(changedPaths);

  const diagnostics = await tracker.collectVerdicts(timeoutMs);
  const errorDiagnostics = diagnostics.filter((d) => d.severity === "error");

  if (errorDiagnostics.length === 0) return [];

  // 按文件分组
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of errorDiagnostics) {
    const rel = path.relative(process.cwd(), d.file) || d.file;
    const arr = byFile.get(rel) ?? [];
    arr.push(d);
    byFile.set(rel, arr);
  }

  const notes: string[] = [];
  for (const [file, diags] of byFile) {
    const lines = diags.map(
      (d) => `  ${file}:${d.line}:${d.column} — ${d.message}`,
    );
    notes.push(
      `[System: Deferred syntax check found ${diags.length} error(s) ` +
      `in file(s) edited this turn. The model should fix these before ending.]\n` +
      lines.join("\n"),
    );
  }

  return notes;
}

/**
 * 判断文件是否为可检查的类型（JS/TS）。
 */
export function isCheckableFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts";
}
