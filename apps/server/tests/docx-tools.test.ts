import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerDocxTools } from "../src/tools/docx-tools";

describe("docx_create tool", () => {
  let tmpDir: string;
  let handler: (params: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-test-"));
    const executor = {
      registerTool: (_name: string, _definition: unknown, fn: (params: Record<string, unknown>) => Promise<unknown>) => {
        handler = fn;
      },
    };
    registerDocxTools(executor as any, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("创建包含标题、段落和表格的 DOCX 文件", async () => {
    const result = (await handler({
      path: "report.docx",
      title: "EvoClaw 介绍",
      paragraphs: [
        "EvoClaw 是一个自进化的 AI 助手平台。",
        { text: "核心能力", heading: true },
        { text: "支持多智能体协作", bullet: true },
        { text: "内置技能与插件生态", bullet: true },
      ],
      tables: [
        {
          headers: ["模块", "说明"],
          rows: [
            ["core", "服务注册、事件总线、配置管理"],
            ["agent", "任务编排、Actor 系统、路由"],
          ],
        },
      ],
      overwrite: true,
    })) as { success: boolean; path: string; size: number };

    expect(result.success).toBe(true);
    expect(result.path).toBe("report.docx");
    expect(result.size).toBeGreaterThan(0);

    const filePath = path.join(tmpDir, "report.docx");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).size).toBeGreaterThan(0);
  });

  it("拒绝路径穿越", async () => {
    const result = (await handler({
      path: "../outside.docx",
      title: "Bad",
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Path traversal blocked");
  });
});
