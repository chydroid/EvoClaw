import { describe, it, expect } from "vitest";
import { createBuiltinToolChainRegistry } from "./tool-chain-registry";

/**
 * ★ v25 Task 2/3/6/9/10 回归（2026-11-22）：内置工具链关键词匹配
 * 旧实现单关键词子串命中即返回，通用英文词（and/the/key/web/page）会
 * 命中中文工程任务——`KeyError` 含 "key" → 推荐 web_fetch 抓网页；
 * 5/10 个本地交付任务收到错误工具链指令。
 * 现在：整词边界 + 停用词 + 至少 2 个关键词。
 */
describe("ToolChainRegistry.findRelevantChain（v25 误匹配回归）", () => {
  const reg = createBuiltinToolChainRegistry();

  it("中文工程任务不再因 KeyError/通用词误命中网页链", () => {
    const cases = [
      "在 /w/v25-t2/ 交付零依赖 Python 电子表格公式引擎。evaluate 引用不存在单元格抛 KeyError 或 ValueError。条件支持数值比较。",
      "在 /w/v25-t3/ 交付双表查询优化器：谓词下推 + 投影裁剪，分析执行计划并排序。",
      "在 /w/v25-t6/ 交付容器镜像层去重分析工具，输出 unique_layers 与 per_image 拉取计划。",
      "在 /w/v25-t9/ 交付消息队列消费者组再均衡（range assignor），比较各代际分区分配。",
      "对比两个 JSON 文件并输出差异摘要，分析字段变化。",
    ];
    for (const msg of cases) {
      expect(reg.findRelevantChain(msg), msg.slice(0, 40)).toBeNull();
    }
  });

  it("真实网页抓取/检索意图仍命中", () => {
    expect(reg.findRelevantChain("Fetch https://example.com and extract the page title")?.name)
      .toBe("fetch-and-extract");
    expect(reg.findRelevantChain("search the web and summarize the results")?.name)
      .toBe("search-and-summarize");
    expect(reg.findRelevantChain("research the topic by searching and summarizing")?.name)
      .toBe("research-topic");
    expect(reg.findRelevantChain("navigate to example.com in the browser and take a screenshot")?.name)
      .toBe("navigate-and-screenshot");
  });

  it("单词命中不再足够（至少 2 个整词关键词）", () => {
    expect(reg.findRelevantChain("please fetch this")).toBeNull();
    expect(reg.findRelevantChain("extract fields from the JSON file")).toBeNull();
  });
});
