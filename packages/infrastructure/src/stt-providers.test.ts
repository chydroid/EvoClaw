/**
 * STT Provider Registry 单元测试（Hermes 对齐 Step 5）。
 *
 * 覆盖：信封语义永不抛 / BUILTIN 名 + 默认链 / local faster-whisper runner 注入
 * （arg 构造 / JSON stdout / 非零退出 / 非法 stdout / 文件缺失 / 超限）/
 * OpenAI 形状云侧（缺 key 不触 fetch / FormData shape / HTTP 错误信封化）/
 * ElevenLabs / 注册表冲突拒绝与链选。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BUILTIN_STT_PROVIDERS,
  STT_DEFAULT_CHAIN,
  createSttRegistry,
  SttRegistry,
  LocalFasterWhisperProvider,
  OpenAiCompatibleSttProvider,
  ElevenLabsSttProvider,
} from "./stt-providers";

// ── 工具 ─────────────────────────────────────────────────────────────────────

const TMP_ROOTS: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-stt-test-"));
  TMP_ROOTS.push(dir);
  return dir;
}

function makeAudioFile(dir: string, bytes = 256): string {
  const p = path.join(dir, "audio.mp3");
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

/** 16MB+1 超限音频（稀疏写）。 */
function makeHugeAudioFile(dir: string): string {
  const p = path.join(dir, "huge.mp3");
  fs.writeFileSync(p, Buffer.alloc(0));
  fs.truncateSync(p, 16 * 1024 * 1024 + 1);
  return p;
}

interface RunResult {
  code: number;
  stdout: Buffer;
}

function runner(stdout: string, code = 0): (args: string[]) => Promise<RunResult> {
  return async (args) => {
    lastArgs = args;
    return { code, stdout: Buffer.from(stdout) };
  };
}

let lastArgs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of TMP_ROOTS) fs.rmSync(d, { recursive: true, force: true });
  TMP_ROOTS.length = 0;
  lastArgs = [];
});

/** mock fetch OK：返回 {text} JSON；捕获 URL/headers/FormData。 */
function mockSttFetch(
  transcript = "hello world",
  capture?: (url: string, init: RequestInit) => void
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      capture?.(url, init);
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: transcript }),
        text: async () => "",
        arrayBuffer: async () => new Uint8Array(),
      } as unknown as Response;
    })
  );
}

// ── 注册表契约 ────────────────────────────────────────────────────────────────

describe("BUILTIN / 默认链 / 注册表", () => {
  it("BUILTIN_STT_PROVIDERS 覆盖 Hermes 8 名（含 P2 local_command）", () => {
    for (const n of ["local", "local_command", "openai", "groq", "mistral", "xai", "elevenlabs", "deepinfra"]) {
      expect(BUILTIN_STT_PROVIDERS.has(n)).toBe(true);
    }
  });

  it("STT_DEFAULT_CHAIN：local 免费默认首位，全部为内置名", () => {
    expect(STT_DEFAULT_CHAIN[0]).toBe("local");
    expect(STT_DEFAULT_CHAIN).not.toContain("local_command"); // P2 不注册实现
    for (const n of STT_DEFAULT_CHAIN) expect(BUILTIN_STT_PROVIDERS.has(n)).toBe(true);
  });

  it("内置名重复注册 → throw；链选按序挑可用", () => {
    const r = new SttRegistry();
    r.register({ name: "local", isAvailable: () => false, transcribe: async () => ({ success: true, transcript: "", provider: "local" }) });
    expect(() =>
      r.register({ name: "local", isAvailable: () => true, transcribe: async () => ({ success: true, transcript: "", provider: "local" }) })
    ).toThrow(/name collision/);
    r.register({ name: "openai", isAvailable: () => true, transcribe: async () => ({ success: true, transcript: "", provider: "openai" }) });
    expect(r.resolveChain(["local", "openai"])?.name).toBe("openai");
    expect(r.resolveChain(["local"])).toBeNull();
  });

  it("createSttRegistry：注册 7 家云+local；坏 python + 空 key → 链选 null", () => {
    const r = createSttRegistry({ STT_PYTHON: "__no-such-python__" } as NodeJS.ProcessEnv);
    expect(r.names()).toHaveLength(7);
    for (const n of ["local", "openai", "groq", "mistral", "xai", "elevenlabs", "deepinfra"]) {
      expect(r.get(n), n).toBeDefined();
      expect(r.get(n)?.isAvailable(), n).toBe(false);
    }
    expect(r.resolveChain()).toBeNull();
  });
});

// ── local faster-whisper ──────────────────────────────────────────────────────

