/**
 * PlaywrightBrowser 补全原语测试（browser_back/press/get_images/cdp/dialog/vision/vault 支撑）。
 *
 * 通过 as unknown as 注入 fake page / context（同 browser-controller.test.ts 模式），
 * 不启动真实 Chromium。覆盖：
 * - goBack / pressKey / getImages（含非法 JSON 容错）
 * - 原生对话框队列：捕获入队、accept/dismiss、超时自动 dismiss
 * - cdpSend：懒建 session、WeakMap 复用、targetId 路由、超时 race
 * - saveScreenshotToFile 原子落盘
 * - getPageOrigin / readCredentialsFromForm / fillPassword / fillOtp / fillAutofillFields
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { EventBus, ServiceRegistry } from "@evoclaw/core";
import { PlaywrightBrowser, PendingDialogInfo, PlaywrightTab } from "./playwright-browser";
import type { Page } from "playwright";

interface FakeDialog {
  type(): string;
  message(): string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

interface FakePageState {
  urlValue?: string;
  titleValue?: string;
  /** evaluate 收到字符串表达式（getImages）时的返回值。 */
  evaluateStringResult?: unknown;
  /** evaluate 收到函数表达式（getPageOrigin/readCredentialsFromForm）时的返回值。 */
  evaluateFnResult?: unknown;
  /** locator 调用是否抛错（模拟元素不存在）。 */
  locatorThrows?: boolean;
  /** 自定义 locator 实现（记录 fill 调用）。 */
  locatorImpl?: (sel: string, fills: Array<{ sel: string; value: string }>) => {
    waitFor(opts: unknown): Promise<void>;
    fill(value: string): Promise<void>;
  };
}

function makeFakePage(state: FakePageState = {}) {
  const dialogListeners: Array<(d: FakeDialog) => void> = [];
  const fills: Array<{ sel: string; value: string }> = [];
  const page = {
    goBack: vi.fn(async () => undefined),
    url: vi.fn(() => state.urlValue ?? "https://current.example.com"),
    title: vi.fn(async () => state.titleValue ?? "Current"),
    keyboard: { press: vi.fn(async () => undefined) },
    evaluate: vi.fn(async (expr: unknown) =>
      typeof expr === "string" ? state.evaluateStringResult : state.evaluateFnResult
    ),
    on: vi.fn((event: string, handler: (d: FakeDialog) => void) => {
      if (event === "dialog") dialogListeners.push(handler);
    }),
    screenshot: vi.fn(async () => Buffer.from("fake-png-bytes")),
    locator: vi.fn((sel: string) => {
      if (state.locatorThrows) throw new Error(`locator error: ${sel}`);
      const impl =
        state.locatorImpl ??
        ((s: string, fs2: Array<{ sel: string; value: string }>) => ({
          waitFor: async () => undefined,
          fill: async (v: string) => fs2.push({ sel: s, value: v }),
        }));
      return {
        first: () => impl(sel, fills),
      };
    }),
    close: vi.fn(async () => undefined),
  };
  return { page: page as unknown as Page, pageRaw: page, dialogListeners, fills };
}

function injectBrowser(
  browser: PlaywrightBrowser,
  page: Page,
  opts?: { context?: unknown; tabId?: string; launched?: boolean }
): void {
  const internal = browser as unknown as {
    launched: boolean;
    tabs: Map<string, PlaywrightTab>;
    activeTabId: string | null;
    context: unknown;
  };
  internal.launched = opts?.launched ?? true;
  // activePage getter 需要 context truthy
  if (opts?.context !== undefined) {
    internal.context = opts.context;
  } else {
    internal.context = {};
  }
  const tabId = opts?.tabId ?? "tab-1";
  internal.tabs.set(tabId, { id: tabId, page, url: "https://a.example.com", createdAt: new Date() });
  internal.activeTabId = tabId;
}

