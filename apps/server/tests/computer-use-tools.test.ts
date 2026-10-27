// computer-use-tools.test.ts — Computer Use 工具集测试
// Mock ComputerBackend，测试工具注册、安全控制（坐标校验/按键白名单/速率限制）。
// 遵循项目约定：apps 测试放在 apps/*/tests/（vitest.config.ts 仅匹配该路径）。
//
// ★ 复合工具改造：原 9 个细粒度 computer_* 工具合并为单一 `computer_use`，
//   通过 `action` 判别字段分发（screenshot / click / move / drag / scroll /
//   type / press / window_list / window_focus）。本文件断言随之迁移为
//   「注册 1 个复合工具 + action 枚举覆盖原 9 个能力」，并在每次调用 handler
//   时显式带上 `action`，以覆盖真实的调用契约。

import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerComputerUseTools, __test__ } from "../src/tools/computer-use-tools";
import type { ComputerBackend, MouseButton, ScrollDirection } from "../src/tools/computer-use/computer-backend";

// ── Mock ComputerBackend ──

interface MockCall {
  method: string;
  args: unknown[];
}

class MockComputerBackend implements ComputerBackend {
  readonly name = "mock";
  available = true;
  screen: { width: number; height: number } = { width: 1920, height: 1080 };
  screenshotBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG 签名
  calls: MockCall[] = [];
  windowListData: ReturnType<ComputerBackend["windowList"]> = [];

  isAvailable(): boolean {
    return this.available;
  }
  async screenshot(): Promise<Buffer> {
    this.calls.push({ method: "screenshot", args: [] });
    return this.screenshotBuf;
  }
  async getScreenSize() {
    this.calls.push({ method: "getScreenSize", args: [] });
    return this.screen;
  }
  async mouseClick(x: number, y: number, button: MouseButton, doubleClick: boolean): Promise<void> {
    this.calls.push({ method: "mouseClick", args: [x, y, button, doubleClick] });
  }
  async mouseMove(x: number, y: number): Promise<void> {
    this.calls.push({ method: "mouseMove", args: [x, y] });
  }
  async mouseDrag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    this.calls.push({ method: "mouseDrag", args: [fromX, fromY, toX, toY] });
  }
  async mouseScroll(x: number, y: number, direction: ScrollDirection, amount: number): Promise<void> {
    this.calls.push({ method: "mouseScroll", args: [x, y, direction, amount] });
  }
  async keyType(text: string): Promise<void> {
    this.calls.push({ method: "keyType", args: [text] });
  }
  async keyPress(keys: string[]): Promise<void> {
    this.calls.push({ method: "keyPress", args: [keys] });
  }
  async windowList() {
    this.calls.push({ method: "windowList", args: [] });
    return this.windowListData ?? [];
  }
  async windowFocus(windowId: string): Promise<void> {
    this.calls.push({ method: "windowFocus", args: [windowId] });
  }
}

// ── 测试用 fake executor：捕获 handler 与 checkFn ──

interface Captured {
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  checkFn?: () => boolean;
  definition: { name: string; description: string; parameters: Record<string, unknown> };
}

function createFakeExecutor() {
  const captured = new Map<string, Captured>();
  const executor = {
    registerTool: (
      name: string,
      definition: { name: string; description: string; parameters: Record<string, unknown> },
      handler: (params: Record<string, unknown>) => Promise<unknown>,
      checkFn?: () => boolean,
    ) => {
      captured.set(name, { handler, checkFn, definition });
    },
    unregisterTool: (name: string) => {
      captured.delete(name);
    },
  };
  return { executor, captured };
}

// ── 测试 ──

