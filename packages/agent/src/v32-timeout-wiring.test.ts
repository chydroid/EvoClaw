import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * v32 举一反三回归：所有会喂 provider 失败记账的旁路 LLM 调用必须与主请求
 * 共用 resolveLlmRequestTimeoutMs（含 reasoning floor），禁止硬编码 10s/30s。
 * 源码级断言补上单测盲区——这两条旁路此前无测试文件覆盖。
 */
const src = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf-8");

describe("v32 旁路 LLM 超时接线（brief-understanding / planning-engine）", () => {
  for (const file of ["brief-understanding.ts", "planning-engine.ts"]) {
    it(`${file} 使用 resolveLlmRequestTimeoutMs 而非硬编码短超时`, () => {
      const code = src(file);
      expect(code).toContain("resolveLlmRequestTimeoutMs(provider)");
      expect(code).not.toMatch(/setTimeout\([^;]*,\s*(10_?000|30_?000)\)/);
    });
  }
});
