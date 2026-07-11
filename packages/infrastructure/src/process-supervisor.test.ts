import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { ProcessSupervisor } from "./process-supervisor";
import type { SpawnFn, SpawnResult } from "./process-supervisor";

/**
 * 创建可控的 mock SpawnFn：
 * - crash() 模拟进程退出（触发 onExit 回调）
 * - getSpawnCount() 返回 spawn 调用次数
 */
function createMockSpawn() {
  let exitCb: (() => void) | null = null;
  let spawnCount = 0;
  let currentPid = 10000;

  const spawnFn: SpawnFn = async () => {
    spawnCount++;
    currentPid++;
    exitCb = null;
    const pid = currentPid;
    const handle: SpawnResult = {
      pid,
      stop: async () => {
        // mock stop — 实际由 supervisor 的 stopped 标志阻止 onExit 触发
      },
      onExit: (cb: () => void) => {
        exitCb = cb;
      },
    };
    return handle;
  };

  return {
    spawnFn,
    crash: () => {
      if (exitCb) {
        const cb = exitCb;
        exitCb = null;
        cb();
      }
    },
    getSpawnCount: () => spawnCount,
  };
}

describe("ProcessSupervisor", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    supervisor = new ProcessSupervisor(registry, eventBus);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. 注册并启动进程
  it("should register and start a process with autoStart", async () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn, { autoStart: true });
    await vi.advanceTimersByTimeAsync(0);

    const status = supervisor.getStatus("test");
    expect(status).toBeDefined();
    expect(status!.status).toBe("running");
    expect(status!.pid).toBe(10001);
    expect(status!.startTime).not.toBeNull();
    expect(status!.restartCount).toBe(0);
    expect(mock.getSpawnCount()).toBe(1);
  });

  // 2. 进程崩溃自动重启
  it("should auto-restart on crash", async () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn, {
      autoStart: true,
      policy: { restartDelay: 1000, maxRestarts: 10 },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(mock.getSpawnCount()).toBe(1);

    mock.crash();
    await vi.advanceTimersByTimeAsync(0);

    expect(supervisor.getStatus("test")!.status).toBe("restarting");
    expect(supervisor.getStatus("test")!.restartCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);

    expect(mock.getSpawnCount()).toBe(2);
    expect(supervisor.getStatus("test")!.status).toBe("running");
    expect(supervisor.getStatus("test")!.pid).toBe(10002);
  });

  // 3. 达到 maxRestarts 停止重启
  it("should stop restarting after maxRestarts", async () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn, {
      autoStart: true,
      policy: {
        maxRestarts: 2,
        restartDelay: 10,
        backoffMultiplier: 1,
        windowSize: 60000,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    // 第一次崩溃 → 重启 1
    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(mock.getSpawnCount()).toBe(2);

    // 第二次崩溃 → 重启 2
    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(mock.getSpawnCount()).toBe(3);

    // 第三次崩溃 → 超过 maxRestarts，停止
    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(mock.getSpawnCount()).toBe(3);
    expect(supervisor.getStatus("test")!.status).toBe("crashed");
  });

  // 4. 指数退避延迟
  it("should apply exponential backoff delay", async () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn, {
      autoStart: true,
      policy: {
        maxRestarts: 10,
        restartDelay: 100,
        backoffMultiplier: 2,
        maxRestartDelay: 10000,
        windowSize: 60000,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    // 第一次崩溃 → delay = 100 * 2^0 = 100
    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(99);
    expect(supervisor.getStatus("test")!.status).toBe("restarting");
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.getSpawnCount()).toBe(2);
    expect(supervisor.getStatus("test")!.status).toBe("running");

    // 第二次崩溃 → delay = 100 * 2^1 = 200
    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(199);
    expect(supervisor.getStatus("test")!.status).toBe("restarting");
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.getSpawnCount()).toBe(3);
    expect(supervisor.getStatus("test")!.status).toBe("running");
  });

  // 5. 滑动窗口超限停止
  it("should stop restarting when sliding window limit exceeded", async () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn, {
      autoStart: true,
      policy: {
        maxRestarts: 3,
        restartDelay: 10,
        backoffMultiplier: 1,
        windowSize: 50,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    // 窗口内崩溃 3 次 → 3 次重启
    for (let i = 0; i < 3; i++) {
      mock.crash();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(mock.getSpawnCount()).toBe(4);

    // 第 4 次崩溃 → 超过 maxRestarts
    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(mock.getSpawnCount()).toBe(4);
    expect(supervisor.getStatus("test")!.status).toBe("crashed");
  });

  // 6. 手动 start
  it("should manually start a process", async () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn);

    expect(supervisor.getStatus("test")!.status).toBe("stopped");

    await supervisor.start("test");
    expect(supervisor.getStatus("test")!.status).toBe("running");
    expect(mock.getSpawnCount()).toBe(1);
  });

  // 7. 手动 stop
  it("should manually stop a process", async () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn, { autoStart: true });
    await vi.advanceTimersByTimeAsync(0);

    await supervisor.stop("test");
    expect(supervisor.getStatus("test")!.status).toBe("stopped");
    expect(supervisor.getStatus("test")!.pid).toBeNull();
  });

  // 8. 手动 restart
  it("should manually restart a process", async () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn, { autoStart: true });
    await vi.advanceTimersByTimeAsync(0);

    const pidBefore = supervisor.getStatus("test")!.pid;
    await supervisor.restart("test");
    const pidAfter = supervisor.getStatus("test")!.pid;

    expect(pidAfter).not.toBe(pidBefore);
    expect(supervisor.getStatus("test")!.status).toBe("running");
    expect(mock.getSpawnCount()).toBe(2);
  });

  // 9. 健康检查
  it("should perform health check", async () => {
    const mock = createMockSpawn();
    let healthy = true;
    supervisor.register("test", mock.spawnFn, {
      autoStart: true,
      healthCheck: async () => healthy,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(await supervisor.healthCheck("test")).toBe(true);
    healthy = false;
    expect(await supervisor.healthCheck("test")).toBe(false);
  });

  // 10. 状态查询
  it("should return process status via getStatus", async () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn, { autoStart: true });
    await vi.advanceTimersByTimeAsync(0);

    const status = supervisor.getStatus("test");
    expect(status).toEqual({
      name: "test",
      pid: 10001,
      status: "running",
      startTime: expect.any(Date),
      restartCount: 0,
      lastError: null,
    });
  });

  // 11. 事件发布
  it("should publish events on start, crash, and restart", async () => {
    const mock = createMockSpawn();
    const startedEvents: string[] = [];
    const crashedEvents: string[] = [];

    eventBus.subscribe("supervisor.process.started", async (e) => { startedEvents.push(e.type); });
    eventBus.subscribe("supervisor.process.crashed", async (e) => { crashedEvents.push(e.type); });

    supervisor.register("test", mock.spawnFn, {
      autoStart: true,
      policy: { restartDelay: 100, maxRestarts: 10 },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(startedEvents.length).toBe(1);
    expect(startedEvents[0]).toBe("supervisor.process.started");

    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(crashedEvents.length).toBe(1);
    expect(crashedEvents[0]).toBe("supervisor.process.crashed");

    await vi.advanceTimersByTimeAsync(100);
    expect(startedEvents.length).toBe(2);
  });

  // 12. 多进程并行监督
  it("should supervise multiple processes in parallel", async () => {
    const mock1 = createMockSpawn();
    const mock2 = createMockSpawn();
    supervisor.register("proc1", mock1.spawnFn, { autoStart: true });
    supervisor.register("proc2", mock2.spawnFn, { autoStart: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(supervisor.getStatus("proc1")!.status).toBe("running");
    expect(supervisor.getStatus("proc2")!.status).toBe("running");

    // 只崩溃 proc1
    mock1.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(mock1.getSpawnCount()).toBe(2);
    expect(mock2.getSpawnCount()).toBe(1);
    expect(supervisor.getStatus("proc1")!.status).toBe("running");
    expect(supervisor.getStatus("proc2")!.status).toBe("running");
  });

  // 13. stop 后不自动重启
  it("should not auto-restart after manual stop", async () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn, {
      autoStart: true,
      policy: { restartDelay: 100, maxRestarts: 10 },
    });
    await vi.advanceTimersByTimeAsync(0);

    await supervisor.stop("test");
    expect(supervisor.getStatus("test")!.status).toBe("stopped");

    // 尝试崩溃 — 不应触发重启
    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(mock.getSpawnCount()).toBe(1);
    expect(supervisor.getStatus("test")!.status).toBe("stopped");
  });

  // 14. cleanup 全部停止
  it("should cleanup all processes", async () => {
    const mock1 = createMockSpawn();
    const mock2 = createMockSpawn();
    const mock3 = createMockSpawn();
    supervisor.register("proc1", mock1.spawnFn, { autoStart: true });
    supervisor.register("proc2", mock2.spawnFn, { autoStart: true });
    supervisor.register("proc3", mock3.spawnFn, { autoStart: true });
    await vi.advanceTimersByTimeAsync(0);

    await supervisor.cleanup();

    expect(supervisor.getStatus("proc1")!.status).toBe("stopped");
    expect(supervisor.getStatus("proc2")!.status).toBe("stopped");
    expect(supervisor.getStatus("proc3")!.status).toBe("stopped");
    expect(supervisor.getStatus("proc1")!.pid).toBeNull();
    expect(supervisor.getStatus("proc2")!.pid).toBeNull();
    expect(supervisor.getStatus("proc3")!.pid).toBeNull();
  });

  // 15. restart 事件发布
  it("should publish restarted event on manual restart", async () => {
    const mock = createMockSpawn();
    const restartedEvents: string[] = [];

    eventBus.subscribe("supervisor.process.restarted", async (e) => { restartedEvents.push(e.type); });

    supervisor.register("test", mock.spawnFn, { autoStart: true });
    await vi.advanceTimersByTimeAsync(0);

    await supervisor.restart("test");
    expect(restartedEvents.length).toBe(1);
    expect(restartedEvents[0]).toBe("supervisor.process.restarted");
  });

  // 16. 滑动窗口过期后恢复重启能力
  it("should allow restarts after sliding window expires", async () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn, {
      autoStart: true,
      policy: {
        maxRestarts: 2,
        restartDelay: 10,
        backoffMultiplier: 1,
        windowSize: 100,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    // 窗口内崩溃 2 次 → 2 次重启
    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(mock.getSpawnCount()).toBe(3);

    // 第 3 次崩溃 → 超过 maxRestarts
    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(supervisor.getStatus("test")!.status).toBe("crashed");

    // 等待窗口过期后手动重启
    await vi.advanceTimersByTimeAsync(200);
    await supervisor.start("test");
    expect(supervisor.getStatus("test")!.status).toBe("running");

    // 再次崩溃 → 应该能重启（旧时间戳已过期）
    mock.crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(mock.getSpawnCount()).toBe(5);
    expect(supervisor.getStatus("test")!.status).toBe("running");
  });

  // 17. 注册重复名称应抛出错误
  it("should throw when registering duplicate name", () => {
    const mock = createMockSpawn();
    supervisor.register("test", mock.spawnFn);
    expect(() => supervisor.register("test", mock.spawnFn)).toThrow("already registered");
  });

  // 18. 对未注册进程操作应抛出错误
  it("should throw when operating on unregistered process", async () => {
    await expect(supervisor.start("unknown")).rejects.toThrow("not registered");
    await expect(supervisor.stop("unknown")).rejects.toThrow("not registered");
    await expect(supervisor.restart("unknown")).rejects.toThrow("not registered");
    await expect(supervisor.healthCheck("unknown")).rejects.toThrow("not registered");
  });
});