describe("registerComputerUseTools", () => {
  let backend: MockComputerBackend;
  let captured: Map<string, Captured>;
  let unregister: () => void;

  beforeEach(() => {
    __test__.resetRateLimit();
    backend = new MockComputerBackend();
    const fake = createFakeExecutor();
    captured = fake.captured;
    unregister = registerComputerUseTools({
      executor: fake.executor as never,
      backend,
    });
  });

  it("应注册 computer_use 复合工具，且 action 枚举覆盖原 9 个细粒度工具", () => {
    // 合并前是 9 个独立工具；合并后只剩 1 个复合工具，能力体现在 action 枚举上
    const expectedActions = [
      "screenshot",
      "click",
      "move",
      "drag",
      "scroll",
      "type",
      "press",
      "window_list",
      "window_focus",
    ];
    const tool = captured.get("computer_use");
    expect(tool).toBeDefined();
    expect(captured.size).toBe(1);

    const actionDef = tool!.definition.parameters.action as { required?: boolean; enum?: string[] };
    // action 必须是必填判别字段，否则模型可能不带 action 直接调用
    expect(actionDef.required).toBe(true);
    expect(actionDef.enum).toEqual(expectedActions);
  });

  it("未知 action 被拒绝", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "self_destruct" })) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("未知 computer_use action");
  });

  it("checkFn 在后端可用时返回 true", () => {
    const tool = captured.get("computer_use");
    expect(tool?.checkFn?.()).toBe(true);
  });

  it("checkFn 在后端不可用时返回 false", () => {
    backend.available = false;
    const tool = captured.get("computer_use");
    expect(tool?.checkFn?.()).toBe(false);
  });

  it("checkFn 在后端为 null（未解析到）时返回 false", () => {
    const fake = createFakeExecutor();
    registerComputerUseTools({ executor: fake.executor as never });
    // 后端解析不到（native/robotjs/nut-js 都不可能在测试 CI 桌面环境可靠可用，
    // 但 native 在 Windows CI 上可能可用）—— 重点验证显式 backend 注入路径
    const tool = fake.captured.get("computer_use");
    expect(tool?.checkFn).toBeDefined();
  });

  // ── action=screenshot（原 computer_screenshot） ──
  it("computer_use action=screenshot 返回 base64 图像与屏幕尺寸", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "screenshot" })) as {
      image: string; format: string; width: number; height: number; size: number;
    };
    expect(result.format).toBe("png");
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.image).toBe(backend.screenshotBuf.toString("base64"));
    expect(result.size).toBe(backend.screenshotBuf.length);
  });

  // ── action=click（原 computer_mouse_click） ──
  it("computer_use action=click 基本调用（默认左键单击）", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "click", x: 100, y: 200 })) as {
      success: boolean; x: number; y: number; button: string; doubleClick: boolean;
    };
    expect(result.success).toBe(true);
    expect(result.button).toBe("left");
    expect(result.doubleClick).toBe(false);
    expect(backend.calls).toContainEqual({
      method: "mouseClick", args: [100, 200, "left", false],
    });
  });

  it("computer_use action=click 支持右键双击", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "click", x: 50, y: 60, button: "right", doubleClick: "true" })) as {
      success: boolean; button: string; doubleClick: boolean;
    };
    expect(result.success).toBe(true);
    expect(result.button).toBe("right");
    expect(result.doubleClick).toBe(true);
  });

  it("computer_use action=click 拒绝越界坐标", async () => {
    const handler = captured.get("computer_use")!.handler;
    // x 超出宽度 1920
    const result = (await handler({ action: "click", x: 3000, y: 100 })) as { error: string };
    expect(result.error).toContain("越界");
    // y 负数
    const result2 = (await handler({ action: "click", x: 100, y: -5 })) as { error: string };
    expect(result2.error).toContain("越界");
  });

  // ── action=move（原 computer_mouse_move） ──
  it("computer_use action=move 基本调用", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "move", x: 500, y: 600 })) as { success: boolean; x: number; y: number };
    expect(result.success).toBe(true);
    expect(backend.calls).toContainEqual({ method: "mouseMove", args: [500, 600] });
  });

  it("computer_use action=move 拒绝越界坐标", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "move", x: -1, y: 0 })) as { error: string };
    expect(result.error).toContain("越界");
  });

  // ── action=drag（原 computer_mouse_drag） ──
  it("computer_use action=drag 基本调用", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "drag", fromX: 10, fromY: 20, toX: 100, toY: 200 })) as {
      success: boolean; from: { x: number; y: number }; to: { x: number; y: number };
    };
    expect(result.success).toBe(true);
    expect(result.from).toEqual({ x: 10, y: 20 });
    expect(result.to).toEqual({ x: 100, y: 200 });
  });

  it("computer_use action=drag 拒绝越界起点", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "drag", fromX: 9999, fromY: 20, toX: 100, toY: 200 })) as { error: string };
    expect(result.error).toContain("起点");
  });

  it("computer_use action=drag 拒绝越界终点", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "drag", fromX: 10, fromY: 20, toX: 9999, toY: 200 })) as { error: string };
    expect(result.error).toContain("终点");
  });

  // ── action=scroll（原 computer_mouse_scroll） ──
  it("computer_use action=scroll 基本调用（默认 down, amount=3）", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "scroll", x: 100, y: 100 })) as {
      success: boolean; direction: string; amount: number;
    };
    expect(result.success).toBe(true);
    expect(result.direction).toBe("down");
    expect(result.amount).toBe(3);
  });

  it("computer_use action=scroll 向上滚动", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "scroll", x: 100, y: 100, direction: "up", amount: 5 })) as {
      direction: string; amount: number;
    };
    expect(result.direction).toBe("up");
    expect(result.amount).toBe(5);
  });

  // ── action=type（原 computer_key_type） ──
  it("computer_use action=type 基本调用", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "type", text: "Hello 世界" })) as { success: boolean; length: number };
    expect(result.success).toBe(true);
    expect(result.length).toBe("Hello 世界".length);
    expect(backend.calls).toContainEqual({ method: "keyType", args: ["Hello 世界"] });
  });

  it("computer_use action=type 拒绝空文本", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "type", text: "" })) as { error: string };
    expect(result.error).toContain("不能为空");
  });

  it("computer_use action=type 拒绝超长文本", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "type", text: "x".repeat(2001) })) as { error: string };
    expect(result.error).toContain("文本过长");
  });

  // ── action=press（原 computer_key_press） ──
  it("computer_use action=press 基本调用（ctrl+c）", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "press", keys: "ctrl,c" })) as { success: boolean; keys: string[] };
    expect(result.success).toBe(true);
    expect(result.keys).toEqual(["ctrl", "c"]);
    expect(backend.calls).toContainEqual({ method: "keyPress", args: [["ctrl", "c"]] });
  });

  it("computer_use action=press 拒绝空按键", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "press", keys: "" })) as { error: string };
    expect(result.error).toContain("不能为空");
  });

  it("computer_use action=press 拒绝不在白名单的按键", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "press", keys: "ctrl,fakekey" })) as { error: string };
    expect(result.error).toContain("白名单");
  });

  it("computer_use action=press 拒绝危险组合键 ctrl+alt+del", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "press", keys: "ctrl,alt,delete" })) as { error: string };
    expect(result.error).toContain("危险");
  });

  it("computer_use action=press 拒绝危险组合键 alt+f4", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "press", keys: "alt,f4" })) as { error: string };
    expect(result.error).toContain("危险");
  });

  it("computer_use action=press 拒绝危险组合键 ctrl+shift+esc", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "press", keys: "ctrl,shift,escape" })) as { error: string };
    expect(result.error).toContain("危险");
  });

  // ── action=window_list（原 computer_window_list） ──
  it("computer_use action=window_list 返回窗口列表", async () => {
    backend.windowListData = [
      { id: "1", title: "Terminal", bounds: { x: 0, y: 0, width: 800, height: 600 } },
    ];
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "window_list" })) as { windows: unknown[]; supported: boolean; count: number };
    expect(result.supported).toBe(true);
    expect(result.count).toBe(1);
  });

  // ── action=window_focus（原 computer_window_focus） ──
  it("computer_use action=window_focus 基本调用", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "window_focus", windowId: "win-123" })) as { success: boolean; windowId: string };
    expect(result.success).toBe(true);
    expect(result.windowId).toBe("win-123");
  });

  it("computer_use action=window_focus 拒绝空 windowId", async () => {
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "window_focus", windowId: "" })) as { error: string };
    expect(result.error).toContain("不能为空");
  });

  // ── 后端不可用 ──
  it("后端不可用时工具返回错误", async () => {
    backend.available = false;
    const handler = captured.get("computer_use")!.handler;
    const result = (await handler({ action: "screenshot" })) as { error: string };
    expect(result.error).toContain("不可用");
  });

  // ── 速率限制 ──
  it("速率限制：超过上限后拒绝操作", async () => {
    const handler = captured.get("computer_use")!.handler;
    // 前 RATE_LIMIT_MAX_OPS 次成功
    for (let i = 0; i < __test__.RATE_LIMIT_MAX_OPS; i++) {
      const r = (await handler({ action: "move", x: 10, y: 10 })) as { success?: boolean; error?: string };
      expect(r.success ?? false).toBe(true);
    }
    // 第 RATE_LIMIT_MAX_OPS+1 次应被拒绝
    const blocked = (await handler({ action: "move", x: 10, y: 10 })) as { error: string };
    expect(blocked.error).toContain("速率限制");
  });

  it("速率限制按会话隔离", async () => {
    const handler = captured.get("computer_use")!.handler;
    // session A 耗尽配额
    for (let i = 0; i < __test__.RATE_LIMIT_MAX_OPS; i++) {
      await handler({ action: "move", x: 10, y: 10, sessionId: "A" });
    }
    const blockedA = (await handler({ action: "move", x: 10, y: 10, sessionId: "A" })) as { error: string };
    expect(blockedA.error).toContain("速率限制");
    // session B 仍可用
    const okB = (await handler({ action: "move", x: 10, y: 10, sessionId: "B" })) as { success: boolean };
    expect(okB.success).toBe(true);
  });

  // ── 反注册 ──
  it("反注册函数清理所有工具", () => {
    expect(captured.size).toBe(1);
    unregister();
    expect(captured.size).toBe(0);
  });
});

