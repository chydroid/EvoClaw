/**
 * TTS Provider Registry 单元测试（Hermes 对齐 Step 5）。
 *
 * 覆盖：格式钳位 / 注册表契约（BUILTIN 8 家名 + 默认链 + 冲突拒绝 + 链选）/
 * edge 子进程 arg 构造（voice/rate/常速）+ 非零退出抛错 /
 * 云侧各 provider 缺 key→抛、OK→原子落盘、非 2xx→抛（fetch 全部 stubGlobal mock）。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveOutputFormat,
  defaultTTSOutputDir,
  BUILTIN_TTS_PROVIDERS,
  TTS_DEFAULT_CHAIN,
  createTTSRegistry,
  ProviderRegistry,
  EdgeTTSProvider,
  OpenAiCompatibleTTSProvider,
  XAITTTSProvider,
  ElevenLabsTTSProvider,
  MistralTTSProvider,
  GeminiTTSProvider,
  MiniMaxTTSProvider,
} from "./tts-providers";

// ── 测试工具 ─────────────────────────────────────────────────────────────────

const TMP_ROOTS: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-tts-test-"));
  TMP_ROOTS.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (TMP_ROOTS.length > 0) {
    for (const d of TMP_ROOTS) fs.rmSync(d, { recursive: true, force: true });
    TMP_ROOTS.length = 0;
  }
});

/** mock fetch OK：返回给定音频字节，并记录每次调用。 */
function mockFetchOk(onCall?: (url: string, init: RequestInit) => void): { url: string }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      onCall?.(url, init);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array(Buffer.from("AUDIO-BYTES")),
        text: async () => "",
        json: async () => ({}),
      } as unknown as Response;
    })
  );
  return calls as unknown as { url: string }[];
}

/** mock fetch 不可读（非 2xx）。 */
function mockFetchNotOk(status: number, text = "denied"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status,
      arrayBuffer: async () => new Uint8Array(),
      text: async () => text,
      json: async () => ({}),
    }) as unknown as Response)
  );
}

/** fetch 直接 reject（网络故障）。 */
function mockFetchThrow(err: Error): void {
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(err)));
}

function readCallBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

// ── resolveOutputFormat / 输出目录 ────────────────────────────────────────────

describe("resolveOutputFormat", () => {
  it("known formats pass through (任何大小写/前导点)", () => {
    expect(resolveOutputFormat("mp3")).toBe("mp3");
    expect(resolveOutputFormat("MP3")).toBe("mp3");
    expect(resolveOutputFormat(".wav")).toBe("wav");
    expect(resolveOutputFormat("OGG")).toBe("ogg");
    expect(resolveOutputFormat("opus")).toBe("opus");
    expect(resolveOutputFormat("flac")).toBe("flac");
  });

  it("unknown/empty/undefined 全部钳位 mp3（Hermes 语义）", () => {
    expect(resolveOutputFormat("mp4")).toBe("mp3");
    expect(resolveOutputFormat("")).toBe("mp3");
    expect(resolveOutputFormat(undefined)).toBe("mp3");
  });
});

describe("defaultTTSOutputDir", () => {
  it("existsdir 创建（不污染 workspace，对齐 Hermes ~/voice-memos）", () => {
    const dir = defaultTTSOutputDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir.endsWith("evoclaw-tts")).toBe(true);
  });
});

// ── 注册表契约 ────────────────────────────────────────────────────────────────

describe("ProviderRegistry / BUILTIN 清单", () => {
  it("BUILTIN_TTS_PROVIDERS 覆盖 Hermes 8 家", () => {
    for (const n of ["edge", "openai", "elevenlabs", "minimax", "mistral", "gemini", "xai", "deepinfra"]) {
      expect(BUILTIN_TTS_PROVIDERS.has(n)).toBe(true);
    }
  });

  it("TTS_DEFAULT_CHAIN：edge 免费默认首位，全部为内置名", () => {
    expect(TTS_DEFAULT_CHAIN[0]).toBe("edge");
    for (const n of TTS_DEFAULT_CHAIN) expect(BUILTIN_TTS_PROVIDERS.has(n)).toBe(true);
    expect(new Set(TTS_DEFAULT_CHAIN).size).toBe(TTS_DEFAULT_CHAIN.length);
  });

  it("内置名重复注册 → throw；非内置名重复 → 允许（插件注册语义）", () => {
    const r = new ProviderRegistry<{ name: string; isAvailable(): boolean }>(BUILTIN_TTS_PROVIDERS);
    r.register({ name: "edge", isAvailable: () => true });
    expect(() => r.register({ name: "edge", isAvailable: () => true })).toThrow(/name collision/);
    r.register({ name: "myplugin", isAvailable: () => true });
    r.register({ name: "myplugin", isAvailable: () => false }); // 非内置 → 覆盖成功不抛
    expect(r.has("myplugin")).toBe(true);
  });

  it("resolveChain：按序挑第一个 isAvailable；全不可用 → null", () => {
    const r = new ProviderRegistry<{ name: string; isAvailable(): boolean }>(BUILTIN_TTS_PROVIDERS);
    r.register({ name: "edge", isAvailable: () => false });
    r.register({ name: "openai", isAvailable: () => true });
    expect(r.resolveChain(["edge", "openai"])?.name).toBe("openai");
    expect(r.resolveChain(["edge"])).toBeNull();
    expect(r.resolveChain()).toBeTruthy(); // 无参=注册序
  });

  it("createTTSRegistry(env)：注册满 8 家；坏 python + 空 key → 全部不可用 → 链选 null", () => {
    const r = createTTSRegistry({ EDGE_TTS_PYTHON: "__no-such-python__" } as NodeJS.ProcessEnv);
    expect(new Set(r.names()).size).toBe(8);
    for (const n of ["openai", "elevenlabs", "minimax", "mistral", "gemini", "xai", "deepinfra", "edge"]) {
      expect(r.get(n)?.isAvailable(), n).toBe(false);
    }
    expect(r.resolveChain()).toBeNull();
  });
});

