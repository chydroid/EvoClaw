import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerPptxTools } from "../src/tools/pptx-tools";

describe("pptx_create tool", () => {
  let tmpDir: string;
  let handler: (params: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-test-"));
    const executor = {
      registerTool: (_name: string, _definition: unknown, fn: (params: Record<string, unknown>) => Promise<unknown>) => {
        handler = fn;
      },
    };
    registerPptxTools(executor as any, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("创建包含标题、要点和表格的 PPTX 文件", async () => {
    const result = (await handler({
      path: "slides.pptx",
      title: "EvoClaw 介绍",
      slides: [
        {
          title: "核心能力",
          bullets: ["多智能体协作", "内置技能生态", "自进化引擎"],
        },
        {
          title: "模块表格",
          table: {
            headers: ["模块", "说明"],
            rows: [
              ["core", "服务注册与配置"],
              ["agent", "任务编排与路由"],
            ],
          },
        },
      ],
      overwrite: true,
    })) as { success: boolean; path: string; size: number };

    expect(result.success).toBe(true);
    expect(result.path).toBe("slides.pptx");
    expect(result.size).toBeGreaterThan(0);

    const filePath = path.join(tmpDir, "slides.pptx");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).size).toBeGreaterThan(0);
  });

  it("拒绝路径穿越", async () => {
    const result = (await handler({
      path: "../outside.pptx",
      title: "Bad",
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Path traversal blocked");
  });
});