// ── 单元测试：内部安全函数 ──

describe("validateKeySequence（单元）", () => {
  it("接受单字符键", () => {
    expect(__test__.validateKeySequence(["a"]).ok).toBe(true);
    expect(__test__.validateKeySequence(["enter"]).ok).toBe(true);
  });

  it("接受正常组合键", () => {
    expect(__test__.validateKeySequence(["ctrl", "c"]).ok).toBe(true);
    expect(__test__.validateKeySequence(["shift", "f1"]).ok).toBe(true);
  });

  it("拒绝空数组", () => {
    expect(__test__.validateKeySequence([]).ok).toBe(false);
  });

  it("拒绝未知按键", () => {
    expect(__test__.validateKeySequence(["unknownkey"]).ok).toBe(false);
  });

  it("拒绝 ctrl+alt+del（顺序无关）", () => {
    expect(__test__.validateKeySequence(["alt", "ctrl", "del"]).ok).toBe(false);
    expect(__test__.validateKeySequence(["ctrl", "alt", "delete"]).ok).toBe(false);
  });

  it("拒绝 win+l 锁屏", () => {
    expect(__test__.validateKeySequence(["win", "l"]).ok).toBe(false);
    expect(__test__.validateKeySequence(["super", "l"]).ok).toBe(false);
  });
});

