/**
 * TTS/STT 工具注册与链选行为测试（Hermes 对齐 Step 5）。
 *
 * 验证：
 * - text_to_speech schema 契约（text required + provider/voice/speed/instructions）
 * - checkFn 门控：链上无任何可用 provider → 工具不暴露（无 key 且 edge 引擎坏）
 * - 链选 + 降级：edge 抛错 → 自动落 openai；全部失败 → 聚合 error
 * - 输出：写盘 + 返回 path/format/provider/size（output_path 扩展名钳位）
 * - audio_to_text 信封语义：文件缺失 → failure 信封（不抛）；未知 provider → error 信封；
 *   链上成功 → 直接透传信封
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerTtsTools, checkTtsRequirements } from "../src/tools/tts-tools";
import { registerSttTools, checkSttRequirements } from "../src/tools/stt-tools";
import { ServiceRegistry } from "@evoclaw/core";
import { createTTSRegistry, ProviderRegistry, BUILTIN_TTS_PROVIDERS } from "@evoclaw/infrastructure";
import { SttRegistry, type TranscriptionProvider } from "@evoclaw/infrastructure";

interface Registered {
  name: string;
  definition: { name: string; description: string; parameters: Record<string, unknown> };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  checkFn?: () => boolean;
}

function createHarness() {
  const registered: Registered[] = [];
  const executor = {
    registerTool(name: string, definition: Registered["definition"], handler: Registered["handler"], checkFn?: () => boolean) {
      registered.push({ name, definition, handler, checkFn });
    },
  };
  return { registered, executor };
}

function tool(registered: Registered[], name: string): Registered {
  const t = registered.find((r) => r.name === name);
  if (!t) throw new Error(`tool not registered: ${name}`);
  return t;
}

const TMP_ROOTS: string[] = [];
function tmp(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-ttsstt-"));
  TMP_ROOTS.push(root);
  return path.join(root, name);
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of TMP_ROOTS) {
    // 只删除自己 mkdtemp 出来的目录；绝不能对 os.tmpdir() 根做 rmSync
    // （历史上 cleanup 用 path.dirname(p)，p 为 outDir 本身时会删掉整个 TMPDIR，
    //  连带摧毁 vitest 的 ssr 缓存目录 → 255+ 套件 collect ENOENT）。
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  TMP_ROOTS.length = 0;
});

describe("text_to_speech（Provider Registry 链选）", () => {
  it("schema 契约：text required；provider/voice/speed/instructions 可选", () => {
    const { registered, executor } = createHarness();
    registerTtsTools(executor as never, new ServiceRegistry());
    const t = tool(registered, "text_to_speech");
    const props = t.definition.parameters.properties as Record<string, { required?: boolean }>;
    expect(t.definition.parameters.required).toEqual(["text"]);
    expect(props.text).toBeDefined();
    // 可选字段：required 不得为 true（false 或缺省均合法）
    for (const k of ["provider", "voice", "speed", "instructions", "output_path"]) expect(props[k]?.required === true).toBe(false);
  });

  it("空 text → error（不触链）", async () => {
    const { registered, executor } = createHarness();
    registerTtsTools(executor as never, new ServiceRegistry());
    const res = await tool(registered, "text_to_speech").handler({ text: "  " });
    expect(res).toHaveProperty("error");
  });

  it("超 4096 字 → error", async () => {
    const { registered, executor } = createHarness();
    registerTtsTools(executor as never, new ServiceRegistry());
    const res = await tool(registered, "text_to_speech").handler({ text: "x".repeat(5000) });
    expect((res as { error: string }).error).toMatch(/exceeds maximum length/);
  });

  it("无 key + edge 引擎坏 → checkFn false + handler 聚合报错", () => {
    const { registered, executor } = createHarness();
    const registry = new ServiceRegistry();
    registry.registerService(
      "ttsRegistry",
      createTTSRegistry({ EDGE_TTS_PYTHON: "__no-such-python__" } as NodeJS.ProcessEnv)
    );
    registerTtsTools(executor as never, registry);
    const t = tool(registered, "text_to_speech");
    expect(t.checkFn?.()).toBe(false);
    // 无 key 直接调用 → 各家 not available，聚合 error
    return (t.handler({ text: "hello" }) as Promise<{ error: string }>).then((r) => {
      expect(r.error).toMatch(/All TTS providers failed/);
      expect(r.error).toMatch(/openai: not available/);
    });
  });

  it("openai key + fetch OK → 落盘成功 + provider 归属正确", async () => {
    const { registered, executor } = createHarness();
    const registry = new ServiceRegistry();
    registry.registerService(
      "ttsRegistry",
      createTTSRegistry({
        EDGE_TTS_PYTHON: "__no-such-python__",
        TTS_API_KEY: "test-key",
      } as NodeJS.ProcessEnv)
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => new Uint8Array(Buffer.from("TTS-AUDIO-DATA")),
      text: async () => "", json: async () => ({}),
    }) as unknown as Response));
    registerTtsTools(executor as never, registry);
    const out = tmp("synth.mp3");
    const res = await tool(registered, "text_to_speech").handler({ text: "hello", output_path: out });
    expect(res).not.toHaveProperty("error");
    expect(res).toMatchObject({ path: out, format: "mp3", provider: "openai", size: Buffer.byteLength("TTS-AUDIO-DATA") });
    expect(fs.readFileSync(out, "utf-8")).toBe("TTS-AUDIO-DATA"); // 原子写完成
  });

  it("edge 抛错 → 链选降级 openai", async () => {
    const { registered, executor } = createHarness();
    // 手工注册表：edge 可用但合成抛错 → 自动落 openai（落盘成功即通过）
    const reg = new ProviderRegistry(BUILTIN_TTS_PROVIDERS);
    reg.register({
      name: "edge",
      isAvailable: () => true,
      synthesize: async () => { throw new Error("edge engine broken"); },
    } as never);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-ttsstt-"));
    reg.register({
      name: "openai",
      isAvailable: () => true,
      synthesize: async (text: string) => {
        const p = path.join(outDir, "ok.mp3");
        fs.writeFileSync(p, text.toUpperCase());
        return p;
      },
    } as never);
    TMP_ROOTS.push(outDir);
    const registry = new ServiceRegistry();
    registry.registerService("ttsRegistry", reg);
    registerTtsTools(executor as never, registry);
    const res = await tool(registered, "text_to_speech").handler({ text: "hello" });
    expect(res).toMatchObject({ provider: "openai", format: "mp3", size: 5 });
  });

  it("未知 provider 名 → error 清单已注册名", async () => {
    const { registered, executor } = createHarness();
    const registry = new ServiceRegistry();
    registry.registerService("ttsRegistry", createTTSRegistry({} as NodeJS.ProcessEnv));
    registerTtsTools(executor as never, registry);
    const res = await tool(registered, "text_to_speech").handler({ text: "hi", provider: "typo-provider" });
    expect((res as { error: string }).error).toMatch(/Unknown TTS provider: typo-provider/);
  });
});

describe("audio_to_text（envelope 语义）", () => {
  function mockProvider(partial: Partial<TranscriptionProvider> & { name: string }): TranscriptionProvider {
    return {
      isAvailable: partial.isAvailable ?? (() => true),
      transcribe: partial.transcribe ?? (async () => ({ success: true, transcript: "x", provider: partial.name })),
      ...partial,
    };
  }

  it("schema 契约：audio_path required", () => {
    const { registered, executor } = createHarness();
    const registry = new ServiceRegistry();
    registry.registerService("sttRegistry", new SttRegistry());
    registerSttTools(executor as never, registry);
    const t = tool(registered, "audio_to_text");
    expect(t.definition.parameters.required).toEqual(["audio_path"]);
  });

  it("文件缺失 → failure 信封（不抛、不触链）", async () => {
    const { registered, executor } = createHarness();
    const registry = new ServiceRegistry();
    const reg = new SttRegistry();
    reg.register(mockProvider({ name: "local", transcribe: vi.fn(async () => ({ success: true, transcript: "SHOULD-NOT-RUN", provider: "local" })) }));
    registry.registerService("sttRegistry", reg);
    registerSttTools(executor as never, registry);
    const res = await tool(registered, "audio_to_text").handler({ audio_path: tmp("nonexistent.mp3") });
    expect(res).toMatchObject({ success: false, provider: "chain" });
    expect((res as { error: string }).error).toMatch(/not found/);
  });

  it("链上成功 → 直接透传信封（provider 属性原生名）", async () => {
    const { registered, executor } = createHarness();
    const registry = new ServiceRegistry();
    const reg = new SttRegistry();
    reg.register(mockProvider({ name: "local", transcribe: vi.fn(async () => ({ success: true, transcript: "你好", provider: "local" })) }));
    registry.registerService("sttRegistry", reg);
    registerSttTools(executor as never, registry);
    const f = tmp("a.wav");
    fs.writeFileSync(f, Buffer.from("audio"));
    const res = await tool(registered, "audio_to_text").handler({ audio_path: f, language: "zh", model: "small" });
    expect(res).toEqual({ success: true, transcript: "你好", provider: "local" });
  });

  it("全部失败 → 聚合 all-fail 信封（永不抛）", async () => {
    const { registered, executor } = createHarness();
    const registry = new ServiceRegistry();
    const reg = new SttRegistry();
    reg.register(mockProvider({
      name: "local",
      isAvailable: () => true,
      transcribe: async () => ({ success: false, transcript: "", provider: "local", error: "backend missing" }),
    }));
    registry.registerService("sttRegistry", reg);
    registerSttTools(executor as never, registry);
    const f = tmp("a.wav");
    fs.writeFileSync(f, Buffer.from("audio"));
    const res = await tool(registered, "audio_to_text").handler({ audio_path: f });
    expect(res).toMatchObject({ success: false, provider: "chain" });
    expect((res as { error: string }).error).toMatch(/All STT providers failed/);
    expect((res as { error: string }).error).toMatch(/local: backend missing/);
  });

  it("checkSttRequirements：空链 → false；local 可用 → true", () => {
    const empty = new ServiceRegistry();
    empty.registerService("sttRegistry", new SttRegistry());
    expect(checkSttRequirements(empty)).toBe(false);
    const avail = new ServiceRegistry();
    const sr = new SttRegistry();
    sr.register(mockProvider({ name: "local" }));
    avail.registerService("sttRegistry", sr);
    expect(checkSttRequirements(avail)).toBe(true);
  });

  it("checkTtsRequirements：注入链空 → false；有可用 → true", () => {
    const empty = new ServiceRegistry();
    empty.registerService("ttsRegistry", new ProviderRegistry(BUILTIN_TTS_PROVIDERS));
    expect(checkTtsRequirements(empty)).toBe(false);
    const avail = new ServiceRegistry();
    const tr = new ProviderRegistry(BUILTIN_TTS_PROVIDERS);
    tr.register({ name: "openai", isAvailable: () => true });
    avail.registerService("ttsRegistry", tr);
    expect(checkTtsRequirements(avail)).toBe(true);
  });
});
