/**
 * PatchParser — V4A patch 格式解析器。
 *
 * 对标 Hermes v0.18.0 `tools/patch_parser.py` 的 `parse_v4a_patch`：
 * 解析 codex/cline 等主流 agent 使用的 V4A patch 格式，支持：
 *   *** Begin Patch
 *   *** Add File: path/to/new.txt
 *   +new content
 *   *** Update File: path/to/existing.ts
 *   @@-10,3 +10,4 @@
 *   -old line
 *   +new line
 *   context line
 *   *** Delete File: path/to/old.txt
 *   *** Move File: old.ts -> new.ts
 *   *** End Patch
 *
 * 设计：
 * 1. 两阶段：先全部解析校验，再全部应用（失败回滚）
 * 2. 支持 context line / hunk header（行号可选）
 * 3. 应用时通过 fuzzyFindAndReplace 处理 LLM 序列化漂移
 */

import { fuzzyFindAndReplace } from "./fuzzy-match";

/** V4A 操作类型 */
export type V4AOpType = "add" | "update" | "delete" | "move";

/** V4A 单个操作 */
export interface V4AOperation {
  type: V4AOpType;
  /** 目标文件路径（add/update/delete 用） */
  path?: string;
  /** move 的源路径 */
  sourcePath?: string;
  /** move 的目标路径 */
  targetPath?: string;
  /** add 的完整内容 */
  addContent?: string;
  /** update 的 hunks */
  hunks?: V4AHunk[];
}

/** V4A hunk */
export interface V4AHunk {
  /** 旧文件起始行（1-based，可选） */
  oldStart?: number;
  /** 旧文件行数 */
  oldLines?: number;
  /** 新文件起始行（1-based，可选） */
  newStart?: number;
  /** 新文件行数 */
  newLines?: number;
  /** hunk 行 */
  lines: V4AHunkLine[];
}

/** hunk 行 */
export interface V4AHunkLine {
  /** 行类型 */
  type: "context" | "add" | "remove";
  /** 行内容（不含 +/-/ 前缀） */
  content: string;
}

/** 解析结果 */
export interface ParseResult {
  success: boolean;
  operations: V4AOperation[];
  error: string | null;
}

/** 应用结果 */
export interface ApplyResult {
  success: boolean;
  /** 已应用的文件路径 → 新内容 */
  applied: Map<string, string>;
  /** 失败原因 */
  error: string | null;
  /** 失败的文件 */
  failedFile?: string;
}

// ── 解析 ──────────────────────────────────────────────────

/**
 * 解析 V4A patch 文本。
 *
 * @param patchText 完整的 V4A patch 文本
 */