// ── Edge（免费默认；子进程注入） ──────────────────────────────────────────────

describe("EdgeTTSProvider", () => {
  function runnerRecorder(): {
    args: string[][];
    run: (args: string[]) => Promise<{ code: number; stdout: Buffer }>;
  } {
    const args: string[][] = [];
    return {
      args,
      run: async (a: string[]) => {
        args.push(a);
        return { code: 0, stdout: Buffer.alloc(0) };
      },
    };
  }

  it("runner 注入时 isAvailable=true；无 runner + 坏 python probe → false", () => {
    const r = runnerRecorder();
    expect(new EdgeTTSProvider({}, r.run, () => { throw new Error("x"); }).isAvailable()).toBe(true);
    const noRunner = new EdgeTTSProvider({ EDGE_TTS_PYTHON: "__no-such-python__" }, undefined, () => { throw new Error("x") });
    expect(noRunner.isAvailable()).toBe(false);
  });

  it("synthesize：-m edge_tts + --write-media + --text 精确 arg 构造（输出扩展名按 format 归一）", async () => {
    const r = runnerRecorder();
    const p = new EdgeTTSProvider({}, r.run);
    const out = path.join(makeTmpDir(), "spoken.txt");
    const returned = await p.synthesize("你好", { outputPath: out, format: "wav" });
    expect(returned).toBe(path.join(path.dirname(out), "spoken.wav"));
    const a = r.args[0];
    expect(a.slice(0, 2)).toEqual(["-m", "edge_tts"]);
    expect(a).toContain("--write-media");
    expect(a).toContain("--text");
    expect(a.indexOf("--text")).toBe(a.indexOf("你好") - 1);
  });

  it("speed 推演对齐 Hermes：1.0 无 rate；1.5→+50%；2→+100%；0.5→-50%", async () => {
    const r = runnerRecorder();
    const p = new EdgeTTSProvider({}, r.run);
    for (const [speed, expectedRate] of [[1.0, undefined], [1.5, "+50%"], [2, "+100%"], [0.5, "-50%"]] as const) {
      await p.synthesize("x", { speed });
      const a = r.args[r.args.length - 1];
      if (expectedRate === undefined) expect(a).not.toContain("--rate");
      else {
        const i = a.indexOf("--rate");
        expect(i).toBeGreaterThanOrEqual(0);
        expect(a[i + 1]).toBe(expectedRate);
      }
    }
  });

  it("voice → --voice 透传；非零退出 → throw（含 exit code）", async () => {
    const r = runnerRecorder();
    const p = new EdgeTTSProvider({}, async (a) => {
      r.args.push(a);
      return { code: 3, stdout: Buffer.from("boom") };
    });
    await expect(p.synthesize("hi", { voice: "en-US-AriaNeural" })).rejects.toThrow(/edge-tts exited 3/);
    const last = r.args[r.args.length - 1];
    const vi2 = last.indexOf("--voice");
    expect(vi2).toBeGreaterThanOrEqual(0);
    expect(last[vi2 + 1]).toBe("en-US-AriaNeural");
  });
});

// ── OpenAI 兼容族 ─────────────────────────────────────────────────────────────

