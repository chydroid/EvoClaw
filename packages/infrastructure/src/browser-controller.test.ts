/**
 * BrowserController.findElements / getText 回归测试
 *
 * 事故（2026-10-15 browser-eval b01）：findElements 曾在 bodyPreview 上匹配——
 * bodyPreview 是剥掉全部 HTML 标签后的预览文本，class="x" / id="x" / <tag> 三种
 * selector 模式**永远命中 0 次**，browser_find_elements/browser_get_text 形同虚设，
 * agent 被逼去用 shell_exec + node fetch 绕过浏览器工具。
 * 修复后 selector 匹配基于 rawHtml（navigate/submitForm 时保存的完整 HTML）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { BrowserController } from "./browser-controller";

const QUOTES_HTML = `<html><head><title>Quotes to Scrape</title></head><body>
${Array.from({ length: 10 }, (_, i) =>
  `<div class="quote"><span class="text">“Quote text number ${i}.”</span><small class="author">Author ${i}</small></div>`
).join("")}
<a href="/tag/life">life</a>
</body></html>`;

/** 旧 bug 的复现数据：bodyPreview 是剥标签后的文本，不含任何 class=/id=/开标签。 */
const PREVIEW_ONLY = "Quotes to Scrape Quotes to Scrape Quote text number 0.";

function setControllerPage(ctrl: BrowserController, rawHtml: string, bodyPreview: string): void {
  // 直接置入 currentPage，绕开 navigate() 的真实网络请求
  (ctrl as unknown as { currentPage: unknown }).currentPage = {
    success: true,
    url: "https://example.test/",
    title: "Quotes to Scrape",
    status: 200,
    bodyPreview,
    rawHtml,
    links: [],
    forms: [],
  };
}

describe("BrowserController.findElements / getText 基于 rawHtml 匹配（回归）", () => {
  let ctrl: BrowserController;

  beforeEach(() => {
    ctrl = new BrowserController(new ServiceRegistry(), new EventBus());
  });

  it("标签选择器：div.quote 在原始 HTML 上精确计数 10 条（旧实现在预览文本上恒为 0）", async () => {
    setControllerPage(ctrl, QUOTES_HTML, PREVIEW_ONLY);
    const elements = await ctrl.findElements("div.quote");
    expect(elements.length).toBe(10);
    expect(elements[0].text).toContain("Quote text number 0");
  });

  it("类选择器：.text 命中 span class=\"text\"（预览文本里无 class= 属性，旧实现必为 0）", async () => {
    setControllerPage(ctrl, QUOTES_HTML, PREVIEW_ONLY);
    const elements = await ctrl.findElements(".text");
    expect(elements.length).toBeGreaterThan(0);
    expect(elements[0].attributes.class).toBe("text");
  });

  it("id 选择器：#main 在 rawHtml 的 id=\"main\" 上命中", async () => {
    setControllerPage(ctrl, `<html><body id="main"><p>x</p></body></html>`, "x");
    const elements = await ctrl.findElements("#main");
    expect(elements.length).toBe(1);
    expect(elements[0].attributes.id).toBe("main");
  });

  it("getText：.quote 选择器能聚合出引用文本（旧实现返回空字符串）", async () => {
    setControllerPage(ctrl, QUOTES_HTML, PREVIEW_ONLY);
    const text = await ctrl.getText(".quote");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("Quote text number 0");
  });

  it("退化路径：无 rawHtml 的旧调用方数据（仅 bodyPreview）仍可用类/标签正则兜底", async () => {
    const legacy = {
      success: true,
      url: "https://example.test/",
      title: "t",
      status: 200,
      bodyPreview: `<title>t</title> text only`,
      links: [] as Array<{ text: string; href: string }>,
      forms: [] as Array<{ action: string; method: string; fields: string[] }>,
    };
    (ctrl as unknown as { currentPage: unknown }).currentPage = legacy;
    // legacy 数据没有 rawHtml 字段（旧结构）→ source 退化到 bodyPreview，
    // 只要 preview 里恰好含标签片段仍可匹配；这是向后兼容而非新能力
    const elements = await ctrl.findElements("title");
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  it("未导航时 findElements 抛 No page loaded", async () => {
    await expect(ctrl.findElements("div")).rejects.toThrow("No page loaded");
  });
});
