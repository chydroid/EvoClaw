import * as fs from "fs";
import * as path from "path";
import * as docx from "docx";
import { atomicWriteFileSync } from "@evoclaw/core";
import type { AgentModelExecutor } from "@evoclaw/agent";

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

export function registerDocxTools(executor: AgentModelExecutor, fsBase: string): void {
  executor.registerTool(
    "docx_create",
    {
      name: "docx_create",
      description:
        "Create a Microsoft Word .docx file with paragraphs, tables, and images. " +
        "Use this tool when the user asks for a Word document or the active skill is word-docx. " +
        "Images must be provided as base64 strings. After creating the file, tell the user the file path and that they can download it via /api/files/download/{path}.",
      parameters: {
        path: { type: "string", description: "Relative file path to create (e.g. outputs/report.docx)", required: true },
        title: { type: "string", description: "Document title shown on the first page", required: false },
        paragraphs: {
          type: "array",
          description: "List of paragraphs. Each item can be a plain string or an object with { text, heading?, bullet? }.",
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
          description: "List of tables. Each table has optional headers and required rows.",
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
          description: "List of images. Each image is { data: base64, width?: inches, height?: inches, type?: 'png'|'jpg'|'gif'|'bmp' }.",
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
                  transformation: {
                    width: image.width,
                    height: image.height,
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
    }
  );
}
