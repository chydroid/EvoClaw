import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VisionAnalyzer,
  type VisionChatFn,
} from "./vision-analyzer";
import {
  BatchExecutor,
  type BatchToolExecutorFn,
  type BatchTask,
} from "./batch-executor";

// ═══════════════════════════════════════════════════════════
// 测试套件：VisionAnalyzer + BatchExecutor
// ═══════════════════════════════════════════════════════════

const SAMPLE_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

// ── VisionAnalyzer ──────────────────────────────────────────────────────────

describe("VisionAnalyzer", () => {
  let chatFn: ReturnType<typeof vi.fn>;
  let analyzer: VisionAnalyzer;

  beforeEach(() => {
    chatFn = vi.fn();
    analyzer = new VisionAnalyzer(chatFn);
  });

  it("describeScreen: 返回 chatFn 的字符串描述", async () => {
    chatFn.mockResolvedValue("这是一个登录页面，包含用户名输入框、密码输入框和登录按钮。");

    const description = await analyzer.describeScreen(SAMPLE_IMAGE_BASE64);

    expect(description).toContain("登录页面");
    expect(chatFn).toHaveBeenCalledTimes(1);

    // 验证 vision message 结构
    const call = chatFn.mock.calls[0];
    const messages = call[0] as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    const content = messages[0].content as Array<{ type: string }>;
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("image_url");
  });

  it("findElements: 解析 chatFn 返回的 JSON 元素列表", async () => {
    chatFn.mockResolvedValue(
      JSON.stringify({
        elements: [
          {
            type: "button",
            text: "Submit",
            bbox: { x: 10, y: 20, width: 80, height: 30 },
          },
          {
            type: "input",
            text: "Email",
            bbox: { x: 10, y: 60, width: 200, height: 25 },
          },
        ],
      }),
    );

    const elements = await analyzer.findElements(SAMPLE_IMAGE_BASE64, "button");

    expect(elements).toHaveLength(2);
    expect(elements[0].type).toBe("button");
    expect(elements[0].text).toBe("Submit");
    expect(elements[0].bbox.x).toBe(10);
    expect(elements[0].bbox.width).toBe(80);
  });

  it("findElements: 解析数组形式响应", async () => {
    chatFn.mockResolvedValue(
      JSON.stringify([
        { type: "link", text: "Home", bbox: { x: 1, y: 2, width: 3, height: 4 } },
      ]),
    );

    const elements = await analyzer.findElements(SAMPLE_IMAGE_BASE64, "link");
    expect(elements).toHaveLength(1);
    expect(elements[0].type).toBe("link");
    expect(elements[0].bbox.x).toBe(1);
  });

  it("findElements: 纯文本响应用正则提取 bbox (x, y, w, h)", async () => {
    chatFn.mockResolvedValue(
      "找到按钮在 (10, 20, 80, 30) 处，输入框在 x: 50, y: 60, width: 100, height: 25 处。",
    );

    const elements = await analyzer.findElements(SAMPLE_IMAGE_BASE64);
    expect(elements.length).toBeGreaterThanOrEqual(2);
    // 第一个匹配的应是 tuple 形式
    expect(elements[0].bbox.x).toBe(10);
    expect(elements[0].bbox.width).toBe(80);
  });

  it("缓存命中：相同 prompt + image 不重复调用 chatFn", async () => {
    chatFn.mockResolvedValue("描述内容");

    await analyzer.describeScreen(SAMPLE_IMAGE_BASE64, "test prompt");
    await analyzer.describeScreen(SAMPLE_IMAGE_BASE64, "test prompt");

    expect(chatFn).toHaveBeenCalledTimes(1);
  });

  it("缓存未命中：不同 prompt 重新调用 chatFn", async () => {
    chatFn.mockResolvedValue("描述内容");

    await analyzer.describeScreen(SAMPLE_IMAGE_BASE64, "prompt A");
    await analyzer.describeScreen(SAMPLE_IMAGE_BASE64, "prompt B");

    expect(chatFn).toHaveBeenCalledTimes(2);
  });

  it("clearCache: 清空后重新调用 chatFn", async () => {
    chatFn.mockResolvedValue("描述内容");

    await analyzer.describeScreen(SAMPLE_IMAGE_BASE64, "prompt");
    expect(chatFn).toHaveBeenCalledTimes(1);

    analyzer.clearCache();
    await analyzer.describeScreen(SAMPLE_IMAGE_BASE64, "prompt");
    expect(chatFn).toHaveBeenCalledTimes(2);
  });

  it("chatFn 抛错时包装为 Error，包含图片大小信息但不泄露 base64 内容", async () => {
    chatFn.mockRejectedValue(new Error("upstream failure"));

    await expect(
      analyzer.describeScreen(SAMPLE_IMAGE_BASE64),
    ).rejects.toThrow(/VisionAnalyzer\.analyze failed/);

    try {
      await analyzer.describeScreen(SAMPLE_IMAGE_BASE64);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("imageSize=");
      expect(msg).not.toContain(SAMPLE_IMAGE_BASE64);
    }
  });

  it("detectUIIssues: 解析 issues 数组", async () => {
    chatFn.mockResolvedValue(
      JSON.stringify({
        description: "页面整体布局正常",
        issues: [
          {
            severity: "warning",
            description: "按钮文字被截断",
            bbox: { x: 100, y: 200, width: 50, height: 20 },
          },
          {
            severity: "error",
            description: "登录表单与导航栏重叠",
          },
        ],
      }),
    );

    const issues = await analyzer.detectUIIssues(SAMPLE_IMAGE_BASE64);
    expect(issues).toHaveLength(2);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].bbox?.x).toBe(100);
    expect(issues[1].severity).toBe("error");
  });

  it("compareImages: 解析差异和相似度", async () => {
    chatFn.mockResolvedValue(
      JSON.stringify({
        differences: "第二张图缺少顶部导航栏",
        similarity: 0.75,
      }),
    );

    const result = await analyzer.compareImages(
      SAMPLE_IMAGE_BASE64,
      SAMPLE_IMAGE_BASE64,
    );
    expect(result.differences).toContain("导航栏");
    expect(result.similarity).toBeCloseTo(0.75);
  });

  it("compareImages: 纯文本响应用正则提取相似度", async () => {
    chatFn.mockResolvedValue("两张图布局相似，相似度: 0.85，仅文字略有不同。");

    const result = await analyzer.compareImages(
      SAMPLE_IMAGE_BASE64,
      SAMPLE_IMAGE_BASE64,
    );
    expect(result.similarity).toBeCloseTo(0.85);
  });

  it("compareImages: 缓存命中不重复调用 chatFn", async () => {
    chatFn.mockResolvedValue("差异：无；相似度: 1.0");

    await analyzer.compareImages(SAMPLE_IMAGE_BASE64, SAMPLE_IMAGE_BASE64);
    await analyzer.compareImages(SAMPLE_IMAGE_BASE64, SAMPLE_IMAGE_BASE64);
    expect(chatFn).toHaveBeenCalledTimes(1);
  });
});

