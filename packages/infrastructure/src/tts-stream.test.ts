/**
 * P2-1 TTS 流式输出：provider 降级语义 + 句子切分 + barge-in 会话注册表测试。
 */
import { describe, it, expect } from "vitest";
import {
  OpenAITTSProvider,
  createDefaultTTSProvider,
  splitTextIntoFragments,
  TTSPlaybackRegistry,
} from "./tts-stream";

describe("P2-1 splitTextIntoFragments", () => {
  it("空文本返回空数组", () => {
    expect(splitTextIntoFragments("")).toEqual([]);
    expect(splitTextIntoFragments("   ")).toEqual([]);
  });

  it("按句界切分并合并过短片段", () => {
    // 三句（22 字 < 80）经合并策略合成 1 个 80 字内片段；
    // 总长 ≤ maxLen 时不产生多片（这是"合并过短片段"的预期行为）
    const frags = splitTextIntoFragments("你好。今天天气不错，适合散步。晚上吃点什么？");
    expect(frags.length).toBe(1);
    expect(frags[0]).toBe("你好。今天天气不错，适合散步。晚上吃点什么？");
  });

  it("长文本超过 maxLen 时切成多片，每片 ≤ maxLen", () => {
    const long = Array.from({ length: 30 }, (_, i) => `第${i + 1}句话。`).join("");
    const frags = splitTextIntoFragments(long);
    expect(frags.length).toBeGreaterThan(1);
    for (const f of frags) {
      expect(f.length).toBeLessThanOrEqual(80);
    }
  });

  it("短文本不切分", () => {
    expect(splitTextIntoFragments("你好")).toEqual(["你好"]);
  });
});

describe("P2-1 OpenAITTSProvider 降级语义", () => {
  it("无 TTS_API_KEY 时 isAvailable()=false，synthesize 产出静音降级 chunk", async () => {
    const provider = new OpenAITTSProvider({} as NodeJS.ProcessEnv);
    expect(provider.isAvailable()).toBe(false);

    const chunks: unknown[] = [];
    for await (const c of provider.synthesize("你好。")) {
      chunks.push(c);
    }
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks as Array<{ degraded: boolean; audio: string; sampleRate: number }>) {
      expect(c.degraded).toBe(true);
      expect(c.audio).toBeTypeOf("string");
      expect(c.sampleRate).toBe(16000);
    }
  });

  it("有 TTS_API_KEY 时 isAvailable()=true", () => {
    const provider = new OpenAITTSProvider({ TTS_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    expect(provider.isAvailable()).toBe(true);
    expect(provider.name).toBe("openai-tts");
  });

  it("createDefaultTTSProvider 读 env，缺 key 返回降级 provider", () => {
    const provider = createDefaultTTSProvider({} as NodeJS.ProcessEnv);
    expect(provider.isAvailable()).toBe(false);
  });
});

describe("P2-1 TTSPlaybackRegistry（barge-in）", () => {
  it("register 返回 AbortController，cancel 触发 abort 并注销", () => {
    const reg = new TTSPlaybackRegistry();
    const controller = reg.register("sess-1");
    expect(reg.has("sess-1")).toBe(true);
    expect(controller.signal.aborted).toBe(false);

    const cancelled = reg.cancel("sess-1");
    expect(cancelled).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(reg.has("sess-1")).toBe(false);
  });

  it("cancel 未知 session 返回 false", () => {
    const reg = new TTSPlaybackRegistry();
    expect(reg.cancel("nope")).toBe(false);
  });

  it("complete 仅注销不 abort", () => {
    const reg = new TTSPlaybackRegistry();
    const controller = reg.register("sess-2");
    reg.complete("sess-2");
    expect(reg.has("sess-2")).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("cancelAll 取消全部活动会话并返回数量", () => {
    const reg = new TTSPlaybackRegistry();
    const c1 = reg.register("a");
    const c2 = reg.register("b");
    const cancelled = reg.cancelAll();
    expect(cancelled).toBe(2);
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    expect(reg.activeCount()).toBe(0);
  });

  it("synthesize 接受 AbortSignal，barge-in 后 complete() 注销会话", async () => {
    const provider = new OpenAITTSProvider({} as NodeJS.ProcessEnv); // 降级模式（静默 chunk 即时产出）
    const reg = new TTSPlaybackRegistry();
    const controller = reg.register("sess-3");
    let count = 0;
    for await (const _c of provider.synthesize("一。二。三。四。五。", { signal: controller.signal })) {
      count++;
      if (count >= 1) break; // 降级模式把全部文本合并成 1 个静默 chunk（80 字内不切分），消费 1 片即停
    }
    // 本地消费停止后，正常路径应 complete() 注销（barge-in 场景则由 cancel() 注销）
    reg.complete("sess-3");
    expect(reg.has("sess-3")).toBe(false);
    expect(count).toBe(1);
  });
});
