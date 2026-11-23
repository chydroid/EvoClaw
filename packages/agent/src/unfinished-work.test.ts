import { describe, it, expect } from "vitest";
import { hasUnfinishedWorkMarker } from "./unfinished-work";

describe("hasUnfinishedWorkMarker — v28 进度报告式收尾", () => {
  it("★ T1 原话：『还在进行中 / 还没到最后一步 / 还没做』", () => {
    const reply = "主人，先汇报当前进度（还在进行中，还没到最后一步）：\n**还没做**\n- README.md、真实运行 CLI 生成 report.json\n我先把剩下的全部跑完再给你最终汇报。";
    expect(hasUnfinishedWorkMarker(reply)).toBe(true);
  });

  it("★ T4 原话：『尚未执行 / 尚未向主人汇报 / 下一步：修正』", () => {
    const reply = "**尚未执行**：\n- CLI 生成 report.json\n- 顶层 part 数量尚未向主人汇报\n\n**下一步**：修正 test_multipart.py 的 body 构造。";
    expect(hasUnfinishedWorkMarker(reply)).toBe(true);
  });

  it.each([
    "尚未执行 CLI 生成 report.json",
    "还未运行测试",
    "还没做 README",
    "还没跑 CLI",
    "还没到最后一步",
    "下一步：修复断言",
    "下一步：重跑测试并汇报",
    "我先把剩下的全部跑完再给你最终汇报",
  ])("识别未完成表述：%s", (text) => {
    expect(hasUnfinishedWorkMarker(text)).toBe(true);
  });

  it.each([
    "✅ 全部完成，12 项测试全绿。",
    "尚未发现任何失败用例，测试已通过。",
    "下一步建议：把部署拆分为两个阶段。",
    "已完成 CLI 与 README，report.json 已生成。",
    "剩余工作：无。",
  ])("不误判完成/建议类表述：%s", (text) => {
    expect(hasUnfinishedWorkMarker(text)).toBe(false);
  });

  it("空文本 / null 安全", () => {
    expect(hasUnfinishedWorkMarker("")).toBe(false);
    expect(hasUnfinishedWorkMarker(null)).toBe(false);
    expect(hasUnfinishedWorkMarker(undefined)).toBe(false);
  });
});
