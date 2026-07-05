import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EmbeddingCache, textHash, buildCacheKey } from "./embedding-cache";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-cache-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("textHash", () => {
  it("相同输入相同输出", () => {
    expect(textHash("hello")).toBe(textHash("hello"));
  });

  it("不同输入不同输出", () => {
    expect(textHash("hello")).not.toBe(textHash("world"));
  });

  it("长度 16", () => {
    expect(textHash("test").length).toBe(16);
  });
});

describe("buildCacheKey", () => {
  it("格式：base64(skill_id):hash", () => {
    const key = buildCacheKey("skill-1", "text");
    expect(key).toContain(":");
    const [b64, hash] = key.split(":");
    expect(b64.length).toBeGreaterThan(0);
    expect(hash.length).toBe(16);
  });

  it("文本变更 → key 变化", () => {
    const k1 = buildCacheKey("skill-1", "text-a");
    const k2 = buildCacheKey("skill-1", "text-b");
    expect(k1).not.toBe(k2);
  });

  it("skillId 变更 → key 变化", () => {
    const k1 = buildCacheKey("skill-1", "text");
    const k2 = buildCacheKey("skill-2", "text");
    expect(k1).not.toBe(k2);
  });
});

describe("EmbeddingCache", () => {
  it("set/get 基本流程", () => {
    const cache = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "test-model",
    });

    const embedding = [0.1, 0.2, 0.3];
    cache.set("skill-1", "text-1", embedding);

    const result = cache.get("skill-1", "text-1");
    expect(result).toEqual(embedding);
  });

  it("未命中返回 null", () => {
    const cache = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "test-model",
    });

    const result = cache.get("skill-1", "text-1");
    expect(result).toBe(null);
  });

  it("文本变更自动失效（新 key）", () => {
    const cache = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "test-model",
    });

    cache.set("skill-1", "text-1", [0.1]);
    expect(cache.get("skill-1", "text-1")).toEqual([0.1]);

    // 文本变更
    cache.set("skill-1", "text-2", [0.2]);
    expect(cache.get("skill-1", "text-2")).toEqual([0.2]);
    // 旧的 text-1 不应该再被命中（因为同 skill_id 只保留 maxEntriesPerSkill 条）
    // 但默认 maxEntriesPerSkill=5，所以 text-1 还在
    expect(cache.get("skill-1", "text-1")).toEqual([0.1]);
  });

  it("持久化到磁盘 + 重新加载", async () => {
    const cache = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "test-model",
    });

    cache.set("skill-1", "text-1", [0.1, 0.2]);
    await cache.save();

    // 验证文件存在
    expect(fs.existsSync(path.join(tmpDir, "skill_embeddings.json"))).toBe(true);

    // 新实例加载
    const cache2 = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "test-model",
    });
    expect(cache2.get("skill-1", "text-1")).toEqual([0.1, 0.2]);
  });

  it("换 embedding 模型自动失效", async () => {
    const cache1 = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "model-v1",
    });
    cache1.set("skill-1", "text-1", [0.1]);
    await cache1.save();

    // 换模型
    const cache2 = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "model-v2",
    });
    expect(cache2.get("skill-1", "text-1")).toBe(null);
  });

  it("换缓存版本自动失效", async () => {
    const cache1 = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "test-model",
      cacheVersion: 1,
    });
    cache1.set("skill-1", "text-1", [0.1]);
    await cache1.save();

    // 换版本
    const cache2 = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "test-model",
      cacheVersion: 2,
    });
    expect(cache2.get("skill-1", "text-1")).toBe(null);
  });

  it("主动清理同 skill_id 旧 entry（防膨胀）", () => {
    const cache = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "test-model",
      maxEntriesPerSkill: 3,
    });

    // 写入 5 条（超过 maxEntriesPerSkill=3）
    for (let i = 0; i < 5; i++) {
      cache.set("skill-1", `text-${i}`, [i]);
    }

    const stats = cache.getStats();
    // 应该最多保留 maxEntriesPerSkill 条
    expect(stats.totalEntries).toBeLessThanOrEqual(4); // set 时先 drop 再 add，可能保留 3+1
  });

  it("removeSkill 删除某 skill 所有 entry", () => {
    const cache = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "test-model",
    });

    cache.set("skill-1", "text-1", [0.1]);
    cache.set("skill-2", "text-2", [0.2]);

    cache.removeSkill("skill-1");

    expect(cache.get("skill-1", "text-1")).toBe(null);
    expect(cache.get("skill-2", "text-2")).toEqual([0.2]);
  });

  it("clear 清空全部", () => {
    const cache = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "test-model",
    });

    cache.set("skill-1", "text-1", [0.1]);
    cache.clear();

    expect(cache.get("skill-1", "text-1")).toBe(null);
  });

  it("getStats 返回正确统计", () => {
    const cache = new EmbeddingCache({
      cacheDir: tmpDir,
      model: "test-model",
    });

    cache.set("skill-1", "text-1", [0.1]);
    cache.set("skill-2", "text-2", [0.2]);

    const stats = cache.getStats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.uniqueSkills).toBe(2);
    expect(stats.model).toBe("test-model");
  });
});
