import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerXlsxTools } from "../src/tools/xlsx-tools";

describe("xlsx_create tool", () => {
  let tmpDir: string;
  let handler: (params: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xlsx-test-"));
    const executor = {
      registerTool: (_name: string, _definition: unknown, fn: (params: Record<string, unknown>) => Promise<unknown>) => {
        handler = fn;
      },
    };
    registerXlsxTools(executor as any, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("创建包含表头和数据行的 XLSX 文件", async () => {
    const result = (await handler({
      path: "report.xlsx",
      sheets: [
        {
          name: "EvoClaw 模块",
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
    expect(result.path).toBe("report.xlsx");
    expect(result.size).toBeGreaterThan(0);

    const filePath = path.join(tmpDir, "report.xlsx");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).size).toBeGreaterThan(0);
  });

  it("拒绝路径穿越", async () => {
    const result = (await handler({
      path: "../outside.xlsx",
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Path traversal blocked");
  });
});