describe("OpenAiCompatibleTTSProvider / XAI", () => {
  it("missing key：isAvailable=false + synthesize throw（不触 fetch）", async () => {
    const p = new OpenAiCompatibleTTSProvider("openai", {} as NodeJS.ProcessEnv, {
      baseUrlEnv: "TTS_OPENAI_BASE_URL",
      keyEnvs: ["TTS_API_KEY"],
      defaultModel: "gpt-4o-mini-tts",
      defaultVoice: "alloy",
      defaultBaseUrl: "https://api.openai.com/v1",
    });
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(p.isAvailable()).toBe(false);
    await expect(p.synthesize("hi")).rejects.toThrow(/not configured/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("key 多候选取第一个非空；成功路径：POST /audio/speech JSON shape + 原子落盘", async () => {
    const env = { OPENAI_API_KEY: "k-openai", TTS_API_KEY: "" } as NodeJS.ProcessEnv;
    const p = new OpenAiCompatibleTTSProvider("openai", env, {
      baseUrlEnv: "TTS_OPENAI_BASE_URL",
      keyEnvs: ["TTS_API_KEY", "OPENAI_API_KEY"],
      defaultModel: "gpt-4o-mini-tts",
      defaultVoice: "alloy",
      defaultBaseUrl: "https://api.openai.com/v1",
    });
    expect(p.isAvailable()).toBe(true);
    const callUrls: string[] = [];
    mockFetchOk((url) => callUrls.push(url));
    const outPath = path.join(makeTmpDir(), "o.mp3");
    const head = await p.synthesize("hello", { outputPath: outPath, voice: "nova", speed: 1.2, instructions: "cheerful" });
    expect(head).toBe(outPath);
    expect(callUrls).toEqual(["https://api.openai.com/v1/audio/speech"]);
    expect(fs.readFileSync(head, "utf-8")).toBe("AUDIO-BYTES"); // writeAtomically 完成
    expect(fs.existsSync(head)).toBe(true);
    // body 形状校验（捕获 init）——重放一次带 capture 的调用
    let body: Record<string, unknown> | undefined;
    vi.unstubAllGlobals();
    mockFetchOk((_u, init) => { body = readCallBody(init); });
    await p.synthesize("hello2", { voice: "nova", speed: 1.2, instructions: "cheerful" });
    expect(body).toMatchObject({ model: "gpt-4o-mini-tts", voice: "nova", input: "hello2", response_format: "mp3", speed: 1.2, instructions: "cheerful" });
  });

  it("非 2xx → throw（含 HTTP 状态）；网络故障 → throw", async () => {
    const env = { TTS_API_KEY: "k" } as NodeJS.ProcessEnv;
    const mk = () => new OpenAiCompatibleTTSProvider("openai", env, {
      baseUrlEnv: "TTS_OPENAI_BASE_URL", keyEnvs: ["TTS_API_KEY"],
      defaultModel: "m", defaultVoice: "v", defaultBaseUrl: "https://api.example.com/v1",
    });
    mockFetchNotOk(401, "invalid key");
    await expect(mk().synthesize("x")).rejects.toThrow(/TTS HTTP 401/);
    mockFetchThrow(new Error("ECONNREFUSED"));
    await expect(mk().synthesize("x")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("xAI 默认 base https://api.x.ai/v1 + grok-tts/eve 默认（对齐 Hermes）", async () => {
    const p = new XAITTTSProvider({ XAI_API_KEY: "kx" } as NodeJS.ProcessEnv);
    expect(p.isAvailable()).toBe(true);
    const urls: string[] = [];
    mockFetchOk((url) => urls.push(url));
    await p.synthesize("x" /* 默认参数填 baseUrl/model */);
    expect(urls).toEqual(["https://api.x.ai/v1/audio/speech"]);
  });
});

// ── ElevenLabs ───────────────────────────────────────────────────────────────

describe("ElevenLabsTTSProvider", () => {
  it("成功：POST /v1/text-to-speech/{voiceId} + xi-api-key + Adam/模型默认", async () => {
    const p = new ElevenLabsTTSProvider({ ELEVENLABS_API_KEY: "k" } as NodeJS.ProcessEnv);
    const captured: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, init });
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(Buffer.from("EL-AUDIO")), text: async () => "", json: async () => ({}) } as unknown as Response;
    }));
    const out = path.join(makeTmpDir(), "el.mp3");
    const head = await p.synthesize("hi");
    expect(captured[0].url).toBe("https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB");
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("k");
    const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ text: "hi", model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0 } });
    expect(fs.readFileSync(head, "utf-8")).toBe("EL-AUDIO");
  });

  it("缺 env → synthesize throw", async () => {
    const p = new ElevenLabsTTSProvider({});
    await expect(p.synthesize("hi")).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });
});

// ── Mistral / Gemini / MiniMax ───────────────────────────────────────────────

