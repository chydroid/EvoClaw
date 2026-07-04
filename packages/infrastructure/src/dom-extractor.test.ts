/**
 * 索引化 DOM 提取器测试（借鉴 page-agent flatTreeToString）。
 *
 * 由于 CI 环境不便启动真实 Playwright 浏览器，也无 jsdom 依赖，
 * 这里用 vitest mock 模拟 Playwright 的 Page 对象，测试
 * PlaywrightBrowser 的 extractDom / clickByIndex / inputByIndex /
 * scrollByIndex / clearDomIndexes 方法的行为契约。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PlaywrightBrowser } from "./playwright-browser";

// 一个最简的 fake Element，模拟浏览器 DOM API 子集
interface FakeElement {
  tagName: string;
  attributes: Record<string, string>;
  textContent: string;
  value?: string;
  children: FakeElement[];
}

function el(tag: string, attrs: Record<string, string> = {}, text = "", children: FakeElement[] = []): FakeElement {
  return { tagName: tag.toUpperCase(), attributes: attrs, textContent: text, value: attrs["value"], children };
}

// 模拟浏览器内执行环境的辅助：把 FakeElement 树喂给提取函数
// 直接复刻 playwright-browser.ts 中 extractDom 内的 page.evaluate 回调逻辑
function runExtractorOnFakeTree(root: FakeElement, maxN = 200) {
  const selectorMap: Record<number, Record<string, unknown>> = {};
  const lines: string[] = [];
  let idx = 0;

  const INTERACTIVE_TAGS = ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"];
  const INTERACTIVE_ROLES = ["button", "link", "checkbox", "tab", "menuitem", "option", "combobox", "textbox", "switch", "radio"];

  function isInteractive(node: FakeElement): boolean {
    if (INTERACTIVE_TAGS.includes(node.tagName)) return true;
    const role = node.attributes["role"] || "";
    if (INTERACTIVE_ROLES.includes(role)) return true;
    if (node.attributes["contenteditable"] === "true") return true;
    if ("onclick" in node.attributes) return true;
    const tabIdx = node.attributes["tabindex"];
    if (tabIdx !== undefined && parseInt(tabIdx, 10) >= 0) return true;
    return false;
  }

  function isVisible(node: FakeElement): boolean {
    const style = node.attributes["style"] || "";
    if (style.includes("display:none") || style.includes("display: none")) return false;
    if (style.includes("visibility:hidden") || style.includes("visibility: hidden")) return false;
    if (/opacity:\s*0\b/.test(style)) return false;
    return true;
  }

  function getText(node: FakeElement): string {
    const ariaLabel = node.attributes["aria-label"];
    if (ariaLabel) return ariaLabel.trim().slice(0, 80);
    const title = node.attributes["title"];
    if (title) return title.trim().slice(0, 80);
    const placeholder = node.attributes["placeholder"];
    if (placeholder) return placeholder.trim().slice(0, 80);
    const alt = node.attributes["alt"];
    if (alt) return alt.trim().slice(0, 80);
    const text = node.textContent.trim();
    if (text) return text.slice(0, 80);
    if (node.value) return String(node.value).slice(0, 80);
    return "";
  }

  function walk(node: FakeElement): void {
    if (idx >= maxN) return;
    if (isInteractive(node) && isVisible(node)) {
      node.attributes["data-pa-idx"] = String(idx);
      const tag = node.tagName.toLowerCase();
      const role = node.attributes["role"] || "";
      const text = getText(node);
      const href = node.attributes["href"] || "";
      const type = node.attributes["type"] || "";
      const name = node.attributes["name"] || "";

      const parts: string[] = [`[${idx}]`];
      parts.push(`<${tag}`);
      if (role) parts.push(`role=${role}`);
      if (type) parts.push(`type=${type}`);
      if (name) parts.push(`name=${name}`);
      if (href) parts.push(`href="${href.slice(0, 50)}"`);
      parts.push(">");
      if (text) parts.push(text);
      lines.push(parts.join(" "));

      selectorMap[idx] = { tag, role, text, href: href.slice(0, 120), type, name, selector: `[data-pa-idx="${idx}"]` };
      idx++;
    }
    for (const child of node.children) walk(child);
  }

  walk(root);
  return { flatTree: lines.join("\n"), selectorMap, count: idx };
}

describe("PlaywrightBrowser 索引化 DOM 操作（借鉴 page-agent flatTreeToString）", () => {
  let browser: PlaywrightBrowser;
  let fakePage: { evaluate: ReturnType<typeof vi.fn>; waitForSelector: ReturnType<typeof vi.fn>; click: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn>; type: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    // activePage 是只读 getter，无法直接赋值；用 Object.defineProperty 在实例上覆盖
    browser = new PlaywrightBrowser({} as never, {} as never, { headless: true });
    fakePage = {
      evaluate: vi.fn(),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    };
    // 在实例上覆盖 activePage getter，返回 fakePage
    Object.defineProperty(browser, "activePage", {
      get: () => fakePage,
      configurable: true,
    });
  });

  describe("extractDom", () => {
    it("调用 page.evaluate 并返回扁平化结果", async () => {
      const fakeResult = {
        flatTree: "[0] <button > 登录",
        selectorMap: { 0: { tag: "button", selector: '[data-pa-idx="0"]' } },
        count: 1,
        url: "https://example.com/",
        title: "Example",
      };
      fakePage.evaluate.mockResolvedValue(fakeResult);

      const result = await browser.extractDom();
      expect(fakePage.evaluate).toHaveBeenCalledOnce();
      expect(result.flatTree).toContain("[0] <button > 登录");
      expect(result.count).toBe(1);
      expect(result.url).toBe("https://example.com/");
    });

    it("尊重 maxElements 参数", async () => {
      fakePage.evaluate.mockResolvedValue({ flatTree: "", selectorMap: {}, count: 0, url: "", title: "" });
      await browser.extractDom({ maxElements: 50 });
      // 验证 maxElements 被传给 evaluate
      const arg = fakePage.evaluate.mock.calls[0][1];
      expect(arg).toBe(50);
    });

    it("无活动页面时抛出错误", async () => {
      const freshBrowser = new PlaywrightBrowser({} as never, {} as never, { headless: true });
      await expect(freshBrowser.extractDom()).rejects.toThrow("No active page");
    });
  });

  describe("clickByIndex", () => {
    it("用 [data-pa-idx=\"N\"] 选择器点击", async () => {
      const result = await browser.clickByIndex(5);
      expect(fakePage.waitForSelector).toHaveBeenCalledWith('[data-pa-idx="5"]', { timeout: 10000 });
      expect(fakePage.click).toHaveBeenCalledWith('[data-pa-idx="5"]');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.index).toBe(5);
        expect(result.selector).toBe('[data-pa-idx="5"]');
      }
    });

    it("点击失败时返回 ok:false 和 error", async () => {
      fakePage.waitForSelector.mockRejectedValue(new Error("timeout"));
      const result = await browser.clickByIndex(99);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("timeout");
      }
    });
  });

  describe("inputByIndex", () => {
    it("默认清空后输入文本", async () => {
      const result = await browser.inputByIndex(3, "hello world");
      expect(fakePage.waitForSelector).toHaveBeenCalledWith('[data-pa-idx="3"]', { timeout: 10000 });
      expect(fakePage.fill).toHaveBeenCalledWith('[data-pa-idx="3"]', "");
      expect(fakePage.fill).toHaveBeenCalledWith('[data-pa-idx="3"]', "hello world");
      expect(result.ok).toBe(true);
    });

    it("clearFirst:false 跳过清空", async () => {
      fakePage.fill.mockClear();
      await browser.inputByIndex(0, "text", { clearFirst: false });
      // 只应调用一次 fill（输入文本），不调用清空
      expect(fakePage.fill).toHaveBeenCalledTimes(1);
      expect(fakePage.fill).toHaveBeenCalledWith('[data-pa-idx="0"]', "text");
    });

    it("带 delay 时用 page.type 逐字符输入", async () => {
      fakePage.fill.mockClear();
      await browser.inputByIndex(0, "abc", { delay: 50 });
      expect(fakePage.fill).toHaveBeenCalledWith('[data-pa-idx="0"]', "");
      expect(fakePage.type).toHaveBeenCalledWith('[data-pa-idx="0"]', "abc", { delay: 50 });
    });

    it("输入失败时返回 ok:false", async () => {
      fakePage.fill.mockRejectedValue(new Error("element not found"));
      const result = await browser.inputByIndex(0, "x");
      expect(result.ok).toBe(false);
    });
  });

  describe("scrollByIndex", () => {
    it("调用 element.scrollBy 进行滚动", async () => {
      const result = await browser.scrollByIndex(2, "down", 500);
      expect(fakePage.waitForSelector).toHaveBeenCalledWith('[data-pa-idx="2"]', { timeout: 10000 });
      expect(fakePage.evaluate).toHaveBeenCalled();
      // evaluate 的第二个参数是 [selector, dx, dy]
      const evalArg = fakePage.evaluate.mock.calls[0][1] as [string, number, number];
      expect(evalArg[0]).toBe('[data-pa-idx="2"]');
      expect(evalArg[2]).toBe(500); // dy for "down"
      expect(result.ok).toBe(true);
    });

    it("支持四个方向", async () => {
      for (const dir of ["up", "down", "left", "right"] as const) {
        fakePage.evaluate.mockClear();
        await browser.scrollByIndex(0, dir, 100);
        const evalArg = fakePage.evaluate.mock.calls[0][1] as [string, number, number];
        const [, dx, dy] = evalArg;
        if (dir === "up") expect(dy).toBe(-100);
        if (dir === "down") expect(dy).toBe(100);
        if (dir === "left") expect(dx).toBe(-100);
        if (dir === "right") expect(dx).toBe(100);
      }
    });
  });

  describe("clearDomIndexes", () => {
    it("调用 page.evaluate 清除所有 data-pa-idx 属性", async () => {
      await browser.clearDomIndexes();
      expect(fakePage.evaluate).toHaveBeenCalled();
    });

    it("出错时不抛出（静默失败）", async () => {
      fakePage.evaluate.mockRejectedValue(new Error("page closed"));
      await expect(browser.clearDomIndexes()).resolves.not.toThrow();
    });

    it("无活动页面时不抛出", async () => {
      const freshBrowser = new PlaywrightBrowser({} as never, {} as never, { headless: true });
      await expect(freshBrowser.clearDomIndexes()).resolves.not.toThrow();
    });
  });
});

describe("DOM 提取核心逻辑（纯函数验证）", () => {
  // 这些测试不依赖 Playwright，直接验证提取算法逻辑
  it("提取 button 和 a 元素并生成扁平化文本", () => {
    const tree = el("body", {}, "", [
      el("button", { id: "login" }, "登录"),
      el("a", { href: "/about" }, "关于"),
    ]);
    const result = runExtractorOnFakeTree(tree);
    expect(result.count).toBe(2);
    expect(result.flatTree).toContain("[0] <button > 登录");
    expect(result.flatTree).toContain('href="/about"');
  });

  it("跳过非交互元素", () => {
    const tree = el("body", {}, "", [
      el("div", {}, "纯文本"),
      el("p", {}, "段落"),
      el("button", {}, "点击"),
    ]);
    const result = runExtractorOnFakeTree(tree);
    expect(result.count).toBe(1);
  });

  it("aria-label 优先于 textContent", () => {
    const tree = el("body", {}, "", [
      el("button", { "aria-label": "关闭" }, "X"),
    ]);
    const result = runExtractorOnFakeTree(tree);
    expect(result.selectorMap[0].text).toBe("关闭");
  });

  it("跳过 display:none 的元素", () => {
    const tree = el("body", {}, "", [
      el("button", {}, "可见"),
      el("button", { style: "display:none" }, "隐藏"),
    ]);
    const result = runExtractorOnFakeTree(tree);
    expect(result.count).toBe(1);
    expect(result.selectorMap[0].text).toBe("可见");
  });

  it("尊重 maxElements 上限", () => {
    const buttons = Array.from({ length: 10 }, (_, i) => el("button", {}, `按钮${i}`));
    const tree = el("body", {}, "", buttons);
    const result = runExtractorOnFakeTree(tree, 5);
    expect(result.count).toBe(5);
  });

  it("长文本截断到 80 字符", () => {
    const tree = el("body", {}, "", [
      el("button", {}, "A".repeat(200)),
    ]);
    const result = runExtractorOnFakeTree(tree);
    expect((result.selectorMap[0].text as string).length).toBe(80);
  });

  it("识别 role=button 的 div", () => {
    const tree = el("body", {}, "", [
      el("div", { role: "button" }, "自定义按钮"),
    ]);
    const result = runExtractorOnFakeTree(tree);
    expect(result.count).toBe(1);
    expect(result.selectorMap[0].tag).toBe("div");
    expect(result.selectorMap[0].role).toBe("button");
  });

  it("selectorMap 生成正确的 selector 字段", () => {
    const tree = el("body", {}, "", [el("button", {}, "OK")]);
    const result = runExtractorOnFakeTree(tree);
    expect(result.selectorMap[0].selector).toBe('[data-pa-idx="0"]');
  });
});
