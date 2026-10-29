/**
 * Browser 补全工具集注册与路由测试（对标 Hermes Tier 7 契约）。
 *
 * 验证：
 * - 8 个工具全部注册，schema 契约（必填/枚举/checkFn 门控）
 * - browser_back SSRF 复查（允许/阻断两路）
 * - browser_dialog 响应携带 pending_dialogs
 * - browser_vault：list/fill(origin 精确匹配)/save_login/enter_code/unlock
 *   的 model-blind 契约（密码/卡号/验证码绝不出现在工具结果 JSON 中）
 * - browser_exec：PATH 门控 + stdin 执行 + 会话名校验
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { registerBrowserCompletionTools } from "../src/tools/browser-completion-tools";
import { BrowserVault } from "@evoclaw/agent";

interface Registered {
  name: string;
  definition: { name: string; description: string; parameters: Record<string, unknown> };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  checkFn?: () => boolean;
}

const RFC6238_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

interface HarnessOpts {
  vaultDir?: string;
  ssrfAllowed?: boolean;
  permissionStatus?: "approved" | "denied" | "pending";
  visionAnalyzer?: boolean;
}

function createHarness(opts: HarnessOpts = {}) {
  const registered: Registered[] = [];
  const toolExecutor = {
    registerTool(
      name: string,
      definition: Registered["definition"],
      handler: Registered["handler"],
      checkFn?: () => boolean
    ) {
      registered.push({ name, definition, handler, checkFn });
    },
  };

  const pwBrowser = {
    isLaunched: true,
    goBack: vi.fn(async () => ({ url: "https://prev.example.com", title: "Prev" })),
    pressKey: vi.fn(async () => undefined),
    getImages: vi.fn(async () => [
      { src: "https://a.example.com/1.png", alt: "a", width: 10, height: 10 },
    ]),
    saveScreenshotToFile: vi.fn(async (dir: string, filename: string) => {
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, filename);
      fs.writeFileSync(p, "fake-png");
      return { path: p, size: 8 };
    }),
    evaluateJS: vi.fn(async () => []),
    cdpSend: vi.fn(async (method: string, params: unknown) => ({ method, params })),
    listDialogs: vi.fn(() => []),
    respondToDialog: vi.fn(async () => ({
      ok: true as const,
      dialog: { id: "dialog-1", type: "alert", message: "hi", appearedAt: 1 },
    })),
    getPageOrigin: vi.fn(async () => "https://shop.example.com"),
    readCredentialsFromForm: vi.fn(async () => ({ identifier: "user@example.com", password: "hunter2" })),
    fillPassword: vi.fn(async (s: string) => true),
    fillOtp: vi.fn(async (c: string) => true),
    fillAutofillFields: vi.fn(async (fields: Record<string, string>) => ({
      filled: Object.keys(fields),
      missing: [],
    })),
  };

  const registry = {
    resolveService(name: string) {
      if (name === "browserVault") return opts.vaultDir ? new BrowserVault(opts.vaultDir) : undefined;
      if (name === "ssrfProtection") {
        return { checkURL: vi.fn(async () => ({ allowed: opts.ssrfAllowed ?? true, reason: "test" })) };
      }
      if (name === "permissionManager") {
        return {
          requestPermission: vi.fn(() => ({ id: "r1", status: opts.permissionStatus ?? "approved" })),
        };
      }
      if (name === "visionAnalyzer" && opts.visionAnalyzer) {
        return {
          analyze: vi.fn(async () => ({ description: "a page with a form", elements: [], issues: [] })),
        };
      }
      return undefined;
    },
  };

  registerBrowserCompletionTools({
    executor: toolExecutor as never,
    playwrightBrowser: pwBrowser as never,
    registry: registry as never,
    eventBus: { publish: async () => undefined } as never,
  });

  const byName = (n: string) => registered.find((r) => r.name === n)!;
  return { registered, byName, pwBrowser, registry };
}

let vaultDir: string;
beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "bct-vault-"));
});
afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

describe("工具注册与 schema 契约", () => {
  it("8 个工具全部注册", () => {
    const h = createHarness();
    expect(h.registered.map((r) => r.name).sort()).toEqual([
      "browser_back",
      "browser_cdp",
      "browser_dialog",
      "browser_exec",
      "browser_get_images",
      "browser_press",
      "browser_vault",
      "browser_vision",
    ]);
  });

  it("schema：必填参数与枚举", () => {
    const h = createHarness();
    // browser_back / browser_get_images 无参数
    expect(h.byName("browser_back").definition.parameters).toEqual({});
    expect(h.byName("browser_get_images").definition.parameters).toEqual({});
    // browser_press key 必填
    const pressParams = h.byName("browser_press").definition.parameters as Record<string, Record<string, unknown>>;
    expect(pressParams.key.required).toBe(true);
    // browser_cdp method 必填 + timeout 默认 30
    const cdpParams = h.byName("browser_cdp").definition.parameters as Record<string, Record<string, unknown>>;
    expect(cdpParams.method.required).toBe(true);
    expect(cdpParams.timeout.default).toBe(30);
    // browser_dialog action 枚举
    const dialogParams = h.byName("browser_dialog").definition.parameters as Record<string, Record<string, unknown>>;
    expect(dialogParams.action.enum).toEqual(["accept", "dismiss"]);
    // browser_vault action 枚举
    const vaultParams = h.byName("browser_vault").definition.parameters as Record<string, Record<string, unknown>>;
    expect(vaultParams.action.enum).toEqual(["list", "fill", "save_login", "enter_code", "unlock"]);
    // browser_exec code 必填
    const execParams = h.byName("browser_exec").definition.parameters as Record<string, Record<string, unknown>>;
    expect(execParams.code.required).toBe(true);
  });

  it("checkFn 门控：browser_cdp 随 isLaunched；browser_exec 随 PATH 二进制", () => {
    const h = createHarness();
    expect(h.byName("browser_cdp").checkFn!()).toBe(true);
    h.pwBrowser.isLaunched = false;
    expect(h.byName("browser_cdp").checkFn!()).toBe(false);
    // browser_exec 的 checkFn 依赖 PATH（空目录 → false）
    const origPath = process.env.PATH;
    try {
      process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "empty-bin-"));
      expect(h.byName("browser_exec").checkFn!()).toBe(false);
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe("browser_back / press / get_images / vision", () => {
  it("back：成功透传 url/title", async () => {
    const h = createHarness();
    const out = (await h.byName("browser_back").handler({})) as Record<string, unknown>;
    expect(out).toEqual({ success: true, url: "https://prev.example.com", title: "Prev" });
  });

  it("back：SSRF 阻断时返回 blocked", async () => {
    const h = createHarness({ ssrfAllowed: false });
    const out = (await h.byName("browser_back").handler({})) as Record<string, unknown>;
    expect(out.success).toBe(false);
    expect(out.error).toContain("blocked by security policy");
    expect(out.url).toBe("https://prev.example.com");
  });

  it("back：无页面（goBack 抛错）→ success false", async () => {
    const h = createHarness();
    h.pwBrowser.goBack = vi.fn(async () => { throw new Error("No active page"); });
    const out = (await h.byName("browser_back").handler({})) as Record<string, unknown>;
    expect(out.success).toBe(false);
  });

  it("press：缺 key 报错；否则转发", async () => {
    const h = createHarness();
    const missing = (await h.byName("browser_press").handler({})) as Record<string, unknown>;
    expect(missing.success).toBe(false);
    const ok = (await h.byName("browser_press").handler({ key: "Enter" })) as Record<string, unknown>;
    expect(ok).toEqual({ success: true, pressed: "Enter" });
    expect(h.pwBrowser.pressKey).toHaveBeenCalledWith("Enter");
  });

  it("get_images：返回 images + count", async () => {
    const h = createHarness();
    const out = (await h.byName("browser_get_images").handler({})) as Record<string, unknown>;
    expect(out.success).toBe(true);
    expect(out.count).toBe(1);
    expect((out.images as Array<{ src: string }>)[0].src).toBe("https://a.example.com/1.png");
  });

  it("vision：无 VLM 时回退截图路径 + note", async () => {
    const h = createHarness();
    const out = (await h.byName("browser_vision").handler({ question: "what is this?" })) as Record<string, unknown>;
    expect(out.success).toBe(true);
    expect(out.screenshot_path).toMatch(/browser_screenshot_[0-9a-f]{32}\.png$/);
    expect(out.note).toContain("No vision model configured");
  });

  it("vision：VLM 可用时附带 analysis", async () => {
    const h = createHarness({ visionAnalyzer: true });
    const out = (await h.byName("browser_vision").handler({ question: "describe" })) as Record<string, unknown>;
    expect(out.success).toBe(true);
    expect(out.analysis).toBe("a page with a form");
  });
});

describe("browser_cdp / dialog", () => {
  it("cdp：method 必填校验 + timeout 换算", async () => {
    const h = createHarness();
    const missing = (await h.byName("browser_cdp").handler({})) as Record<string, unknown>;
    expect(missing.success).toBe(false);
    const out = (await h.byName("browser_cdp").handler({ method: "Target.getTargets", timeout: 5 })) as Record<string, unknown>;
    expect(out.success).toBe(true);
    expect(out.result).toEqual({ method: "Target.getTargets", params: {} });
    expect(h.pwBrowser.cdpSend).toHaveBeenCalledWith("Target.getTargets", {}, { targetId: undefined, timeoutMs: 5000 });
  });

  it("cdp：params 非对象被拒", async () => {
    const h = createHarness();
    const out = (await h.byName("browser_cdp").handler({ method: "X", params: [1, 2] })) as Record<string, unknown>;
    expect(out.success).toBe(false);
  });

  it("dialog：非法 action 报错；成功响应携带 pending_dialogs", async () => {
    const h = createHarness();
    const bad = (await h.byName("browser_dialog").handler({ action: "foo" })) as Record<string, unknown>;
    expect(bad.success).toBe(false);
    const ok = (await h.byName("browser_dialog").handler({ action: "accept", prompt_text: "x" })) as Record<string, unknown>;
    expect(ok.success).toBe(true);
    expect((ok.dialog as Record<string, unknown>).id).toBe("dialog-1");
    expect(ok.pending_dialogs).toEqual([]);
  });
});

describe("browser_vault", () => {
  it("list：空库给出 hint；有条目返回元数据", async () => {
    const h = createHarness({ vaultDir });
    const empty = (await h.byName("browser_vault").handler({ action: "list" })) as Record<string, unknown>;
    expect(empty.success).toBe(true);
    expect(empty.items).toEqual([]);
    expect(empty.hint).toContain("save_login");

    const vault = new BrowserVault(vaultDir);
    vault.addItem({ kind: "login", label: "Shop", origin: "https://shop.example.com", password: "hunter2" });
    const withItems = (await h.byName("browser_vault").handler({ action: "list" })) as Record<string, unknown>;
    expect(withItems.items).toHaveLength(1);
    expect((withItems.items as Array<{ label: string }>)[0].label).toBe("Shop");
    expect(JSON.stringify(withItems)).not.toContain("hunter2");
  });

  it("fill login：origin 不匹配拒绝；匹配则服务端填密码且不回显", async () => {
    const h = createHarness({ vaultDir });
    const vault = new BrowserVault(vaultDir);
    const meta = vault.addItem({ kind: "login", label: "Shop", origin: "https://shop.example.com", password: "hunter2" });

    // origin 不匹配
    h.pwBrowser.getPageOrigin = vi.fn(async () => "https://evil.example.com");
    const refused = (await h.byName("browser_vault").handler({ action: "fill", handle: meta.handle })) as Record<string, unknown>;
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("does not match");
    expect(h.pwBrowser.fillPassword).not.toHaveBeenCalled();

    // origin 匹配：密码经服务端 fillPassword，工具结果不含密码
    h.pwBrowser.getPageOrigin = vi.fn(async () => "https://shop.example.com");
    const ok = (await h.byName("browser_vault").handler({ action: "fill", handle: meta.handle })) as Record<string, unknown>;
    expect(ok).toEqual({ success: true, filled_fields: 1, kind: "login", origin: "https://shop.example.com" });
    expect(h.pwBrowser.fillPassword).toHaveBeenCalledWith("hunter2");
    expect(JSON.stringify(ok)).not.toContain("hunter2");
  });

  it("fill payment：denied 阻断；approved 后服务端批量填且不回显卡值", async () => {
    const denied = createHarness({ vaultDir, permissionStatus: "denied" });
    const vaultD = new BrowserVault(vaultDir);
    const metaD = vaultD.addItem({
      kind: "payment",
      label: "Card",
      origin: "https://shop.example.com",
      fields: { cc_number: "4111111111111111", cc_csc: "123" },
    });
    const outD = (await denied.byName("browser_vault").handler({ action: "fill", handle: metaD.handle })) as Record<string, unknown>;
    expect(outD.success).toBe(false);
    expect(outD.error).toContain("Permission denied");
    expect(denied.pwBrowser.fillAutofillFields).not.toHaveBeenCalled();

    const approved = createHarness({ vaultDir, permissionStatus: "approved" });
    const vaultA = new BrowserVault(vaultDir);
    const metaA = vaultA.addItem({
      kind: "payment",
      label: "Card",
      origin: "https://shop.example.com",
      fields: { cc_number: "4111111111111111", cc_csc: "123" },
    });
    const outA = (await approved.byName("browser_vault").handler({ action: "fill", handle: metaA.handle })) as Record<string, unknown>;
    expect(outA.success).toBe(true);
    expect((outA.filled_tokens as string[]).sort()).toEqual(["cc_csc", "cc_number"]);
    expect(JSON.stringify(outA)).not.toContain("4111111111111111");
    expect(JSON.stringify(outA)).not.toContain("123");
  });

  it("save_login：读取表单已填凭据入库，结果只回 handle", async () => {
    const h = createHarness({ vaultDir });
    const out = (await h.byName("browser_vault").handler({ action: "save_login", label: "Shop" })) as Record<string, unknown>;
    expect(out.success).toBe(true);
    expect(out.handle).toMatch(/^vault_[0-9a-f]{12}$/);
    expect(out.origin).toBe("https://shop.example.com");
    expect(JSON.stringify(out)).not.toContain("hunter2");
    // 已入库可 list
    const vault = new BrowserVault(vaultDir);
    expect(vault.listItems()).toHaveLength(1);
  });

  it("enter_code：无 TOTP 种子 → user_code_required；有种子 → 生成 6 位码填入且不回显", async () => {
    const h = createHarness({ vaultDir });
    const vault = new BrowserVault(vaultDir);
    const noOtp = vault.addItem({ kind: "login", label: "NoOTP", origin: "https://shop.example.com", password: "p" });
    const noOtpOut = (await h.byName("browser_vault").handler({ action: "enter_code", handle: noOtp.handle })) as Record<string, unknown>;
    expect(noOtpOut.success).toBe(false);
    expect(noOtpOut.error_type).toBe("user_code_required");

    const withOtp = vault.addItem({
      kind: "login",
      label: "OTP",
      origin: "https://shop.example.com",
      password: "p",
      otpSecret: RFC6238_SEED,
    });
    const out = (await h.byName("browser_vault").handler({ action: "enter_code", handle: withOtp.handle })) as Record<string, unknown>;
    expect(out.success).toBe(true);
    expect(out.generated).toBe(true);
    const code = (h.pwBrowser.fillOtp as Mock).mock.calls[0][0];
    expect(String(code)).toMatch(/^\d{6}$/);
    expect(JSON.stringify(out)).not.toContain(String(code));
  });

  it("unlock：local 恒已解锁；外部后端不支持", async () => {
    const h = createHarness({ vaultDir });
    const local = (await h.byName("browser_vault").handler({ action: "unlock" })) as Record<string, unknown>;
    expect(local).toEqual({ success: true, backend: "local", already_unlocked: true });
    const ext = (await h.byName("browser_vault").handler({ action: "unlock", backend: "onepassword" })) as Record<string, unknown>;
    expect(ext.success).toBe(false);
    expect(ext.error).toContain("not supported");
  });
});

describe("browser_exec", () => {
  let binDir: string;
  let origPath: string | undefined;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "bct-bin-"));
    origPath = process.env.PATH;
    const script = `#!/bin/sh\nread -r line\necho "processed: $line"\n`;
    fs.writeFileSync(path.join(binDir, "browser-use"), script, { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${origPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it("执行 Python 代码经 stdin，捕获 stdout", async () => {
    const h = createHarness();
    expect(h.byName("browser_exec").checkFn!()).toBe(true);
    const out = (await h.byName("browser_exec").handler({ code: "print(1)" })) as Record<string, unknown>;
    expect(out.success).toBe(true);
    expect(out.exit_code).toBe(0);
    expect(out.output).toContain("processed: print(1)");
  });

  it("缺 code / 非法 session 名校验", async () => {
    const h = createHarness();
    const noCode = (await h.byName("browser_exec").handler({})) as Record<string, unknown>;
    expect(noCode.success).toBe(false);
    const badSession = (await h.byName("browser_exec").handler({ code: "print(1)", session: "bad name!" })) as Record<string, unknown>;
    expect(badSession.success).toBe(false);
    expect(badSession.error).toContain("Invalid session name");
  });

  it("超时终止（进程组 SIGKILL）", async () => {
    fs.writeFileSync(path.join(binDir, "browser-use"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    const h = createHarness();
    const out = (await h.byName("browser_exec").handler({ code: "x", timeout_s: 1 })) as Record<string, unknown>;
    expect(out.success).toBe(false);
    expect(out.error).toContain("timed out after 1s");
  }, 10_000);
});
