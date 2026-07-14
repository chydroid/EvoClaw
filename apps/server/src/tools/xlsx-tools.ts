import * as fs from "fs";
import * as path from "path";
import ExcelJS from "exceljs";
import { atomicWriteFileSync } from "@evoclaw/core";
import type { AgentModelExecutor } from "@evoclaw/agent";

/** Bug 9 修复：原实现仅做词法检查，不解析符号链接。改为词法检查通过后
 *  再用 fs.realpathSync 解析符号链接，防止 workspace 内 symlink 指向外部目录。 */
function validatePathWithinBase(resolvedPath: string, baseDir: string): string | null {
  const normalizedBase = path.resolve(baseDir);
  const normalizedTarget = path.resolve(resolvedPath);

  // 先做词法检查：若词法上已超出 base，直接拒绝（避免 realpath 浪费 IO）
  if (!normalizedTarget.startsWith(normalizedBase + path.sep) && normalizedTarget !== normalizedBase) {
    return `Path traversal blocked: "${resolvedPath}" is outside the allowed workspace "${normalizedBase}".`;
  }

  // 词法检查通过后，再用 realpath 解析符号链接，防止 workspace 内 symlink 指向外部目录
  try {
    let realTarget: string;
    if (fs.existsSync(normalizedTarget)) {
      realTarget = fs.realpathSync(normalizedTarget);
    } else {
      // 路径不存在（如 file_create）：realpath 父目录后拼接 basename
      const parentDir = path.dirname(normalizedTarget);
      if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        realTarget = path.join(realParent, path.basename(normalizedTarget));
      } else {
        // 父目录也不存在：信任词法检查结果
        return null;
      }
    }
    // 对 realpath 结果再做一次词法检查
    if (!realTarget.startsWith(normalizedBase + path.sep) && realTarget !== normalizedBase) {
      return `Path traversal blocked (symlink escape): "${resolvedPath}" resolves to "${realTarget}" which is outside the allowed workspace "${normalizedBase}".`;
    }
  } catch {
    // realpath 失败（权限/IO 错误）：保守拒绝，避免误放行
    return `Path validation failed (realpath error): "${resolvedPath}".`;
  }
  return null;
}

interface SheetItem {
  name: string;
  headers?: string[];
  rows: string[][];
}

export function registerXlsxTools(executor: AgentModelExecutor, fsBase: string): void {
  executor.registerTool(
    "xlsx_create",
    {
      name: "xlsx_create",
      description:
        "Create a Microsoft Excel .xlsx workbook with styled sheets, headers, and rows. " +
        "Use this tool when the user asks for an Excel file or the active skill is excel-xlsx. " +
        "After creating the file, always inform the user of the file path and that they can download it via /api/files/download/{path}.",
      parameters: {
        path: { type: "string", description: "Relative file path to create (e.g. outputs/report.xlsx)", required: true },
        sheets: {
          type: "array",
          description: "List of worksheets. Each sheet has { name, headers?, rows }.",
          required: false,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Worksheet name", required: true },
              headers: { type: "array", items: { type: "string" }, required: false },
              rows: { type: "array", items: { type: "array", items: { type: "string" } }, required: true },
            },
          },
        },
        overwrite: { type: "boolean", description: "Whether to overwrite an existing file (default: false)", required: false, default: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const filePath = String(params.path || "");
      if (!filePath) return { success: false, error: "Missing required parameter: path" };
      const resolvedPath = path.resolve(fsBase, filePath);
      const pathError = validatePathWithinBase(resolvedPath, fsBase);
      if (pathError) return { success: false, error: pathError };

      const overwrite = params.overwrite === true;
      if (fs.existsSync(resolvedPath) && !overwrite) {
        return { success: false, error: `File already exists: ${filePath}. Set overwrite=true to replace it.` };
      }

      try {
        const workbook = new ExcelJS.Workbook();
        const rawSheets = Array.isArray(params.sheets) ? params.sheets : [];

        if (rawSheets.length === 0) {
          workbook.addWorksheet("Sheet1");
        }

        for (const raw of rawSheets) {
          const item = raw as Record<string, unknown>;
          const sheetName = String(item.name || "Sheet1").slice(0, 31);
          const worksheet = workbook.addWorksheet(sheetName);

          const headers = Array.isArray(item.headers) ? item.headers.map((h: unknown) => String(h ?? "")) : [];
          const rows = Array.isArray(item.rows)
            ? item.rows.map((row: unknown) =>
                Array.isArray(row) ? row.map((cell: unknown) => String(cell ?? "")) : []
              )
            : [];

          if (headers.length > 0) {
            worksheet.addRow(headers);
            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true };
            headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E0E0" } };
          }

          for (const row of rows) {
            worksheet.addRow(row);
          }

          worksheet.columns.forEach((column) => {
            column.width = 20;
          });
        }

        const buffer = await workbook.xlsx.writeBuffer();
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
        atomicWriteFileSync(resolvedPath, Buffer.from(buffer));

        return {
          success: true,
          path: filePath,
          absolutePath: resolvedPath,
          size: Buffer.from(buffer).length,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to create XLSX: ${message}` };
      }
    }
  );
}