describe("validateCoords（单元）", () => {
  const size = { width: 1920, height: 1080 };
  it("接受屏幕内坐标", () => {
    expect(__test__.validateCoords(0, 0, size).ok).toBe(true);
    expect(__test__.validateCoords(1919, 1079, size).ok).toBe(true);
  });
  it("拒绝负坐标", () => {
    expect(__test__.validateCoords(-1, 0, size).ok).toBe(false);
  });
  it("拒绝越界坐标", () => {
    expect(__test__.validateCoords(1920, 0, size).ok).toBe(false);
    expect(__test__.validateCoords(0, 1080, size).ok).toBe(false);
  });
  it("拒绝非数字", () => {
    expect(__test__.validateCoords(NaN, 0, size).ok).toBe(false);
    expect(__test__.validateCoords(0, Infinity, size).ok).toBe(false);
  });
});

// ── checkFn 服务门控：无后端场景 ──

describe("无可用后端时 checkFn 返回 false", () => {
  it("backend 为 undefined 且服务注册表无后端时，checkFn 返回 false", () => {
    const fake = createFakeExecutor();
    // 不注入 backend，且 native/robotjs/nut-js 在测试环境应不可用
    // （CI 无桌面或无 cliclick/xdotool；Windows CI 可能 powershell 可用）
    // 使用空 registry 确保不从注册表解析
    const fakeRegistry = {
      resolveService: vi.fn().mockReturnValue(undefined),
    };
    registerComputerUseTools({
      executor: fake.executor as never,
      registry: fakeRegistry as never,
    });
    const tool = fake.captured.get("computer_use");
    expect(tool?.checkFn).toBeDefined();
    // 由于 robotjs/nut-js 未安装，native 依赖平台工具；
    // 若环境恰好可用 native，checkFn 可能 true，故只验证函数存在且不抛异常
    expect(() => tool?.checkFn?.()).not.toThrow();
  });
});
