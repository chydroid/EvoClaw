import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import PptxGenJS from "pptxgenjs";
import type { AgentModelExecutor } from "@evoclaw/agent";

function validatePathWithinBase(resolvedPath: string, baseDir: string): string | null {
  const normalizedBase = path.resolve(baseDir);
  const normalizedTarget = path.resolve(resolvedPath);
  if (!normalizedTarget.startsWith(normalizedBase + path.sep) && normalizedTarget !== normalizedBase) {
    return `Path traversal blocked: "${resolvedPath}" is outside the allowed workspace "${normalizedBase}".`;
  }
  return null;
}

/** 原子写入文件：写临时文件 + fsync + rename，失败时清理临时文件 */
function atomicWriteFileSync(filePath: string, data: Buffer): void {
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

interface SlideItem {
  title?: string;
  bullets?: string[];
  paragraphs?: string[];
  table?: { headers?: string[]; rows: string[][] };
  images?: Array<{ data: string; x?: number; y?: number; width?: number; height?: number }>;
}

export function registerPptxTools(executor: AgentModelExecutor, fsBase: string): void {
  executor.registerTool(
    "pptx_create",
    {
      name: "pptx_create",
      description:
        "Create a Microsoft PowerPoint .pptx presentation with slides, text, bullets, tables, and images. " +
        "Use this tool when the user asks for a PowerPoint file or the active skill is powerpoint-pptx. " +
        "Images must be provided as base64 strings. After creating the file, always inform the user of the file path and that they can download it via /api/files/download/{path}.",
      parameters: {
        path: { type: "string", description: "Relative file path to create (e.g. outputs/slides.pptx)", required: true },
        title: { type: "string", description: "Presentation title (also used as the first slide title)", required: false },
        slides: {
          type: "array",
          description: "List of slides. Each slide can have title, bullets, paragraphs, table, images.",
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
    }
  );
}
