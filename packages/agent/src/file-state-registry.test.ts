import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FileStateRegistry, assertNotStale } from "./file-state-registry";

describe("FileStateRegistry", () => {
  let tmpDir: string;
  let registry: FileStateRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-test-"));
    FileStateRegistry.resetInstance();
    registry = FileStateRegistry.getInstance();
    registry.clearAll();
  });

  afterEach(() => {
    registry.clearAll();
    FileStateRegistry.resetInstance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hashContent 应返回 sha256 前 16 字符", () => {
    const hash = FileStateRegistry.hashContent("test");
    expect(hash).toHaveLength(16);
    // 相同输入应产生相同 hash
    expect(FileStateRegistry.hashContent("test")).toBe(hash);
  });

  it("不同内容应产生不同 hash", () => {
    expect(FileStateRegistry.hashContent("a")).not.toBe(FileStateRegistry.hashContent("b"));
  });

  it("recordRead 应记录读取状态", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "content-v1");
    registry.recordRead("agent-A", filePath);
    expect(registry.getVersion(filePath)).toBe(1);
    expect(registry.listTrackedFiles()).toContain(path.resolve(filePath));
  });

  it("checkStale 无记录时应返回 not stale", () => {
    const filePath = path.join(tmpDir, "test.txt");
    const result = registry.checkStale("agent-A", filePath);
    expect(result.stale).toBe(false);
  });

  it("recordWrite 应递增版本号", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "content-v1");
    registry.recordRead("agent-A", filePath);
    expect(registry.getVersion(filePath)).toBe(1);
    registry.recordWrite("agent-B", filePath, "content-v2");
    expect(registry.getVersion(filePath)).toBe(2);
  });

  it("recordWrite 后其他 agent 的 checkStale 应检测到 version 过时", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "content-v1");
    registry.recordRead("agent-A", filePath);
    fs.writeFileSync(filePath, "content-v2");
    registry.recordWrite("agent-B", filePath, "content-v2");

    const stale = registry.checkStale("agent-A", filePath);
    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe("version");
  });

  it("F5.1 回归：recordRead 不应修改 state.mtime/hash", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "content-v1");
    const hash1 = FileStateRegistry.hashContent("content-v1");

    // Agent A 读取
    registry.recordRead("agent-A", filePath);
    expect(registry.getVersion(filePath)).toBe(1);

    // 外部修改（非 recordWrite）
    fs.writeFileSync(filePath, "content-v2");

    // Agent B 读取 — recordRead 不应修改 state.hash
    registry.recordRead("agent-B", filePath);

    // state.version 应仍为 1（recordRead 不递增版本）
    expect(registry.getVersion(filePath)).toBe(1);

    // Agent A 的 checkStale 应检测到过时
    const stale = registry.checkStale("agent-A", filePath);
    expect(stale.stale).toBe(true);
    expect(["mtime", "hash"]).toContain(stale.reason);

    // Agent A 的 stamp hash 应仍为原始 hash
    expect(stale.lastRead?.hash).toBe(hash1);
  });

  it("F5.1 回归：禁用 mtime 检测后，hash 检测仍应工作", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "content-v1");
    const hash1 = FileStateRegistry.hashContent("content-v1");

    registry.setMtimeCheckEnabled(false);
    registry.recordRead("agent-A", filePath);

    // 外部修改
    fs.writeFileSync(filePath, "content-v2");
    registry.recordRead("agent-B", filePath);

    const stale = registry.checkStale("agent-A", filePath);
    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe("hash");
    expect(stale.lastRead?.hash).toBe(hash1);
    expect(stale.currentHash).not.toBe(hash1);

    registry.setMtimeCheckEnabled(true);
  });

  it("文件被删除后 checkStale 应检测到 removed", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "content-v1");
    registry.recordRead("agent-A", filePath);
    fs.unlinkSync(filePath);

    const stale = registry.checkStale("agent-A", filePath);
    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe("removed");
  });

  it("clearAgent 应清除指定 agent 的读取记录", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "content-v1");
    registry.recordRead("agent-A", filePath);
    registry.recordRead("agent-B", filePath);

    const cleared = registry.clearAgent("agent-A");
    expect(cleared).toBe(1);

    // Agent A 无记录后 checkStale 应返回 not stale
    expect(registry.checkStale("agent-A", filePath).stale).toBe(false);
  });

  it("clearFile 应清除指定文件的状态", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "content-v1");
    registry.recordRead("agent-A", filePath);
    expect(registry.clearFile(filePath)).toBe(true);
    expect(registry.listTrackedFiles()).not.toContain(path.resolve(filePath));
  });
});

describe("assertNotStale", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsr-assert-"));
    FileStateRegistry.resetInstance();
    FileStateRegistry.getInstance().clearAll();
  });

  afterEach(() => {
    FileStateRegistry.getInstance().clearAll();
    FileStateRegistry.resetInstance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("未过时时不应抛出", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "content");
    FileStateRegistry.getInstance().recordRead("agent-A", filePath);
    expect(() => assertNotStale("agent-A", filePath)).not.toThrow();
  });

  it("过时应抛出 FileStaleError", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "content-v1");
    FileStateRegistry.getInstance().recordRead("agent-A", filePath);
    fs.writeFileSync(filePath, "content-v2");
    FileStateRegistry.getInstance().recordWrite("agent-B", filePath, "content-v2");

    expect(() => assertNotStale("agent-A", filePath)).toThrow(/FileStaleError/);
  });
});