function makeBrowser(opts?: { dialogTimeoutMs?: number }) {
  const publish = vi.fn(async () => undefined);
  const browser = new PlaywrightBrowser(
    { resolveService: vi.fn(() => undefined) } as unknown as ServiceRegistry,
    { publish } as unknown as EventBus,
    { dialogTimeoutMs: opts?.dialogTimeoutMs }
  );
  return { browser, publish };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-browser-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("goBack / pressKey", () => {
  it("goBack 返回新 URL/标题并更新 tab、发布 navigated 事件", async () => {
    const { browser, publish } = makeBrowser();
    const fake = makeFakePage({ urlValue: "https://prev.example.com", titleValue: "Prev Page" });
    injectBrowser(browser, fake.page);

    const result = await browser.goBack();
    expect(result).toEqual({ url: "https://prev.example.com", title: "Prev Page" });
    expect(fake.pageRaw.goBack).toHaveBeenCalledWith({ waitUntil: "domcontentloaded", timeout: 30000 });
    expect(publish).toHaveBeenCalledWith(
      "playwright.navigated",
      { url: "https://prev.example.com", title: "Prev Page", status: 0 },
      "playwright-browser"
    );
    // tab.url 已同步
    const tabs = (browser as unknown as { tabs: Map<string, PlaywrightTab> }).tabs;
    expect(tabs.get("tab-1")!.url).toBe("https://prev.example.com");
  });

  it("pressKey 转发到 keyboard.press", async () => {
    const { browser } = makeBrowser();
    const fake = makeFakePage();
    injectBrowser(browser, fake.page);
    await browser.pressKey("Enter");
    expect(fake.pageRaw.keyboard.press).toHaveBeenCalledWith("Enter");
  });
});

describe("getImages", () => {
  it("解析 JSON 字符串结果", async () => {
    const { browser } = makeBrowser();
    const images = [
      { src: "https://a.example.com/1.png", alt: "a", width: 10, height: 20 },
      { src: "https://a.example.com/2.jpg", alt: "", width: 0, height: 0 },
    ];
    const fake = makeFakePage({ evaluateStringResult: JSON.stringify(images) });
    injectBrowser(browser, fake.page);
    expect(await browser.getImages()).toEqual(images);
  });

  it("非法 JSON 返回空数组（容错）", async () => {
    const { browser } = makeBrowser();
    const fake = makeFakePage({ evaluateStringResult: "not-json{{{" });
    injectBrowser(browser, fake.page);
    expect(await browser.getImages()).toEqual([]);
  });
});

describe("原生对话框队列", () => {
  it("捕获入队 → listDialogs 可见 → accept/dismiss 响应并清空", async () => {
    const { browser } = makeBrowser();
    const fake = makeFakePage();
    injectBrowser(browser, fake.page);
    // 直接调用私有钩子注册（生产路径在 navigate/newTab 创建 page 时调用）
    (browser as unknown as { registerDialogHooks(p: unknown): void }).registerDialogHooks(fake.page);

    const accept = vi.fn(async () => undefined);
    const dismiss = vi.fn(async () => undefined);
    const dialog: FakeDialog = {
      type: () => "alert",
      message: () => "hello world",
      accept,
      dismiss,
    };
    fake.dialogListeners[0](dialog);

    const pending = browser.listDialogs();
    expect(pending).toHaveLength(1);
    const info = pending[0];
    expect(info.type).toBe("alert");
    expect(info.message).toBe("hello world");
    expect(info.id).toMatch(/^dialog-[0-9a-f-]+$/);

    const ok = await browser.respondToDialog("accept", undefined, info.id);
    expect(ok.ok).toBe(true);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(browser.listDialogs()).toHaveLength(0);
  });

  it("无挂起对话框时 respondToDialog 返回错误指引", async () => {
    const { browser } = makeBrowser();
    const fake = makeFakePage();
    injectBrowser(browser, fake.page);
    const result = await browser.respondToDialog("accept");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("browser_extract_dom");
  });

  it("超时自动 dismiss（对齐 Hermes dialog_timeout_s 语义）", async () => {
    vi.useFakeTimers();
    const { browser } = makeBrowser({ dialogTimeoutMs: 50 });
    const fake = makeFakePage();
    injectBrowser(browser, fake.page);
    (browser as unknown as { registerDialogHooks(p: unknown): void }).registerDialogHooks(fake.page);

    const dismiss = vi.fn(async () => undefined);
    const dialog: FakeDialog = {
      type: () => "prompt",
      message: () => "enter value",
      accept: vi.fn(async () => undefined),
      dismiss,
    };
    fake.dialogListeners[0](dialog);
    expect(browser.listDialogs()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(browser.listDialogs()).toHaveLength(1); // 未超时
    await vi.advanceTimersByTimeAsync(2);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(browser.listDialogs()).toHaveLength(0); // 已自动 dismiss 并移除
  });
});

describe("cdpSend", () => {
  it("懒建 CDPSession 并复用（WeakMap），结果透传", async () => {
    const { browser } = makeBrowser();
    const fake = makeFakePage();
    injectBrowser(browser, fake.page);
    const send = vi.fn(async (m: string, p: unknown) => ({ method: m, params: p }));
    const newCDPSession = vi.fn(async () => ({ send }));
    (browser as unknown as { context: unknown }).context = { newCDPSession };

    const r1 = await browser.cdpSend("Target.getTargets");
    expect(r1).toEqual({ method: "Target.getTargets", params: {} });
    const r2 = await browser.cdpSend("Runtime.evaluate", { expression: "1+1" });
    expect(r2).toEqual({ method: "Runtime.evaluate", params: { expression: "1+1" } });
    expect(newCDPSession).toHaveBeenCalledTimes(1); // 复用同一 session
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("targetId 路由到指定 tab 的 page", async () => {
    const { browser } = makeBrowser();
    const fakeA = makeFakePage();
    const fakeB = makeFakePage();
    injectBrowser(browser, fakeA.page, { tabId: "tab-a" });
    const tabs = (browser as unknown as { tabs: Map<string, PlaywrightTab> }).tabs;
    tabs.set("tab-b", { id: "tab-b", page: fakeB.page, url: "https://b.example.com", createdAt: new Date() });
    const sessions: Record<string, { send: unknown }> = {};
    (browser as unknown as { context: unknown }).context = {
      newCDPSession: vi.fn(async (p: Page) => {
        const key = p === fakeA.page ? "A" : "B";
        sessions[key] = { send: vi.fn(async (m: string) => `${key}:${m}`) };
        return sessions[key];
      }),
    };

    const r = await browser.cdpSend("Runtime.evaluate", {}, { targetId: "tab-b" });
    expect(r).toBe("B:Runtime.evaluate");
    const miss = browser.cdpSend("Runtime.evaluate", {}, { targetId: "tab-nope" });
    await expect(miss).rejects.toThrow(/Tab not found: tab-nope/);
  });

  it("超时经 race 拒绝（send 永不返回）", async () => {
    const { browser } = makeBrowser();
    const fake = makeFakePage();
    injectBrowser(browser, fake.page);
    (browser as unknown as { context: unknown }).context = {
      newCDPSession: async () => ({ send: () => new Promise(() => undefined) }),
    };
    await expect(browser.cdpSend("Slow.Call", {}, { timeoutMs: 50 })).rejects.toThrow(
      /CDP command Slow.Call timed out after 50ms/
    );
  });
});

describe("截图落盘 / origin / 表单读取", () => {
  it("saveScreenshotToFile 原子写并返回路径/大小", async () => {
    const { browser } = makeBrowser();
    const fake = makeFakePage();
    injectBrowser(browser, fake.page);
    const { path: savedPath, size } = await browser.saveScreenshotToFile(dir, "shot.png");
    expect(savedPath).toBe(path.join(dir, "shot.png"));
    expect(size).toBe("fake-png-bytes".length);
    expect(fs.readFileSync(savedPath, "utf-8")).toBe("fake-png-bytes");
  });

  it("getPageOrigin 返回规范化 origin；about:blank → null", async () => {
    const { browser } = makeBrowser();
    const fake = makeFakePage({ evaluateFnResult: "https://shop.example.com/item?id=1" });
    injectBrowser(browser, fake.page);
    expect(await browser.getPageOrigin()).toBe("https://shop.example.com");

    fake.pageRaw.evaluate.mockResolvedValueOnce("about:blank");
    expect(await browser.getPageOrigin()).toBeNull();
  });

  it("readCredentialsFromForm 读取已填值；无密码字段 → null", async () => {
    const { browser } = makeBrowser();
    const fake = makeFakePage({
      evaluateFnResult: { identifier: "user@example.com", password: "hunter2" },
    });
    injectBrowser(browser, fake.page);
    expect(await browser.readCredentialsFromForm()).toEqual({
      identifier: "user@example.com",
      password: "hunter2",
    });

    fake.pageRaw.evaluate.mockResolvedValueOnce(null);
    expect(await browser.readCredentialsFromForm()).toBeNull();
  });
});

describe("vault 填充原语", () => {
  it("fillPassword 命中密码字段；locator 抛错 → false", async () => {
    const { browser } = makeBrowser();
    const fake = makeFakePage();
    injectBrowser(browser, fake.page);
    expect(await browser.fillPassword("s3cret")).toBe(true);
    expect(fake.fills).toEqual([{ sel: 'input[type="password"]', value: "s3cret" }]);

    const fake2 = makeFakePage({ locatorThrows: true });
    injectBrowser(browser, fake2.page);
    expect(await browser.fillPassword("s3cret")).toBe(false);
  });

  it("fillOtp 遍历选择器直到命中；全部失败 → false", async () => {
    const { browser } = makeBrowser();
    // 命中第三个选择器（input[name*="otp" i]）
    const fake = makeFakePage({
      locatorImpl: (sel, fills) => {
        const okSel = 'input[name*="otp" i]';
        return {
          waitFor: async () => {
            if (sel !== okSel) throw new Error("no");
          },
          fill: async (v: string) => { fills.push({ sel, value: v }); },
        };
      },
    });
    injectBrowser(browser, fake.page);
    expect(await browser.fillOtp("123456")).toBe(true);
    expect(fake.fills[0]).toEqual({ sel: 'input[name*="otp" i]', value: "123456" });

    const fake2 = makeFakePage({ locatorThrows: true });
    injectBrowser(browser, fake2.page);
    expect(await browser.fillOtp("123456")).toBe(false);
  });

  it("fillAutofillFields 按 token 映射选择器；未知 token → missing；只回传 token 名", async () => {
    const { browser } = makeBrowser();
    const fake = makeFakePage();
    injectBrowser(browser, fake.page);
    const res = await browser.fillAutofillFields({
      username: "u@example.com",
      cc_number: "4111111111111111",
      unknown_token: "x",
    });
    expect(res.filled.sort()).toEqual(["cc_number", "username"]);
    expect(res.missing).toEqual(["unknown_token"]);
    // fill 记录含值（服务端内存），但返回结构只含 token 名
    expect(fake.fills).toHaveLength(2);
    expect(res).not.toHaveProperty("fills");
  });
});
