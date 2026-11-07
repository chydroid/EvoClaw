/**
 * 斜杠命令守卫（2026-10-15 eval15 事故）：以绝对路径开头的消息
 * （"/home/.../app.log 是一个日志..."）曾被当成未知斜杠命令兜底，
 * LLM 根本没触发。命令名是单词（不含 "/"）；首个词含 "/" 即路径。
 */
import { describe, it, expect } from "vitest";
import type { PersonaConfig } from "@evoclaw/core";
import type { ServiceRegistry } from "@evoclaw/core";
import { handleSlashCommand, type SlashCommandDeps } from "./slash-commands";
import { DEFAULT_MODEL_CONFIG } from "./types";

/**
 * handleSlashCommand 对守卫分支只读 message；对真实命令分支只读
 * deps.providers/conversationHistory 等浅字段——Proxy 兜底即可。
 * 返回值若是函数则返回安全的 async no-op，否则返回 []（.length/.find 可用）。
 */
const deps = new Proxy(
  {},
  {
    get: (_, prop) => {
      if (prop === Symbol.toStringTag) return undefined;
      const fn: unknown = async () => [];
      return new Proxy(fn, {
        get: (target, p) => (p === Symbol.toPrimitive ? () => "" : (target as unknown as Record<PropertyKey, unknown>)[p]),
        apply: () => Promise.resolve([]),
      });
    },
  }
) as SlashCommandDeps;

describe("handleSlashCommand 路径消息守卫", () => {
  it("以绝对路径开头的消息不拦截（交给正常对话）", async () => {
    const r = await handleSlashCommand(
      deps,
      "/home/chy/EvoClaw/data/workspace/ws-t03/app.log 是一个服务日志，请解析它",
      "s1",
      Date.now()
    );
    expect(r).toBeNull();
  });

  it("以 /tmp/... 开头的消息不拦截", async () => {
    const r = await handleSlashCommand(deps, "/tmp/x/report.md 在吗", "s1", Date.now());
    expect(r).toBeNull();
  });

  it("真实命令仍拦截（/help）", async () => {
    const r = await handleSlashCommand(deps, "/help", "s1", Date.now());
    expect(r?.reply).toContain("可用命令");
  });

  it("未知名单词命令仍走兜底（不静默丢弃）", async () => {
    const r = await handleSlashCommand(deps, "/definitely_not_a_command", "s1", Date.now());
    expect(r?.reply).toContain("未知命令");
  });

  it("非斜杠消息不拦截", async () => {
    const r = await handleSlashCommand(deps, "hello", "s1", Date.now());
    expect(r).toBeNull();
  });
});

// ── Hermes products 对齐（hermes-alignment-round2 Step 2）：/btw /plan /review ─

const CONV_HISTORY = [
  { role: "system", content: "system prompt body" },
  { role: "user", content: "帮我做了一次缓存率测试" },
  { role: "assistant", content: "结果命中率提升到 92%", tool_calls: [{ id: "c1", type: "function", function: { name: "shell_exec", arguments: "{}" } }] },
  { role: "tool", content: "shell 输出很长的一段工具结果", name: "shell_exec" },
  { role: "assistant", content: "全部完成。" },
];

function mkDeps(overrides: Partial<SlashCommandDeps> = {}): SlashCommandDeps {
  return {
    persona: { name: "Test" } as PersonaConfig,
    providers: [],
    config: { ...DEFAULT_MODEL_CONFIG },
    registeredTools: new Map(),
    conversationHistory: new Map([["s1", CONV_HISTORY]]),
    sequentialThinkingHistory: new Map(),
    workspacePath: "/tmp/test-ws",
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    registry: {} as ServiceRegistry,
    memoryHub: null,
    ...overrides,
  };
}

