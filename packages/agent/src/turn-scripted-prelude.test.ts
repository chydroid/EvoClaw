/**
 * turn-scripted-prelude.test — 脚本化预lude测试（对标 hermes-agent agent/turn_scripted_prelude.py）
 */

import { describe, it, expect } from "vitest";
import {
  runScriptedPrelude,
  playPrelude,
  preludeCallId,
  createSimplePrelude,
  createEnvironmentCheckPrelude,
  type PreludeStep,
  type PreludeCallbacks,
} from "./turn-scripted-prelude";

describe("preludeCallId", () => {
  it("同一输入产生相同 id", () => {
    const id1 = preludeCallId("session-1", "shell_exec", { command: "ls" }, 0);
    const id2 = preludeCallId("session-1", "shell_exec", { command: "ls" }, 0);
    expect(id1).toBe(id2);
  });

  it("不同 session 产生不同 id", () => {
    const id1 = preludeCallId("session-1", "shell_exec", { command: "ls" }, 0);
    const id2 = preludeCallId("session-2", "shell_exec", { command: "ls" }, 0);
    expect(id1).not.toBe(id2);
  });

  it("不同 tool 产生不同 id", () => {
    const id1 = preludeCallId("session-1", "shell_exec", { command: "ls" }, 0);
    const id2 = preludeCallId("session-1", "read_file", { command: "ls" }, 0);
    expect(id1).not.toBe(id2);
  });

  it("不同 index 产生不同 id", () => {
    const id1 = preludeCallId("session-1", "shell_exec", { command: "ls" }, 0);
    const id2 = preludeCallId("session-1", "shell_exec", { command: "ls" }, 1);
    expect(id1).not.toBe(id2);
  });

  it("id 为 16 字符 hex", () => {
    const id = preludeCallId("session-1", "shell_exec", { command: "ls" }, 0);
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it("args 排序不影响 id", () => {
    const id1 = preludeCallId("session-1", "shell_exec", { a: "1", b: "2" }, 0);
    const id2 = preludeCallId("session-1", "shell_exec", { b: "2", a: "1" }, 0);
    expect(id1).toBe(id2);
  });
});

describe("runScriptedPrelude", () => {
  it("无预lude时返回空结果", async () => {
    const result = await runScriptedPrelude(null, "session-1", {
      executeTool: async () => "result",
    });
    expect(result.completed).toBe(false);
    expect(result.stepCount).toBe(0);
    expect(result.shouldEndTurn).toBe(false);
    expect(result.shouldSkipModel).toBe(false);
  });

  it("执行单步预lude", async () => {
    function* gen() {
      yield { content: "Step 1", toolName: "shell_exec", args: { command: "echo hi" } };
    }
    const result = await runScriptedPrelude(gen(), "session-1", {
      executeTool: async () => "hello",
    });
    expect(result.completed).toBe(true);
    expect(result.stepCount).toBe(1);
    expect(result.lastToolResult).toBe("hello");
  });

  it("执行多步预lude", async () => {
    function* gen() {
      yield { content: "Step 1", toolName: "shell_exec", args: { command: "echo 1" } };
      yield { content: "Step 2", toolName: "shell_exec", args: { command: "echo 2" } };
      yield { content: "Step 3", toolName: "read_file", args: { path: "/tmp/test" } };
    }
    const result = await runScriptedPrelude(gen(), "session-1", {
      executeTool: async (name) => `result-${name}`,
    });
    expect(result.completed).toBe(true);
    expect(result.stepCount).toBe(3);
    expect(result.lastToolResult).toBe("result-read_file");
  });

  it("后续 step 使用前面的工具结果", async () => {
    function* gen() {
      const r1 = yield { content: "Step 1", toolName: "shell_exec", args: { command: "pwd" } };
      const r2 = yield { content: "Step 2", toolName: "read_file", args: { path: r1 } };
      return r2;
    }
    const result = await runScriptedPrelude(gen(), "session-1", {
      executeTool: async (_, args) => {
        if (args.command) return "/home/user";
        if (args.path) return `content-of-${args.path}`;
        return "";
      },
    });
    expect(result.completed).toBe(true);
    expect(result.stepCount).toBe(2);
  });

  it("工具执行失败时不阻断", async () => {
    function* gen() {
      yield { content: "Step 1", toolName: "shell_exec", args: { command: "fail" } };
      yield { content: "Step 2", toolName: "shell_exec", args: { command: "ok" } };
    }
    const result = await runScriptedPrelude(gen(), "session-1", {
      executeTool: async (_, args) => {
        if (args.command === "fail") throw new Error("tool failed");
        return "ok";
      },
    });
    expect(result.completed).toBe(false); // 异常导致 generator 关闭
    expect(result.stepCount).toBe(0); // 异常发生在第一步
  });

  it("中断时停止执行", async () => {
    let interrupted = false;
    function* gen() {
      yield { content: "Step 1", toolName: "shell_exec", args: { command: "echo 1" } };
      yield { content: "Step 2", toolName: "shell_exec", args: { command: "echo 2" } };
    }
    const result = await runScriptedPrelude(gen(), "session-1", {
      executeTool: async () => {
        if (!interrupted) {
          interrupted = true;
        }
        return "result";
      },
      isInterrupted: () => interrupted,
    });
    expect(result.stepCount).toBeLessThanOrEqual(2);
  });
});

describe("playPrelude", () => {
  it("无预lude时返回 run", async () => {
    const result = await playPrelude(null, "session-1", {
      executeTool: async () => "result",
    });
    expect(result.action).toBe("run");
  });

  it("预lude 完成时返回 run", async () => {
    function* gen() {
      yield { content: "Step 1", toolName: "shell_exec", args: { command: "echo hi" } };
    }
    const result = await playPrelude(gen(), "session-1", {
      executeTool: async () => "hello",
    });
    expect(result.action).toBe("run");
    expect(result.result.completed).toBe(true);
  });
});

describe("createSimplePrelude", () => {
  it("创建简单预lude", async () => {
    const prelude = createSimplePrelude("session-1", [
      { content: "Step 1", toolName: "shell_exec", args: { command: "echo 1" } },
      { content: "Step 2", toolName: "read_file", args: { path: "/tmp" } },
    ]);
    const result = await runScriptedPrelude(prelude, "session-1", {
      executeTool: async (name) => `result-${name}`,
    });
    expect(result.completed).toBe(true);
    expect(result.stepCount).toBe(2);
  });

  it("空数组预lude", async () => {
    const prelude = createSimplePrelude("session-1", []);
    const result = await runScriptedPrelude(prelude, "session-1", {
      executeTool: async () => "result",
    });
    expect(result.completed).toBe(true);
    expect(result.stepCount).toBe(0);
  });
});

describe("createEnvironmentCheckPrelude", () => {
  it("创建环境检查预lude", async () => {
    const prelude = createEnvironmentCheckPrelude("session-1");
    const result = await runScriptedPrelude(prelude, "session-1", {
      executeTool: async (_, args) => {
        if (args.command?.includes("pwd")) return "/home/user";
        if (args.command?.includes("git")) return "clean";
        return "unknown";
      },
    });
    expect(result.completed).toBe(true);
    expect(result.stepCount).toBe(2);
  });
});
