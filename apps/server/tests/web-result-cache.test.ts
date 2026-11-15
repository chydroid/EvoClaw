import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  SearchMemo,
  ExtractCache,
  buildSearchMemoKey,
  resolveWebCacheConfig,
  DEFAULT_WEB_CACHE_CONFIG,
} from "../src/tools/web-result-cache";

describe("buildSearchMemoKey", () => {
  it("归一化查询（trim/小写/合并空白）", () => {
    expect(buildSearchMemoKey({ query: "  Hello   World ", limit: 10 }))
      .toBe(buildSearchMemoKey({ query: "hello world", limit: 10 }));
  });

  it("limit 归入 10/20/50/100 桶", () => {
    expect(buildSearchMemoKey({ query: "q", limit: 7 })).toContain("|10|");
    expect(buildSearchMemoKey({ query: "q", limit: 15 })).toContain("|20|");
    expect(buildSearchMemoKey({ query: "q", limit: 30 })).toContain("|50|");
    expect(buildSearchMemoKey({ query: "q", limit: 999 })).toContain("|100|");
  });

  it("freshness 参与键", () => {
    expect(buildSearchMemoKey({ query: "q", limit: 10, freshness: "day" }))
      .not.toBe(buildSearchMemoKey({ query: "q", limit: 10, freshness: "week" }));
  });
});

describe("SearchMemo", () => {
  it("set/get 与 TTL 过期", () => {
    const memo = new SearchMemo<string>({ ttlMs: 1000 });
    memo.set("k", "v", 1_000_000);
    expect(memo.get("k", 1_000_500)).toBe("v");
    expect(memo.get("k", 1_001_001)).toBeUndefined();
  });

  it("单飞：并发相同 key 只执行一次", async () => {
    const memo = new SearchMemo<number>({ ttlMs: 60_000 });
    let calls = 0;
    const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return 42; };
    const [a, b, c] = await Promise.all([memo.run("k", fn), memo.run("k", fn), memo.run("k", fn)]);
    expect(calls).toBe(1);
    expect([a, b, c]).toEqual([42, 42, 42]);
  });

  it("成功结果入缓存，后续命中不再执行", async () => {
    const memo = new SearchMemo<number>({ ttlMs: 60_000 });
    let calls = 0;
    const fn = async () => { calls++; return 7; };
    await memo.run("k", fn);
    await memo.run("k", fn);
    expect(calls).toBe(1);
  });

  it("失败结果不入缓存（isSuccess=false 时下一次重跑）", async () => {
    const memo = new SearchMemo<{ success?: boolean }>({ ttlMs: 60_000 });
    let calls = 0;
    const fn = async () => { calls++; return { success: false }; };
    await memo.run("k", fn, (v) => v.success !== false);
    await memo.run("k", fn, (v) => v.success !== false);
    expect(calls).toBe(2);
  });

  it("不同 key 各自执行", async () => {
    const memo = new SearchMemo<number>({ ttlMs: 60_000 });
    let calls = 0;
    const fn = async () => { calls++; return calls; };
    await memo.run("a", fn);
    await memo.run("b", fn);
    expect(calls).toBe(2);
  });

  it("上限淘汰最旧条目", () => {
    const memo = new SearchMemo<number>({ ttlMs: 60_000, maxEntries: 2 });
    memo.set("a", 1); memo.set("b", 2); memo.set("c", 3);
    expect(memo.size()).toBe(2);
    expect(memo.get("a")).toBeUndefined();
    expect(memo.get("c")).toBe(3);
  });
});

describe("resolveWebCacheConfig", () => {
  it("默认：抓取缓存关闭、TTL 20 分钟", () => {
    const cfg = resolveWebCacheConfig({});
    expect(cfg.extractEnabled).toBe(false);
    expect(cfg.extractTtlMinutes).toBe(DEFAULT_WEB_CACHE_CONFIG.extractTtlMinutes);
  });

  it("env 开启抓取缓存并覆盖 TTL", () => {
    const cfg = resolveWebCacheConfig({
      EVOCLAW_WEB_CACHE_ENABLED: "true",
      EVOCLAW_WEB_CACHE_TTL_MINUTES: "5",
      EVOCLAW_WEB_SEARCH_MEMO_TTL_MINUTES: "30",
    });
    expect(cfg.extractEnabled).toBe(true);
    expect(cfg.extractTtlMinutes).toBe(5);
    expect(cfg.searchMemoTtlMinutes).toBe(30);
  });

  it("非法 TTL 回落默认", () => {
    const cfg = resolveWebCacheConfig({ EVOCLAW_WEB_CACHE_TTL_MINUTES: "abc" });
    expect(cfg.extractTtlMinutes).toBe(DEFAULT_WEB_CACHE_CONFIG.extractTtlMinutes);
  });
});

describe("ExtractCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-extract-cache-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("set/get 往返", () => {
    const cache = new ExtractCache(dir, 60_000);
    cache.set("https://example.com/a", { title: "A", text: "hello" }, 1_000_000);
    const got = cache.get("https://example.com/a", 1_000_100);
    expect(got).not.toBeNull();
    expect(got!.title).toBe("A");
    expect(got!.text).toBe("hello");
  });

  it("未命中返回 null", () => {
    const cache = new ExtractCache(dir, 60_000);
    expect(cache.get("https://nope", 1_000_000)).toBeNull();
  });

  it("TTL 过期返回 null 并清理索引", () => {
    const cache = new ExtractCache(dir, 60_000);
    cache.set("https://example.com/b", { title: "B", text: "x" }, 1_000_000);
    expect(cache.get("https://example.com/b", 1_000_000 + 60_001)).toBeNull();
    // 再次读取仍未命中
    expect(cache.get("https://example.com/b", 1_000_000 + 60_001)).toBeNull();
  });

  it("不同 URL 独立缓存", () => {
    const cache = new ExtractCache(dir, 60_000);
    cache.set("https://a", { title: "A", text: "1" }, 1_000_000);
    cache.set("https://b", { title: "B", text: "2" }, 1_000_000);
    expect(cache.get("https://a", 1_000_000)!.text).toBe("1");
    expect(cache.get("https://b", 1_000_000)!.text).toBe("2");
  });

  it("索引文件落盘为 JSON", () => {
    const cache = new ExtractCache(dir, 60_000);
    cache.set("https://example.com/c", { title: "C", text: "x" }, 1_000_000);
    const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf-8"));
    expect(Object.keys(idx.entries).length).toBe(1);
  });
});