describe("MistralTTSProvider", () => {
  it("默认 voxtral-mini-tts-2603 / Paul UUID + format 字段", async () => {
    const p = new MistralTTSProvider({ MISTRAL_API_KEY: "mk" } as NodeJS.ProcessEnv);
    let url = "", body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, init: RequestInit) => {
      url = u; body = readCallBody(init);
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(Buffer.from("MI")), text: async () => "", json: async () => ({}) } as unknown as Response;
    }));
    await p.synthesize("hi", { format: "flac" });
    expect(url).toBe("https://api.mistral.ai/v1/audio/speech");
    expect(body).toMatchObject({ model: "voxtral-mini-tts-2603", voice: "c69964a6-ab8b-4f8a-9465-ec0925096ec8", input: "hi", format: "flac" });
  });
});

describe("GeminiTTSProvider", () => {
  function mockGemini(dataB64: string, extra?: Record<string, unknown>): void {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { data: dataB64 } }] } }],
        ...extra,
      }),
      text: async () => "",
      arrayBuffer: async () => new Uint8Array(),
    }) as unknown as Response));
  }

  it("voice 作为风格指令注入 prompt（beta voice_name 不稳定 → Hermes 同构）；inlineData 解码落盘", async () => {
    const p = new GeminiTTSProvider({ GEMINI_API_KEY: "gk" } as NodeJS.ProcessEnv);
    const audio = Buffer.from([1, 2, 3, 4]).toString("base64");
    mockGemini(audio);
    let body: Record<string, unknown> | undefined;
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async (_u, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return {
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: audio } }] } }] }),
        text: async () => "", arrayBuffer: async () => new Uint8Array(),
      } as unknown as Response;
    }));
    const head = await p.synthesize("hello", { instructions: "calm", voice: "Kore" });
    const content = (body!.contents as Array<Record<string, unknown>>)[0];
    const parts = content.parts as Array<{ text: string }>;
    expect(parts[0].text).toContain("Voice: Kore.");
    expect(parts[0].text).toContain("calm");
    expect(parts[0].text).toContain("\n\nhello");
    expect(fs.readFileSync(head)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("无 inlineData → throw；error 响应 → throw（携带 message）", async () => {
    const p = new GeminiTTSProvider({ GEMINI_API_KEY: "gk" } as NodeJS.ProcessEnv);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "no audio" }] } }] }),
      text: async () => "", arrayBuffer: async () => new Uint8Array(),
    }) as unknown as Response));
    await expect(p.synthesize("x")).rejects.toThrow(/no audio/);
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ error: { message: "quota exceeded" } }),
      text: async () => "", arrayBuffer: async () => new Uint8Array(),
    }) as unknown as Response));
    await expect(p.synthesize("x")).rejects.toThrow(/quota exceeded/);
  });
});

describe("MiniMaxTTSProvider", () => {
  it("成功：base_url t2a_v2 + speech-02-hd / English_expressive_narrator + audio_setting.format", async () => {
    const p = new MiniMaxTTSProvider({ MINIMAX_API_KEY: "mm" } as NodeJS.ProcessEnv);
    let url = "", body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, init: RequestInit) => {
      url = u; body = readCallBody(init);
      return {
        ok: true, status: 200,
        json: async () => ({ data: { audio: Buffer.from("MM").toString("base64") }, baseResponse: { errorCode: 0 } }),
        text: async () => "", arrayBuffer: async () => new Uint8Array(),
      } as unknown as Response;
    }));
    const out = path.join(makeTmpDir(), "mm.mp3");
    const head = await p.synthesize("hi", { format: "mp3" });
    expect(url).toBe("https://api.minimax.io/v1/t2a_v2");
    const vs = body!.voice_setting as Record<string, unknown>;
    expect(vs.voice_id).toBe("English_expressive_narrator");
    expect(vs.speed).toBe(1);
    expect((body!.audio_setting as Record<string, unknown>).format).toBe("mp3");
    expect((body!.audio_setting as Record<string, unknown>).sample_rate).toBe(32000);
    expect(fs.readFileSync(head, "utf-8")).toBe("MM");
  });

  it("CN 模式 base_url；errorCode 非零 → throw", async () => {
    const p = new MiniMaxTTSProvider({ MINIMAX_API_KEY: "mm", MINIMAX_CN: "1" } as NodeJS.ProcessEnv);
    let url = "";
    vi.stubGlobal("fetch", vi.fn(async (u: string, _init: RequestInit) => {
      url = u;
      return {
        ok: true, status: 200,
        json: async () => ({ baseResponse: { errorCode: 1004, errorMsg: "invalid token" } }),
        text: async () => "", arrayBuffer: async () => new Uint8Array(),
      } as unknown as Response;
    }));
    await expect(p.synthesize("x")).rejects.toThrow(/1004/);
    expect(url).toBe("https://api.minimaxi.com/v1/t2a_v2");
  });
});
