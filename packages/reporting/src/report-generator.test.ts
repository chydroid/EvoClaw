/**
 * ReportGenerator.sections 归一化回归测试
 *
 * 缺陷（eval30 a26 暴露）：调用方常把 sections 传成纯字符串数组（如
 * ["收入概览","支出分析"]），而模板按 section.type 分支渲染。字符串 section
 * 缺 type/title，被 Handlebars 渲染成空 <h2></h2> 与空 section-content——
 * 章节标题与内容全部丢失。enrichData 需把字符串 section 归一化成
 * { type:"text", title, content }，对象 section 保持不变。
 */
import { describe, it, expect } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { ReportGenerator, type ReportData } from "@evoclaw/reporting";

async function makeGenerator(): Promise<ReportGenerator> {
  const reg = new ServiceRegistry();
  const bus = new EventBus();
  reg.registerService("eventBus", bus);
  const rg = new ReportGenerator(reg, bus);
  await rg.initialize();
  return rg;
}

function emptyH2(html: string): number {
  return (html.match(/<h2><\/h2>/g) || []).length;
}

describe("ReportGenerator sections 归一化", () => {
  it("字符串 sections 渲染出章节标题（不再空 <h2></h2>）", async () => {
    const rg = await makeGenerator();
    const data: ReportData = {
      title: "Q4 月度经营报告",
      generatedAt: "2026-10-23",
      sections: ["收入概览", "支出分析", "利润趋势"] as unknown as ReportData["sections"],
    };
    const html = rg.generateReport(data);
    // 修复点：字符串章节标题必须出现在渲染结果里
    for (const t of ["收入概览", "支出分析", "利润趋势"]) {
      expect(html).toContain(t);
    }
    expect(emptyH2(html)).toBe(0);
  });

  it("对象 sections（显式 type）渲染行为不变", async () => {
    const rg = await makeGenerator();
    const data: ReportData = {
      title: "X",
      generatedAt: "2026-10-23",
      sections: [
        { id: "a", title: "章节A", type: "text", content: "正文A" },
      ],
    };
    const html = rg.generateReport(data);
    expect(html).toContain("章节A");
    expect(html).toContain("正文A");
    expect(emptyH2(html)).toBe(0);
  });

  it("混合（字符串 + 对象）sections 全部正常渲染", async () => {
    const rg = await makeGenerator();
    const data: ReportData = {
      title: "M",
      generatedAt: "2026-10-23",
      sections: [
        "纯文本章节",
        { id: "b", title: "指标", type: "metrics", metrics: [{ label: "收入", value: 120 }] },
      ] as unknown as ReportData["sections"],
    };
    const html = rg.generateReport(data);
    expect(html).toContain("纯文本章节");
    expect(html).toContain("指标");
    expect(html).toContain("120");
    expect(emptyH2(html)).toBe(0);
  });
});
