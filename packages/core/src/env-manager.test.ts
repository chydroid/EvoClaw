import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EnvManager } from "./env-manager";

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
  storePath = path.join(tmpDir, "env.json");
  // 隔离 process.env，避免污染其他测试
  const saved = { ...process.env };
  (globalThis as { __envBackup?: NodeJS.ProcessEnv }).__envBackup = saved;
});
afterEach(() => {
  const backup = (globalThis as { __envBackup?: NodeJS.ProcessEnv }).__envBackup;
  if (backup) {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, backup);
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

describe("EnvManager", () => {
  it("list 初始为空", () => {
    const em = new EnvManager(storePath);
    expect(em.list()).toEqual([]);
  });

  it("set 写入并同步 process.env", () => {
    const em = new EnvManager(storePath);
    const entry = em.set("MY_TEST_VAR", "hello");
    expect(entry.key).toBe("MY_TEST_VAR");
    expect(entry.value).toBe("hello");
    expect(entry.source).toBe("api");
    expect(process.env.MY_TEST_VAR).toBe("hello");
    expect(em.get("MY_TEST_VAR")?.value).toBe("hello");
  });

  it("保护 key 不允许经 API 修改", () => {
    const em = new EnvManager(storePath);
    expect(() => em.set("WEB_UI_TOKEN", "x")).toThrow("protected");
    expect(() => em.set("EvoClaw_PORT", "1234")).toThrow("protected");
    expect(em.list().length).toBe(0);
  });

  it("delete 删除并清除 process.env", () => {
    const em = new EnvManager(storePath);
    em.set("MY_TEST_VAR", "hello");
    expect(em.delete("MY_TEST_VAR")).toBe(true);
    expect(em.get("MY_TEST_VAR")).toBeNull();
    expect(process.env.MY_TEST_VAR).toBeUndefined();
  });

  it("delete 不存在的 key 返回 false", () => {
    const em = new EnvManager(storePath);
    expect(em.delete("NOPE")).toBe(false);
  });

  it("delete 保护 key 抛错", () => {
    const em = new EnvManager(storePath);
    expect(() => em.delete("NODE_ENV")).toThrow("protected");
  });

  it("持久化：重启后恢复", () => {
    const em = new EnvManager(storePath);
    em.set("A", "1");
    em.set("B", "2");
    const em2 = new EnvManager(storePath);
    const keys = em2.list().map((e) => e.key);
    expect(keys).toEqual(expect.arrayContaining(["A", "B"]));
    expect(process.env.A).toBe("1");
    expect(process.env.B).toBe("2");
  });

  it("存储文件损坏时回落空", () => {
    fs.writeFileSync(storePath, "{ bad json");
    const em = new EnvManager(storePath);
    expect(em.list()).toEqual([]);
  });
});