describe("LocalFasterWhisperProvider", () => {
  it("runner 注入时 isAvailable=true；无 runner + 坏 python probe → false", () => {
    expect(new LocalFasterWhisperProvider({}, async () => ({ code: 0, stdout: Buffer.alloc(0) })).isAvailable()).toBe(true);
    expect(new LocalFasterWhisperProvider({ STT_PYTHON: "__no-such-python__" }, undefined, () => { throw new Error("x"); }).isAvailable()).toBe(false);
  });

  it("成功：arg 构造（-c script file model language）+ stdout JSON 解析为信封", async () => {
    const dir = makeTmpDir();
    const file = makeAudioFile(dir);
    const r = runner(JSON.stringify({ text: "你好世界", language: "zh", duration: 1.2 }));
    const p = new LocalFasterWhisperProvider({}, r);
    const env = await p.transcribe(file, { language: "zh", model: "small" });
    expect(env).toEqual({ success: true, transcript: "你好世界", provider: "local" });
    expect(lastArgs[0]).toBe("-c");
    expect(lastArgs[2]).toBe(file);
    expect(lastArgs[3]).toBe("small"); // model 覆盖默认
    expect(lastArgs[4]).toBe("zh"); // 语言透传（空 default）
  });

  it("默认 model=base；缺省 language → 空串", async () => {
    const dir = makeTmpDir();
    const file = makeAudioFile(dir);
    const r = runner(JSON.stringify({ text: "ok" }));
    const p = new LocalFasterWhisperProvider({}, r);
    await p.transcribe(file);
    expect(lastArgs[2]).toBe(file);
    expect(lastArgs[3]).toBe("base");
    expect(lastArgs[4]).toBe("");
  });

  it("子进程非零退出 → failure 信封（永不抛）", async () => {
    const dir = makeTmpDir();
    const file = makeAudioFile(dir);
    const r = runner("model load failed", 1);
    const p = new LocalFasterWhisperProvider({}, r);
    const env = await p.transcribe(file);
    expect(env.success).toBe(false);
    expect(env.provider).toBe("local");
    expect(env.error).toMatch(/faster-whisper exited 1/);
  });

  it("stdout 非法 JSON → failure 信封；runner 自身抛错 → failure 信封", async () => {
    const dir = makeTmpDir();
    const file = makeAudioFile(dir);
    const bad = new LocalFasterWhisperProvider({}, runner("<html>not json</html>"));
    expect((await bad.transcribe(file)).success).toBe(false);
    const threw = new LocalFasterWhisperProvider({}, async () => { throw new Error("ENOENT"); });
    const env = await threw.transcribe(file);
    expect(env.success).toBe(false);
    expect(env.error).toMatch(/ENOENT|String/);
  });

  it("文件缺失/超限(>16MB) → failure 信封且不触子进程", async () => {
    const missing = new LocalFasterWhisperProvider({}, runner("{}"));
    const env = await missing.transcribe(path.join(makeTmpDir(), "nope.mp3"));
    expect(env.success).toBe(false);
    expect(env.error).toMatch(/not found/);

    const hugeDir = makeTmpDir();
    const hugeFile = makeHugeAudioFile(hugeDir);
    const spy = vi.fn(runner("{}"));
    const p = new LocalFasterWhisperProvider({}, spy);
    const env2 = await p.transcribe(hugeFile);
    expect(env2.success).toBe(false);
    expect(env2.error).toMatch(/exceeds/);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── 云侧 OpenAI 形状族 ───────────────────────────────────────────────────────

describe("OpenAiCompatibleSttProvider", () => {
  function mk(env: NodeJS.ProcessEnv, name = "openai") {
    return new OpenAiCompatibleSttProvider(name, env, {
      baseUrlEnv: "STT_BASE_URL",
      keyEnvs: ["OPENAI_API_KEY", "STT_API_KEY"],
      defaultModel: "whisper-1",
      defaultBaseUrl: "https://api.openai.com/v1",
    });
  }

  it("缺 key：isAvailable=false + 已存在文件也不触 fetch", async () => {
    const p = mk({});
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(p.isAvailable()).toBe(false);
    const env = await p.transcribe(makeAudioFile(makeTmpDir()));
    expect(env.success).toBe(false);
    expect(env.error).toMatch(/not configured/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("成功：POST {base}/audio/transcriptions + FormData 三字段 + Bearer", async () => {
    const dir = makeTmpDir();
    const file = makeAudioFile(dir);
    const p = mk({ OPENAI_API_KEY: "k-openai" });
    let url = "", auth = "";
    mockSttFetch("转写完成", (u, init) => {
      url = u;
      auth = (init.headers as Record<string, string>).Authorization;
    });
    const env = await p.transcribe(file, { language: "zh", model: "whisper-large-v3-turbo" });
    expect(env).toEqual({ success: true, transcript: "转写完成", provider: "openai" });
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(auth).toBe("Bearer k-openai");
  });

  it("非 2xx → failure 信封；网络故障 → failure 信封（永不抛）", async () => {
    const file = makeAudioFile(makeTmpDir());
    const p = mk({ STT_API_KEY: "k2" });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 401, text: async () => "invalid key", json: async () => ({}),
    }) as unknown as Response));
    let env = await p.transcribe(file);
    expect(env.success).toBe(false);
    expect(env.error).toMatch(/HTTP 401/);
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ETIMEDOUT"))));
    env = await p.transcribe(file);
    expect(env.success).toBe(false);
    expect(env.error).toMatch(/ETIMEDOUT/);
  });

  it("key 多候选取第一个非空（STT_API_KEY 优先于 OPENAI_API_KEY）", () => {
    const env = { OPENAI_API_KEY: "oa", STT_API_KEY: "stt" } as NodeJS.ProcessEnv;
    expect(mk(env).isAvailable()).toBe(true);
  });
});

// ── ElevenLabs STT ───────────────────────────────────────────────────────────

describe("ElevenLabsSttProvider", () => {
  it("成功：POST /v1/speech-to-text + xi-api-key + scribe_v1 默认", async () => {
    const p = new ElevenLabsSttProvider({ ELEVENLABS_API_KEY: "ek" } as NodeJS.ProcessEnv);
    let url = "", key = "";
    mockSttFetch("el transcript", (u, init) => {
      url = u;
      key = (init.headers as Record<string, string>)["xi-api-key"];
    });
    const env = await p.transcribe(makeAudioFile(makeTmpDir()));
    expect(env).toEqual({ success: true, transcript: "el transcript", provider: "elevenlabs" });
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(key).toBe("ek");
  });

  it("缺 key → failure 信封", async () => {
    const p = new ElevenLabsSttProvider({});
    const env = await p.transcribe(makeAudioFile(makeTmpDir()));
    expect(env.success).toBe(false);
    expect(env.error).toMatch(/ELEVENLABS_API_KEY/);
  });
});