export function parseV4APatch(patchText: string): ParseResult {
  if (!patchText || typeof patchText !== "string") {
    return { success: false, operations: [], error: "patch 文本为空" };
  }

  const lines = patchText.split("\n");
  const ops: V4AOperation[] = [];
  let i = 0;

  // 必须以 *** Begin Patch 开头
  if (lines[i]?.trim() !== "*** Begin Patch") {
    return { success: false, operations: [], error: `patch 必须以 "*** Begin Patch" 开头，实际为: ${JSON.stringify(lines[i])}` };
  }
  i++;

  let currentOp: V4AOperation | null = null;
  let currentHunk: V4AHunk | null = null;
  let addContentLines: string[] | null = null;

  while (i < lines.length) {
    const line = lines[i];
    let m: RegExpExecArray | null = null;

    // End Patch
    if (line.trim() === "*** End Patch") {
      if (currentHunk && currentOp) {
        currentOp.hunks!.push(currentHunk);
        currentHunk = null;
      }
      if (addContentLines && currentOp) {
        currentOp.addContent = addContentLines.join("\n");
        addContentLines = null;
      }
      if (currentOp) ops.push(currentOp);
      currentOp = null;
      i++;
      continue;
    }

    // 文件操作指令
    if (line.startsWith("*** ")) {
      // 结束当前 hunk / add content
      if (currentHunk && currentOp) {
        currentOp.hunks!.push(currentHunk);
        currentHunk = null;
      }
      if (addContentLines && currentOp) {
        currentOp.addContent = addContentLines.join("\n");
        addContentLines = null;
      }
      if (currentOp) ops.push(currentOp);

      const cmd = line.slice(4).trim();

      // Add File: <path>
      m = /^Add File:\s*(.+)$/.exec(cmd);
      if (m) {
        currentOp = { type: "add", path: m[1].trim(), addContent: "", hunks: [] };
        addContentLines = [];
        i++;
        continue;
      }

      // Update File: <path>
      m = /^Update File:\s*(.+)$/.exec(cmd);
      if (m) {
        currentOp = { type: "update", path: m[1].trim(), hunks: [] };
        i++;
        continue;
      }

      // Delete File: <path>
      m = /^Delete File:\s*(.+)$/.exec(cmd);
      if (m) {
        currentOp = { type: "delete", path: m[1].trim() };
        i++;
        continue;
      }

      // Move File: <src> -> <dst>
      m = /^Move File:\s*(.+?)\s*->\s*(.+)$/.exec(cmd);
      if (m) {
        currentOp = { type: "move", sourcePath: m[1].trim(), targetPath: m[2].trim() };
        i++;
        continue;
      }

      return { success: false, operations: [], error: `未知的 V4A 指令: ${JSON.stringify(line)}` };
    }

    // Add File 内容行
    if (addContentLines !== null && currentOp?.type === "add") {
      if (line.startsWith("+")) {
        addContentLines.push(line.slice(1));
      } else if (line === "" || line === "+") {
        addContentLines.push("");
      } else {
        // 非法行（add file 内容必须以 + 开头或为空）
        // 宽容处理：空行视为内容
        addContentLines.push(line);
      }
      i++;
      continue;
    }

    // Update File hunk 行
    if (currentOp?.type === "update") {
      // hunk header: @@ -oldStart,oldLines +newStart,newLines @@
      m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/.exec(line);
      if (m) {
        if (currentHunk) currentOp.hunks!.push(currentHunk);
        currentHunk = {
          oldStart: parseInt(m[1], 10),
          oldLines: m[2] ? parseInt(m[2], 10) : undefined,
          newStart: m[3] ? parseInt(m[3], 10) : undefined,
          newLines: m[4] ? parseInt(m[4], 10) : undefined,
          lines: [],
        };
        i++;
        continue;
      }

      // hunk 内容行
      if (currentHunk) {
        if (line.startsWith("+")) {
          currentHunk.lines.push({ type: "add", content: line.slice(1) });
        } else if (line.startsWith("-")) {
          currentHunk.lines.push({ type: "remove", content: line.slice(1) });
        } else if (line.startsWith(" ")) {
          currentHunk.lines.push({ type: "context", content: line.slice(1) });
        } else if (line === "") {
          // 空行视为 context（V4A 常见格式）
          currentHunk.lines.push({ type: "context", content: "" });
        } else {
          return { success: false, operations: [], error: `无法解析的 hunk 行: ${JSON.stringify(line)}` };
        }
        i++;
        continue;
      }

      // 没有 hunk header 就出现内容行
      return { success: false, operations: [], error: `update 操作缺少 @@ hunk header: ${JSON.stringify(line)}` };
    }

    // 未识别的行
    i++;
  }

  // 流结束但未遇到 *** End Patch
  if (currentOp) {
    if (currentHunk) currentOp.hunks!.push(currentHunk);
    if (addContentLines) currentOp.addContent = addContentLines.join("\n");
    ops.push(currentOp);
  }

  // 验证操作
  const verr = validateOperations(ops);
  if (verr) return { success: false, operations: [], error: verr };

  return { success: true, operations: ops, error: null };
}

/** 验证操作完整性 */
function validateOperations(ops: V4AOperation[]): string | null {
  for (const op of ops) {
    if (op.type === "add" && !op.path) return "add 操作缺少 path";
    if (op.type === "update" && !op.path) return "update 操作缺少 path";
    if (op.type === "delete" && !op.path) return "delete 操作缺少 path";
    if (op.type === "move" && (!op.sourcePath || !op.targetPath)) return "move 操作缺少 sourcePath/targetPath";
    if (op.type === "update" && (!op.hunks || op.hunks.length === 0)) return `update 操作 ${op.path} 缺少 hunks`;
    if (op.type === "add" && op.addContent === undefined) return `add 操作 ${op.path} 缺少 content`;
  }
  return null;
}

// ── 应用 ──────────────────────────────────────────────────

/**
 * 应用 V4A 操作到文件系统。
 * 两阶段：先全部校验（读取文件、检查存在性），再全部应用。失败回滚。
 *
 * @param ops 解析后的操作列表
 * @param readFile 读取文件内容的函数
 * @param writeFile 写入文件内容的函数
 * @param deleteFile 删除文件的函数
 */