describe("handleSlashCommand /btw 侧问（side_question）", () => {
  it("经 sideQuestionFn 回答，回复含答案与 tokens，快照转录 newest-biased", async () => {
    const calls: Array<{ question: string; transcript: string }> = [];
    const d = mkDeps({
      sideQuestionFn: async (r) => {
        calls.push(r);
        return { answer: "不影响：改动在主循环外", tokensUsed: 320 };
      },
    });
    const r = await handleSlashCommand(d, "/btw 这个改动会影响缓存吗", "s1", Date.now());
    expect(r).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].question).toBe("这个改动会影响缓存吗");
    // 转录包含上下文消息 + 工具标记；system 不传递
    expect(calls[0].transcript).toContain("USER: 帮我做了一次缓存率测试");
    expect(calls[0].transcript).toContain("ASSISTANT [tool calls: shell_exec]");
    expect(calls[0].transcript).toContain("TOOL RESULT [shell_exec]");
    expect(calls[0].transcript).not.toContain("system prompt");
    expect(r!.reply).toContain("不影响：改动在主循环外");
    expect(r!.reply).toContain("不进入主会话历史");
    expect(r!.tokensUsed).toBe(320);
  });

  it("超长消息按 2K 截断", async () => {
    const big = [{ role: "user", content: "x".repeat(3000) }];
    const seen: string[] = [];
    const d2 = mkDeps({
      conversationHistory: new Map([["s1", big]]),
      sideQuestionFn: async (r) => {
        seen.push(r.transcript);
        return { answer: "ok", tokensUsed: 1 };
      },
    });
    await handleSlashCommand(d2, "/btw q", "s1", Date.now());
    expect(seen[0]).toContain("[truncated]");
    expect((seen[0].match(/x/g) ?? []).length).toBeLessThanOrEqual(2000);
  });

  it("未接线 sideQuestionFn 时给出降级提示", async () => {
    const r = await handleSlashCommand(mkDeps(), "/btw 问题", "s1", Date.now());
    expect(r!.reply).toContain("未接线");
  });

  it("缺少侧问内容时给用法提示", async () => {
    const r = await handleSlashCommand(mkDeps({ sideQuestionFn: async () => ({ answer: "", tokensUsed: 0 }) }), "/btw", "s1", Date.now());
    expect(r!.reply).toContain("请在命令后附带侧问内容");
  });
});

describe("handleSlashCommand /plan 规划模式（注入不早退）", () => {
  it("/plan 任务：注入计划提示词消息（injectedMessage），reply 为进入规划模式说明", async () => {
    const r = await handleSlashCommand(mkDeps(), "/plan 重构登录表单校验", "s1", Date.now());
    expect(r).not.toBeNull();
    expect(r!.injectedMessage).toBeTruthy();
    expect(r!.injectedMessage!).toContain("/plan — plan mode");
    expect(r!.injectedMessage!).toContain("重构登录表单校验");
    expect(r!.injectedMessage!).toContain("不直接写生产代码");
    expect(r!.reply).toContain("规划模式");
  });

  it("/plan 无任务时提示用法，不注入", async () => {
    const r = await handleSlashCommand(mkDeps(), "/plan", "s1", Date.now());
    expect(r!.reply).toContain("请附带要规划的任务");
    expect(r!.injectedMessage).toBeUndefined();
  });
});

describe("handleSlashCommand /review 后台评审 fork", () => {
  const ACTION = { tool: "memory", action: "store", target: "user-cache-prefs", preview: "stored" };

  it("接线 reviewForkFn：执行 fork，回复含摘要 + tokens", async () => {
    let snapshot: Array<{ role: string; content: string }> = [];
    const d = mkDeps({
      reviewForkFn: async (snap) => {
        snapshot = snap;
        return { summary: "保存记忆：用户缓存偏好", actions: [ACTION], tokensUsed: 500 };
      },
    });
    const r = await handleSlashCommand(d, "/review", "s1", Date.now());
    expect(r).not.toBeNull();
    expect(snapshot.length).toBeGreaterThan(0);
    expect(snapshot[0].role).toBe("system");
    expect(r!.reply).toContain("后台评审 fork 已执行");
    expect(r!.reply).toContain("保存记忆：用户缓存偏好");
    expect(r!.reply).toContain("未进入主会话历史");
    expect(r!.tokensUsed).toBe(500);
  });

  it("未接线 reviewForkFn：回退到评审提示词输出（原有行为不破坏）", async () => {
    const r = await handleSlashCommand(mkDeps(), "/review", "s1", Date.now());
    expect(r!.reply).toContain("独立审查者");
    expect(r!.reply).toContain("[user]");
    expect(r!.tokensUsed).toBe(0);
  });

  it("空会话 /review：无论接线与否都给空提示", async () => {
    const empty = mkDeps({
      conversationHistory: new Map([["s1", []]]),
      reviewForkFn: async () => ({ summary: "", actions: [], tokensUsed: 0 }),
    });
    const r = await handleSlashCommand(empty, "/review", "s1", Date.now());
    expect(r!.reply).toContain("没有可");
  });
});

describe("handleSlashCommand /help 产品命令注册", () => {
  it("/help 列出 /btw /plan /review /learn 四命令", async () => {
    const r = await handleSlashCommand(mkDeps(), "/help", "s1", Date.now());
    for (const cmd of ["`/btw", "`/plan", "`/review", "`/learn"]) {
      expect(r!.reply).toContain(cmd);
    }
  });
});
