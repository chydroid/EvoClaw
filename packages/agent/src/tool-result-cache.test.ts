import { describe, it, expect, beforeEach } from "vitest";
import { ToolResultCache } from "./tool-result-cache";

// ═══════════════════════════════════════════════════════════
// 测试套件：ToolResultCache（工具结果缓存）
// ═══════════════════════════════════════════════════════════

describe("ToolResultCache > shouldCache", () => {
  it("默认黑名单工具不缓存", () => {
    const cache = new ToolResultCache();
    expect(cache.shouldCache("write_file")).toBe(false);
    expect(cache.shouldCache("delete_file")).toBe(false);
    expect(cache.shouldCache("execute_command")).toBe(false);
    expect(cache.shouldCache("install_skill")).toBe(false);
  });

  it("只读工具默认缓存", () => {
    const cache = new ToolResultCache();
    expect(cache.shouldCache("read_file")).toBe(true);
    expect(cache.shouldCache("list_dir")).toBe(true);
    expect(cache.shouldCache("web_search")).toBe(true);
  });

  it("白名单优先：仅缓存白名单内工具", () => {
    const cache = new ToolResultCache({ onlyCacheTools: ["read_file"] });
    expect(cache.shouldCache("read_file")).toBe(true);
    expect(cache.shouldCache("list_dir")).toBe(false);
  });
});

describe("ToolResultCache > get/set", () => {
  let cache: ToolResultCache;

  beforeEach(() => {
    cache = new ToolResultCache({ defaultTtlMs: 1000 });
  });

  it("首次查询未命中", () => {
    const r = cache.get("read_file", { path: "/foo" });
    expect(r.hit).toBe(false);
  });

  it("写入后命中", () => {
    cache.set("read_file", { path: "/foo" }, "content-foo");
    const r = cache.get("read_file", { path: "/foo" });
    expect(r.hit).toBe(true);
    expect(r.value).toBe("content-foo");
  });

  it("参数顺序不影响命中", () => {
    cache.set("read_file", { path: "/foo", encoding: "utf8" }, "v");
    const r = cache.get("read_file", { encoding: "utf8", path: "/foo" });
    expect(r.hit).toBe(true);
    expect(r.value).toBe("v");
  });

  it("黑名单工具不缓存（set 后 get 仍 miss）", () => {
    cache.set("write_file", { path: "/foo" }, "done");
    const r = cache.get("write_file", { path: "/foo" });
    expect(r.hit).toBe(false);
  });

  it("TTL 过期后未命中", async () => {
    cache = new ToolResultCache({ defaultTtlMs: 50 });
    cache.set("read_file", { path: "/foo" }, "v");
    await new Promise((r) => setTimeout(r, 80));
    const r = cache.get("read_file", { path: "/foo" });
    expect(r.hit).toBe(false);
  });

  it("TTL 覆盖：特定工具使用不同 TTL", async () => {
    cache = new ToolResultCache({
      defaultTtlMs: 1000,
      ttlOverrides: { read_file: 30 },
    });
    cache.set("read_file", { path: "/foo" }, "v");
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get("read_file", { path: "/foo" }).hit).toBe(false);
  });
});

describe("ToolResultCache > LRU 淘汰", () => {
  it("超过 maxEntries 时淘汰最旧", () => {
    const cache = new ToolResultCache({ maxEntries: 2 });
    cache.set("read_file", { path: "/a" }, 1);
    cache.set("read_file", { path: "/b" }, 2);
    cache.set("read_file", { path: "/c" }, 3);
    // /a 应被淘汰
    expect(cache.get("read_file", { path: "/a" }).hit).toBe(false);
    expect(cache.get("read_file", { path: "/b" }).hit).toBe(true);
    expect(cache.get("read_file", { path: "/c" }).hit).toBe(true);
  });

  it("LRU 访问更新位置：最近访问不被淘汰", () => {
    const cache = new ToolResultCache({ maxEntries: 2 });
    cache.set("read_file", { path: "/a" }, 1);
    cache.set("read_file", { path: "/b" }, 2);
    // 访问 /a 使其成为最近访问
    cache.get("read_file", { path: "/a" });
    cache.set("read_file", { path: "/c" }, 3);
    // /b 应被淘汰（最久未访问）
    expect(cache.get("read_file", { path: "/b" }).hit).toBe(false);
    expect(cache.get("read_file", { path: "/a" }).hit).toBe(true);
    expect(cache.get("read_file", { path: "/c" }).hit).toBe(true);
  });
});

describe("ToolResultCache > invalidateTool", () => {
  it("失效指定工具的所有缓存", () => {
    const cache = new ToolResultCache();
    cache.set("read_file", { path: "/a" }, 1);
    cache.set("read_file", { path: "/b" }, 2);
    cache.set("list_dir", { path: "/c" }, 3);

    cache.invalidateTool("read_file");

    expect(cache.get("read_file", { path: "/a" }).hit).toBe(false);
    expect(cache.get("read_file", { path: "/b" }).hit).toBe(false);
    expect(cache.get("list_dir", { path: "/c" }).hit).toBe(true);
  });
});

describe("ToolResultCache > getStats", () => {
  it("统计命中/未命中", () => {
    const cache = new ToolResultCache();
    cache.set("read_file", { path: "/a" }, "v");
    cache.get("read_file", { path: "/a" }); // hit
    cache.get("read_file", { path: "/b" }); // miss
    cache.get("write_file", { path: "/a" }); // miss（黑名单）

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.size).toBe(1);
    expect(stats.hitRate).toBeCloseTo(1 / 3, 5);
    expect(stats.byTool.read_file.hits).toBe(1);
    expect(stats.byTool.read_file.misses).toBe(1);
    expect(stats.byTool.write_file.misses).toBe(1);
  });

  it("clear 重置统计", () => {
    const cache = new ToolResultCache();
    cache.set("read_file", { path: "/a" }, "v");
    cache.get("read_file", { path: "/a" });
    cache.clear();
    const stats = cache.getStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });
});
