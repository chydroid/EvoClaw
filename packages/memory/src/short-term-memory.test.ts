import { describe, it, expect } from "vitest";
import { ShortTermMemoryStore } from "./short-term-memory";

describe("ShortTermMemoryStore", () => {
  it("should set and get values", async () => {
    const store = new ShortTermMemoryStore();

    await store.set("testKey", { value: 42 });
    const result = await store.get<{ value: number }>("testKey");

    expect(result).toEqual({ value: 42 });
  });

  it("should return null for missing keys", async () => {
    const store = new ShortTermMemoryStore();
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  it("should handle TTL expiration", async () => {
    const store = new ShortTermMemoryStore();

    await store.set("ephemeral", "data", 1);
    const before = await store.get("ephemeral");
    expect(before).toBe("data");

    await new Promise((resolve) => setTimeout(resolve, 10));
    const after = await store.get("ephemeral");
    expect(after).toBeNull();
  });

  it("should support key pattern matching", async () => {
    const store = new ShortTermMemoryStore();

    await store.set("session:123", {});
    await store.set("session:456", {});
    await store.set("cache:789", {});

    const sessionKeys = await store.keys("session:*");
    expect(sessionKeys).toHaveLength(2);
    expect(sessionKeys).toContain("session:123");
    expect(sessionKeys).toContain("session:456");
  });

  it("should delete keys", async () => {
    const store = new ShortTermMemoryStore();
    await store.set("deleteMe", "value");
    expect(await store.exists("deleteMe")).toBe(true);

    await store.delete("deleteMe");
    expect(await store.exists("deleteMe")).toBe(false);
  });

  it("should clear all keys", async () => {
    const store = new ShortTermMemoryStore();
    await store.set("a", 1);
    await store.set("b", 2);

    await store.clear();

    expect(await store.exists("a")).toBe(false);
    expect(await store.exists("b")).toBe(false);
  });
});