export async function applyV4AOperations(
  ops: V4AOperation[],
  readFile: (path: string) => Promise<string>,
  writeFile: (path: string, content: string) => Promise<void>,
  deleteFile: (path: string) => Promise<void>,
): Promise<ApplyResult> {
  // 阶段 1：预校验 + 准备变更
  const changes: Array<{ type: "write" | "delete"; path: string; content?: string }> = [];
  const applied = new Map<string, string>();

  try {
    for (const op of ops) {
      if (op.type === "add") {
        // add：目标文件不应已存在（宽容处理：允许覆盖）
        changes.push({ type: "write", path: op.path!, content: op.addContent ?? "" });
      } else if (op.type === "update") {
        const oldContent = await readFile(op.path!);
        const newContent = applyHunks(oldContent, op.hunks!);
        if (newContent === oldContent) {
          return { success: false, applied, error: `update ${op.path} 未产生变更`, failedFile: op.path };
        }
        changes.push({ type: "write", path: op.path!, content: newContent });
      } else if (op.type === "delete") {
        changes.push({ type: "delete", path: op.path! });
      } else if (op.type === "move") {
        const srcContent = await readFile(op.sourcePath!);
        changes.push({ type: "write", path: op.targetPath!, content: srcContent });
        changes.push({ type: "delete", path: op.sourcePath! });
      }
    }
  } catch (err) {
    return {
      success: false,
      applied,
      error: `预校验失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 阶段 2：全部应用
  try {
    for (const change of changes) {
      if (change.type === "write") {
        await writeFile(change.path, change.content ?? "");
        applied.set(change.path, change.content ?? "");
      } else if (change.type === "delete") {
        await deleteFile(change.path);
        applied.set(change.path, "<deleted>");
      }
    }
    return { success: true, applied, error: null };
  } catch (err) {
    return {
      success: false,
      applied,
      error: `应用失败: ${err instanceof Error ? err.message : String(err)}`,
      failedFile: changes[applied.size]?.path,
    };
  }
}

/** 将 hunks 应用到原内容，返回新内容 */
export function applyHunks(content: string, hunks: V4AHunk[]): string {
  let result = content;

  for (const hunk of hunks) {
    // 构建 old片段 和 new片段
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.type === "context") {
        oldLines.push(line.content);
        newLines.push(line.content);
      } else if (line.type === "remove") {
        oldLines.push(line.content);
      } else if (line.type === "add") {
        newLines.push(line.content);
      }
    }

    const oldStr = oldLines.join("\n");
    const newStr = newLines.join("\n");

    // no-op hunk：oldStr === newStr（纯 context 行，无 add/remove）。
    // 跳过 fuzzyFindAndReplace（它会因 old===new 报错），让上层
    // applyV4AOperations 通过 newContent === oldContent 检测"未产生变更"。
    if (oldStr === newStr) {
      continue;
    }

    if (!oldStr) {
      // 纯添加：在指定位置插入（无 context 时追加到末尾）
      result = result + (result.endsWith("\n") ? "" : "\n") + newStr;
      continue;
    }

    // 使用 fuzzyFindAndReplace 处理序列化漂移
    const fr = fuzzyFindAndReplace(result, oldStr, newStr, false);
    if (fr.success) {
      result = fr.newContent;
    } else {
      // 失败时尝试宽松匹配（按行号定位）
      if (hunk.oldStart !== undefined) {
        const lines = result.split("\n");
        const startIdx = hunk.oldStart - 1;
        if (startIdx >= 0 && startIdx + oldLines.length <= lines.length) {
          const actual = lines.slice(startIdx, startIdx + oldLines.length).join("\n");
          if (actual === oldStr) {
            lines.splice(startIdx, oldLines.length, ...newLines);
            result = lines.join("\n");
            continue;
          }
        }
      }
      throw new Error(`无法应用 hunk: ${fr.error}`);
    }
  }

  return result;
}

/** 将 V4A 操作序列化回文本（用于日志/调试） */
export function serializeV4A(ops: V4AOperation[]): string {
  const lines: string[] = ["*** Begin Patch"];
  for (const op of ops) {
    if (op.type === "add") {
      lines.push(`*** Add File: ${op.path}`);
      for (const line of (op.addContent ?? "").split("\n")) {
        lines.push(`+${line}`);
      }
    } else if (op.type === "update") {
      lines.push(`*** Update File: ${op.path}`);
      for (const hunk of op.hunks ?? []) {
        const header = `@@ -${hunk.oldStart ?? 1}${hunk.oldLines !== undefined ? `,${hunk.oldLines}` : ""} +${hunk.newStart ?? 1}${hunk.newLines !== undefined ? `,${hunk.newLines}` : ""} @@`;
        lines.push(header);
        for (const line of hunk.lines) {
          if (line.type === "context") lines.push(` ${line.content}`);
          else if (line.type === "add") lines.push(`+${line.content}`);
          else if (line.type === "remove") lines.push(`-${line.content}`);
        }
      }
    } else if (op.type === "delete") {
      lines.push(`*** Delete File: ${op.path}`);
    } else if (op.type === "move") {
      lines.push(`*** Move File: ${op.sourcePath} -> ${op.targetPath}`);
    }
  }
  lines.push("*** End Patch");
  return lines.join("\n");
}