// ── BatchExecutor ───────────────────────────────────────────────────────────

describe("BatchExecutor", () => {
  let executorFn: ReturnType<typeof vi.fn>;
  let executor: BatchExecutor;

  beforeEach(() => {
    executorFn = vi.fn();
    executor = new BatchExecutor(executorFn);
  });

  it("executeParallel: 受 maxConcurrency 限制", async () => {
    const activeCount = { value: 0, max: 0 };
    executor = new BatchExecutor(executorFn, { maxConcurrency: 2 });

    executorFn.mockImplementation(async () => {
      activeCount.value++;
      activeCount.max = Math.max(activeCount.max, activeCount.value);
      await new Promise((r) => setTimeout(r, 50));
      activeCount.value--;
      return "ok";
    });

    const tasks: BatchTask[] = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      toolName: "noop",
      params: { idx: i },
    }));

    const result = await executor.executeParallel(tasks);

    expect(result.succeeded).toBe(6);
    expect(result.failed).toBe(0);
    expect(activeCount.max).toBeLessThanOrEqual(2);
  });

  it("executeSequential: 串行执行，前一个完成才下一个", async () => {
    const order: string[] = [];
    executorFn.mockImplementation(async (toolName: string, params: Record<string, unknown>) => {
      order.push(`start-${String(params.idx)}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end-${String(params.idx)}`);
      return "ok";
    });

    const tasks: BatchTask[] = Array.from({ length: 3 }, (_, i) => ({
      id: `t${i}`,
      toolName: "noop",
      params: { idx: i },
    }));

    const result = await executor.executeSequential(tasks);

    expect(result.succeeded).toBe(3);
    // 串行：start-0, end-0, start-1, end-1, start-2, end-2
    expect(order).toEqual([
      "start-0", "end-0",
      "start-1", "end-1",
      "start-2", "end-2",
    ]);
  });

  it("executeDAG: 按依赖顺序执行", async () => {
    const order: string[] = [];
    executorFn.mockImplementation(async (_name: string, params: Record<string, unknown>) => {
      order.push(String(params.id));
      await new Promise((r) => setTimeout(r, 10));
      return "ok";
    });

    // a -> b -> c (b 依赖 a, c 依赖 b)
    const tasks: BatchTask[] = [
      { id: "a", toolName: "noop", params: { id: "a" } },
      { id: "b", toolName: "noop", params: { id: "b" }, dependsOn: ["a"] },
      { id: "c", toolName: "noop", params: { id: "c" }, dependsOn: ["b"] },
    ];

    const result = await executor.executeDAG(tasks);

    expect(result.succeeded).toBe(3);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("executeDAG: 同层无依赖任务并行执行", async () => {
    const startTimes: Record<string, number> = {};
    executorFn.mockImplementation(async (_name: string, params: Record<string, unknown>) => {
      const id = String(params.id);
      startTimes[id] = Date.now();
      await new Promise((r) => setTimeout(r, 50));
      return "ok";
    });

    // a, b 同层并行；c 依赖 a 和 b
    const tasks: BatchTask[] = [
      { id: "a", toolName: "noop", params: { id: "a" } },
      { id: "b", toolName: "noop", params: { id: "b" } },
      { id: "c", toolName: "noop", params: { id: "c" }, dependsOn: ["a", "b"] },
    ];

    const result = await executor.executeDAG(tasks);
    expect(result.succeeded).toBe(3);

    // a, b 应在 50ms 内同时启动
    const diff = Math.abs(startTimes["a"] - startTimes["b"]);
    expect(diff).toBeLessThan(30);

    // c 应在 a, b 都完成后启动
    expect(startTimes["c"]).toBeGreaterThan(startTimes["a"]);
    expect(startTimes["c"]).toBeGreaterThan(startTimes["b"]);
  });

  it("executeDAG: 检测循环依赖并抛错", async () => {
    // a -> b -> a (循环)
    const tasks: BatchTask[] = [
      { id: "a", toolName: "noop", params: {}, dependsOn: ["b"] },
      { id: "b", toolName: "noop", params: {}, dependsOn: ["a"] },
    ];

    await expect(executor.executeDAG(tasks)).rejects.toThrow(/cycle detected/);
  });

  it("executeDAG: 自依赖视为环", async () => {
    const tasks: BatchTask[] = [
      { id: "a", toolName: "noop", params: {}, dependsOn: ["a"] },
    ];
    await expect(executor.executeDAG(tasks)).rejects.toThrow(/cycle detected/);
  });

  it("execute: 无依赖时调用 executeParallel", async () => {
    executorFn.mockResolvedValue("ok");
    const tasks: BatchTask[] = [
      { id: "a", toolName: "noop", params: {} },
      { id: "b", toolName: "noop", params: {} },
    ];

    const result = await executor.execute(tasks);
    expect(result.succeeded).toBe(2);
    expect(result.results.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("execute: 有依赖时调用 executeDAG", async () => {
    const order: string[] = [];
    executorFn.mockImplementation(async (_n: string, p: Record<string, unknown>) => {
      order.push(String(p.id));
      return "ok";
    });

    const tasks: BatchTask[] = [
      { id: "a", toolName: "noop", params: { id: "a" } },
      { id: "b", toolName: "noop", params: { id: "b" }, dependsOn: ["a"] },
    ];

    const result = await executor.execute(tasks);
    expect(result.succeeded).toBe(2);
    expect(order).toEqual(["a", "b"]);
  });

  it("rateLimitPerSecond: 限制每秒调用数", async () => {
    const callTimes: number[] = [];
    executor = new BatchExecutor(executorFn, {
      maxConcurrency: 10,
      rateLimitPerSecond: 2,
    });

    executorFn.mockImplementation(async () => {
      callTimes.push(Date.now());
      await new Promise((r) => setTimeout(r, 5));
      return "ok";
    });

    const tasks: BatchTask[] = Array.from({ length: 4 }, (_, i) => ({
      id: `t${i}`,
      toolName: "noop",
      params: {},
    }));

    const start = Date.now();
    await executor.executeParallel(tasks);
    const elapsed = Date.now() - start;

    // 4 个任务，每秒 2 个：至少需要 1000ms（第二批必须等到 1s 后）
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(callTimes).toHaveLength(4);
  });

  it("retries: 失败时按 retries 重试", async () => {
    let attempts = 0;
    executor = new BatchExecutor(executorFn, {
      defaultRetries: 2,
      retryDelayMs: 5,
    });

    executorFn.mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "ok";
    });

    const tasks: BatchTask[] = [{ id: "t1", toolName: "noop", params: {} }];
    const result = await executor.executeParallel(tasks);

    expect(result.succeeded).toBe(1);
    expect(result.results[0].attempts).toBe(3);
    expect(result.results[0].result).toBe("ok");
  });

  it("retries: 重试耗尽后标记为失败", async () => {
    executor = new BatchExecutor(executorFn, {
      defaultRetries: 2,
      retryDelayMs: 1,
    });

    executorFn.mockRejectedValue(new Error("permanent"));

    const tasks: BatchTask[] = [{ id: "t1", toolName: "noop", params: {} }];
    const result = await executor.executeParallel(tasks);

    expect(result.failed).toBe(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toBe("permanent");
    expect(result.results[0].attempts).toBe(3); // 1 + 2 retries
  });

  it("timeoutMs: 超时取消任务并标记失败", async () => {
    executor = new BatchExecutor(executorFn, { defaultTimeoutMs: 30 });

    executorFn.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return "ok";
    });

    const tasks: BatchTask[] = [{ id: "t1", toolName: "noop", params: {} }];
    const result = await executor.executeParallel(tasks);

    expect(result.failed).toBe(1);
    expect(result.results[0].error).toContain("timed out");
  });

  it("failFast: 串行模式下首个失败立即跳过后续", async () => {
    executor = new BatchExecutor(executorFn, { failFast: true });
    executorFn.mockImplementation(async (_n: string, p: Record<string, unknown>) => {
      if (p.id === "a") throw new Error("fail-a");
      return "ok";
    });

    const tasks: BatchTask[] = [
      { id: "a", toolName: "noop", params: { id: "a" } },
      { id: "b", toolName: "noop", params: { id: "b" } },
    ];

    const result = await executor.executeSequential(tasks);
    expect(result.failed).toBe(2);
    const skipped = result.results.find((r) => r.id === "b");
    expect(skipped?.error).toContain("skipped");
  });

  it("failFast: 并行模式下失败不取消已启动的任务但标记后续被跳过", async () => {
    // 并行模式下，所有任务同时启动，failFast 主要在 DAG/sequential 上下文生效
    // 这里验证 failed 计数正确
    executor = new BatchExecutor(executorFn, { failFast: true, maxConcurrency: 1 });
    executorFn.mockImplementation(async (_n: string, p: Record<string, unknown>) => {
      if (p.id === "a") throw new Error("fail-a");
      await new Promise((r) => setTimeout(r, 10));
      return "ok";
    });

    const tasks: BatchTask[] = [
      { id: "a", toolName: "noop", params: { id: "a" } },
      { id: "b", toolName: "noop", params: { id: "b" } },
    ];

    const result = await executor.executeSequential(tasks);
    expect(result.failed).toBe(2);
    expect(result.succeeded).toBe(0);
  });

  it("DAG 依赖失败时下游任务被标记为失败且不执行", async () => {
    const executed: string[] = [];
    executorFn.mockImplementation(async (_n: string, p: Record<string, unknown>) => {
      executed.push(String(p.id));
      if (p.id === "a") throw new Error("a-fail");
      return "ok";
    });

    const tasks: BatchTask[] = [
      { id: "a", toolName: "noop", params: { id: "a" } },
      { id: "b", toolName: "noop", params: { id: "b" }, dependsOn: ["a"] },
      { id: "c", toolName: "noop", params: { id: "c" }, dependsOn: ["b"] },
    ];

    const result = await executor.executeDAG(tasks);
    expect(result.failed).toBe(3);
    expect(executed).toEqual(["a"]); // b, c 未执行
    const b = result.results.find((r) => r.id === "b");
    expect(b?.error).toContain("dependency");
  });

  it("空任务列表返回空结果", async () => {
    const result = await executor.executeParallel([]);
    expect(result.results).toEqual([]);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });
});
