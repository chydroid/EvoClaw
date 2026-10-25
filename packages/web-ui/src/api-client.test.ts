import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getSafe, getSafeResult, errorMessage } from "./api-client";

describe("api-client getSafe / getSafeResult", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getSafe 在 fetch 成功时返回解析后的数据", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const result = await getSafe<{ ok: boolean }>("/api/x", { ok: false });
    expect(result).toEqual({ ok: true });
  });

  it("getSafe 在 fetch 失败时返回 fallback（不抛错）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const result = await getSafe<string>("/api/x", "fallback");
    expect(result).toBe("fallback");
  });

  it("getSafe 在 HTTP 非 2xx 时返回 fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 503 })));
    const result = await getSafe<string>("/api/x", "fallback");
    expect(result).toBe("fallback");
  });

  it("getSafeResult 成功时 error 为 null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([1, 2, 3]), { status: 200 })));
    const result = await getSafeResult<number[]>("/api/x", []);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([1, 2, 3]);
  });

  it("getSafeResult 失败时返回 fallback 与错误文案，且不产生 Error: 前缀", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("NetworkError"); }));
    const result = await getSafeResult<string>("/api/x", "fb");
    expect(result.data).toBe("fb");
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain("Error: Error");
  });

  it("getSafeResult 在 HTTP 非 2xx 时返回人化文案而非原始 HTTP 串", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"not found"}', { status: 404 })));
    const result = await getSafeResult<string>("/api/x", "fb");
    expect(result.data).toBe("fb");
    expect(result.error).toBe("not found");
  });
});

describe("api-client errorMessage（经 api-client 导出）", () => {
  it("字符串原样返回", () => {
    expect(errorMessage("offline")).toBe("offline");
  });
  it("普通 Error 取 message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
});