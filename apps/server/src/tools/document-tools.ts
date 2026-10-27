/**
 * Document Tools — 办公文档创建复合工具（docx / xlsx / pptx）
 *
 * 原 docx-tools / xlsx-tools / pptx-tools 三个工具合并为单一复合工具 `document`，
 * 通过 `action` 判别字段分发：
 *   - document (action=create_docx)   创建 Microsoft Word .docx
 *   - document (action=create_xlsx)   创建 Microsoft Excel .xlsx
 *   - document (action=create_pptx)   创建 Microsoft PowerPoint .pptx
 */

import * as fs from "fs";
import * as path from "path";
import { getActiveSecurityPolicy, decideFileAccess } from "@evoclaw/security";
import * as docx from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { atomicWriteFileSync } from "@evoclaw/core";
import type { AgentModelExecutor } from "@evoclaw/agent";
import { resolveToolPath } from "./file-tools";

/** 验证解析后的路径不超出允许的基目录。
 *  Bug 9 修复：原实现仅做词法检查，不解析符号链接。改为词法检查通过后
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

interface ParagraphItem {
  text: string;
  heading?: boolean;
  bullet?: boolean;
}

interface TableItem {
  headers?: string[];
  rows: string[][];
}

interface ImageItem {
  data: string;
  width: number;
  height: number;
  type: "png" | "jpg" | "gif" | "bmp";
}

export function registerDocumentTools(executor: AgentModelExecutor, fsBase: string, workspaceBase?: string): void {
  // ── action=create_docx（原 docx_create）──────────────────────
  const handleCreateDocx = async (params: Record<string, unknown>) => {
    const filePath = String(params.path || "");
    if (!filePath) return { success: false, error: "Missing required parameter: path" };
    const resolvedPath = resolveToolPath(fsBase, workspaceBase, filePath).resolved;
    // ★ 接入「总体安全等级」。此前 docx_create 无视档位、始终硬拦沙箱外，
    //   而同一时刻 file_* 系列已按 risky 档放行 —— 同一个保存动作，
    //   换个工具就报错，模型只能绕道写 Python 脚本，纯属多余成本。
    const policy = getActiveSecurityPolicy();
    const insideFsBase = resolvedPath === path.resolve(fsBase) || resolvedPath.startsWith(path.resolve(fsBase) + path.sep);
    if (!insideFsBase) {
      const decision = decideFileAccess(policy, { insideSandbox: false, write: true });
      if (decision !== "allow") {
        // ★ deny 与 confirm 都必须拒绝。
        //   docx_create 没有审批通道（未接 PermissionManager），所以"需确认"
        //   无法在这里走审批流程；若放行就等于绕过了 file_* 系列的确认机制，
        //   也会让「拒绝路径穿越」这条防线在一般安全档下形同虚设。
        return {
          success: false,
          error:
            decision === "deny"
              ? `操作被安全策略拦截：当前为「${policy.label}」等级，只允许在沙箱（${path.resolve(fsBase)}）内写入文件。` +
                `如需放开，请到「安全 → 总体安全」调整等级。`
              : `该路径位于沙箱外，「${policy.label}」等级下 docx_create 不能直接写入（此工具无审批通道）。` +
                `请改用 file_* 工具写入（会走正常的用户确认流程），` +
                `或到「安全 → 总体安全」调整为「一定风险」后重试。`,
        };
      }
    }
    const pathError = validatePathWithinBase(resolvedPath, fsBase);
    // 沙箱外且策略明确 allow 时，词法边界检查不再适用（策略本身就允许越界）
    if (pathError && insideFsBase) return { success: false, error: pathError };

    const overwrite = params.overwrite === true;
    if (fs.existsSync(resolvedPath) && !overwrite) {
      return { success: false, error: `File already exists: ${filePath}. Set overwrite=true to replace it.` };
    }

    try {
      const title = params.title ? String(params.title) : undefined;
      const rawParagraphs = Array.isArray(params.paragraphs) ? params.paragraphs : [];
      const rawTables = Array.isArray(params.tables) ? params.tables : [];
      const rawImages = Array.isArray(params.images) ? params.images : [];

      const paragraphs: ParagraphItem[] = rawParagraphs.map((p: unknown) => {
        if (typeof p === "string") return { text: p };
        const item = p as Record<string, unknown>;
        return {
          text: String(item.text ?? ""),
          heading: item.heading === true,
          bullet: item.bullet === true,
        };
      });

      const tables: TableItem[] = rawTables.map((t: unknown) => {
        const item = t as Record<string, unknown>;
        return {
          headers: Array.isArray(item.headers) ? item.headers.map((h: unknown) => String(h ?? "")) : undefined,
          rows: Array.isArray(item.rows)
            ? item.rows.map((row: unknown) =>
                Array.isArray(row) ? row.map((cell: unknown) => String(cell ?? "")) : []
              )
            : [],
        };
      });

      const images: ImageItem[] = rawImages.map((img: unknown) => {
        const item = img as Record<string, unknown>;
        const imageType = String(item.type ?? "png");
        const validType = ["png", "jpg", "gif", "bmp"].includes(imageType) ? (imageType as ImageItem["type"]) : "png";
        return {
          data: String(item.data ?? ""),
          width: typeof item.width === "number" ? item.width : 4,
          height: typeof item.height === "number" ? item.height : 3,
          type: validType,
        };
      });

      const children: (docx.Paragraph | docx.Table)[] = [];
      if (title) {
        children.push(
          new docx.Paragraph({
            text: title,
            heading: docx.HeadingLevel.TITLE,
            alignment: docx.AlignmentType.CENTER,
            spacing: { after: 300 },
          })
        );
      }

      for (const p of paragraphs) {
        if (p.heading) {
          children.push(
            new docx.Paragraph({
              text: p.text,
              heading: docx.HeadingLevel.HEADING_1,
              spacing: { before: 200, after: 120 },
            })
          );
        } else if (p.bullet) {
          children.push(
            new docx.Paragraph({
              text: p.text,
              bullet: { level: 0 },
              spacing: { after: 80 },
            })
          );
        } else {
          children.push(
            new docx.Paragraph({
              text: p.text,
              spacing: { after: 120 },
            })
          );
        }
      }

      for (const table of tables) {
        const rows: docx.TableRow[] = [];
        if (table.headers && table.headers.length > 0) {
          rows.push(
            new docx.TableRow({
              children: table.headers.map(
                (header) =>
                  new docx.TableCell({
                    children: [new docx.Paragraph({ children: [new docx.TextRun({ text: header, bold: true })] })],
                    shading: { fill: "F2F2F2" },
                  })
              ),
            })
          );
        }
        for (const row of table.rows) {
          rows.push(
            new docx.TableRow({
              children: row.map(
                (cell) => new docx.TableCell({ children: [new docx.Paragraph({ text: cell })] })
              ),
            })
          );
        }
        children.push(
          new docx.Table({
            rows,
            width: { size: 100, type: docx.WidthType.PERCENTAGE },
          })
        );
      }

      for (const image of images) {
        const buffer = Buffer.from(image.data, "base64");
        children.push(
          new docx.Paragraph({
            children: [
              new docx.ImageRun({
                data: buffer,
                type: image.type,
                // 修复（DOCX-UNIT）：docx.js 的 transformation 单位是 **像素**
                // （96 DPI），而本工具参数描述与默认值（4×3）都按**英寸**语义
                // 提供——直接透传会把 4×3 英寸写进文档变成 4×3 像素的小缩略图。
                // 此处统一按 96 px/inch 换算。
                transformation: {
                  width: Math.round(image.width * 96),
                  height: Math.round(image.height * 96),
                },
              }),
            ],
            spacing: { before: 200, after: 200 },
          })
        );
      }

      const document = new docx.Document({
        sections: [
          {
            properties: {},
            children,
          },
        ],
      });

      const buffer = await docx.Packer.toBuffer(document);
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      atomicWriteFileSync(resolvedPath, buffer);

      return {
        success: true,
        path: filePath,
        absolutePath: resolvedPath,
        size: buffer.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to create DOCX: ${message}` };
    }
  };

  // ── action=create_xlsx（原 xlsx_create）──────────────────────
  const handleCreateXlsx = async (params: Record<string, unknown>) => {
    const filePath = String(params.path || "");
    if (!filePath) return { success: false, error: "Missing required parameter: path" };
    const resolvedPath = resolveToolPath(fsBase, workspaceBase, filePath).resolved;
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
  };

  // ── action=create_pptx（原 pptx_create）──────────────────────
  const handleCreatePptx = async (params: Record<string, unknown>) => {
    const filePath = String(params.path || "");
    if (!filePath) return { success: false, error: "Missing required parameter: path" };
    const resolvedPath = resolveToolPath(fsBase, workspaceBase, filePath).resolved;
    const pathError = validatePathWithinBase(resolvedPath, fsBase);
    if (pathError) return { success: false, error: pathError };

    const overwrite = params.overwrite === true;
    if (fs.existsSync(resolvedPath) && !overwrite) {
      return { success: false, error: `File already exists: ${filePath}. Set overwrite=true to replace it.` };
    }

    try {
      const pres = new PptxGenJS();
      pres.layout = "LAYOUT_16x9";
      const title = params.title ? String(params.title) : undefined;
      if (title) {
        pres.title = title;
      }

      const rawSlides = Array.isArray(params.slides) ? params.slides : [];

      if (rawSlides.length === 0 && title) {
        const slide = pres.addSlide();
        slide.addText(title, { x: 0.5, y: 2, w: "90%", h: 1, fontSize: 32, bold: true, align: "center" });
      }

      for (const raw of rawSlides) {
        const item = raw as Record<string, unknown>;
        const slide = pres.addSlide();
        const slideTitle = item.title ? String(item.title) : undefined;
        let cursorY = 0.5;

        if (slideTitle) {
          slide.addText(slideTitle, { x: 0.5, y: cursorY, w: "90%", h: 0.6, fontSize: 24, bold: true });
          cursorY += 0.8;
        }

        const bullets = Array.isArray(item.bullets) ? item.bullets.map((b: unknown) => String(b)) : [];
        if (bullets.length > 0) {
          slide.addText(
            bullets.map((b) => ({ text: b })),
            { x: 0.5, y: cursorY, w: "90%", h: bullets.length * 0.4 + 0.2, fontSize: 14, bullet: true }
          );
          cursorY += bullets.length * 0.4 + 0.4;
        }

        const paragraphs = Array.isArray(item.paragraphs) ? item.paragraphs.map((p: unknown) => String(p)) : [];
        if (paragraphs.length > 0) {
          slide.addText(paragraphs.join("\n\n"), { x: 0.5, y: cursorY, w: "90%", h: paragraphs.length * 0.5 + 0.2, fontSize: 14 });
          cursorY += paragraphs.length * 0.5 + 0.4;
        }

        const table = item.table as Record<string, unknown> | undefined;
        if (table) {
          const headers = Array.isArray(table.headers) ? table.headers.map((h: unknown) => String(h)) : [];
          const rows = Array.isArray(table.rows)
            ? table.rows.map((row: unknown) =>
                Array.isArray(row) ? row.map((cell: unknown) => String(cell)) : []
              )
            : [];
          const tableData = (headers.length > 0 ? [headers, ...rows] : rows).map((row) =>
            row.map((cell) => ({ text: cell }))
          );
          if (tableData.length > 0) {
            slide.addTable(tableData, { x: 0.5, y: cursorY, w: "90%", fontSize: 12 });
            cursorY += tableData.length * 0.4 + 0.4;
          }
        }

        const images = Array.isArray(item.images)
          ? item.images.map((img: unknown) => {
              const i = img as Record<string, unknown>;
              return {
                data: String(i.data ?? ""),
                x: typeof i.x === "number" ? i.x : 0.5,
                y: typeof i.y === "number" ? i.y : cursorY,
                width: typeof i.width === "number" ? i.width : 4,
                height: typeof i.height === "number" ? i.height : 3,
              };
            })
          : [];

        for (const image of images) {
          slide.addImage({ data: image.data, x: image.x, y: image.y, w: image.width, h: image.height });
        }
      }

      const buffer = await pres.write({ outputType: "nodebuffer" });
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      atomicWriteFileSync(resolvedPath, Buffer.from(buffer as ArrayBuffer));

      return {
        success: true,
        path: filePath,
        absolutePath: resolvedPath,
        size: Buffer.from(buffer as ArrayBuffer).length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to create PPTX: ${message}` };
    }
  };

  executor.registerTool(
    "document",
    {
      name: "document",
      description:
        "Create office documents. " +
        "action=create_docx: Microsoft Word .docx with paragraphs, tables, and images (base64); " +
        "action=create_xlsx: Microsoft Excel .xlsx workbook with styled sheets, headers, and rows; " +
        "action=create_pptx: Microsoft PowerPoint .pptx presentation with slides, text, bullets, tables, and images. " +
        "After creating the file, tell the user the file path and that they can download it via /api/files/download/{path}.",
      parameters: {
        action: {
          type: "string",
          description: "document 操作类型",
          required: true,
          enum: ["create_docx", "create_xlsx", "create_pptx"],
        },
        path: { type: "string", description: "Relative file path to create（如 outputs/report.docx / report.xlsx / slides.pptx，全部 action 使用）", required: false },
        title: { type: "string", description: "Document/presentation title（create_docx / create_pptx 使用）", required: false },
        paragraphs: {
          type: "array",
          description: "List of paragraphs. Each item can be a plain string or an object with { text, heading?, bullet? }（create_docx 使用）",
          required: false,
          items: {
            type: "object",
            properties: {
              text: { type: "string", required: true },
              heading: { type: "boolean", required: false },
              bullet: { type: "boolean", required: false },
            },
          },
        },
        tables: {
          type: "array",
          description: "List of tables. Each table has optional headers and required rows（create_docx 使用）",
          required: false,
          items: {
            type: "object",
            properties: {
              headers: { type: "array", items: { type: "string" }, required: false },
              rows: { type: "array", items: { type: "array", items: { type: "string" } }, required: true },
            },
          },
        },
        images: {
          type: "array",
          description: "List of images. Each image is { data: base64, width?: inches, height?: inches, type?: 'png'|'jpg'|'gif'|'bmp' }（create_docx 使用）",
          required: false,
          items: {
            type: "object",
            properties: {
              data: { type: "string", required: true },
              width: { type: "number", required: false },
              height: { type: "number", required: false },
              type: { type: "string", description: "Image format: png, jpg, gif, bmp (default: png)", required: false },
            },
          },
        },
        sheets: {
          type: "array",
          description: "List of worksheets. Each sheet has { name, headers?, rows }（create_xlsx 使用）",
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
        slides: {
          type: "array",
          description: "List of slides. Each slide can have title, bullets, paragraphs, table, images（create_pptx 使用）",
          required: false,
          items: {
            type: "object",
            properties: {
              title: { type: "string", required: false },
              bullets: { type: "array", items: { type: "string" }, required: false },
              paragraphs: { type: "array", items: { type: "string" }, required: false },
              table: {
                type: "object",
                properties: {
                  headers: { type: "array", items: { type: "string" }, required: false },
                  rows: { type: "array", items: { type: "array", items: { type: "string" } }, required: true },
                },
              },
              images: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    data: { type: "string", required: true },
                    x: { type: "number", required: false },
                    y: { type: "number", required: false },
                    width: { type: "number", required: false },
                    height: { type: "number", required: false },
                  },
                },
              },
            },
          },
        },
        overwrite: { type: "boolean", description: "Whether to overwrite an existing file (default: false)（全部 action 使用）", required: false, default: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "create_docx");
      if (action === "create_docx") return await handleCreateDocx(params);
      if (action === "create_xlsx") return await handleCreateXlsx(params);
      if (action === "create_pptx") return await handleCreatePptx(params);
      return { success: false, error: `未知 document action: ${action}（仅支持 create_docx / create_xlsx / create_pptx）` };
    },
  );
}
