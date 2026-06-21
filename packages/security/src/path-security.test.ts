import { describe, it, expect } from "vitest";
import * as path from "path";
import * as os from "os";
import {
  hasTraversalComponent,
  validateWithinDir,
  safeJoin,
  hasNullByte,
  sanitizePath,
} from "./path-security";

describe("Path Security", () => {
  const tmpDir = os.tmpdir();

  describe("hasTraversalComponent", () => {
    it("应检测 .. 组件", () => {
      expect(hasTraversalComponent("../etc/passwd")).toBe(true);
      expect(hasTraversalComponent("foo/../../bar")).toBe(true);
      expect(hasTraversalComponent("foo/..\\bar")).toBe(true);
    });

    it("正常路径应返回 false", () => {
      expect(hasTraversalComponent("foo/bar")).toBe(false);
      expect(hasTraversalComponent("/tmp/test")).toBe(false);
      expect(hasTraversalComponent("./foo")).toBe(false);
    });
  });

  describe("validateWithinDir", () => {
    it("正常路径应返回解析后的绝对路径", () => {
      const result = validateWithinDir(tmpDir, "test.txt");
      expect(result).toBe(path.resolve(tmpDir, "test.txt"));
    });

    it("路径逃逸应抛出异常", () => {
      expect(() => validateWithinDir(tmpDir, "../../etc/passwd")).toThrow("Path traversal");
    });

    it("绝对路径在目录内应通过", () => {
      const result = validateWithinDir(tmpDir, path.join(tmpDir, "subdir"));
      expect(result).toBe(path.join(tmpDir, "subdir"));
    });

    it("绝对路径在目录外应抛出", () => {
      expect(() => validateWithinDir(tmpDir, "/etc/passwd")).toThrow("Path traversal");
    });
  });

  describe("safeJoin", () => {
    it("安全路径应返回拼接结果", () => {
      const result = safeJoin(tmpDir, "foo", "bar.txt");
      expect(result).toBe(path.resolve(tmpDir, "foo", "bar.txt"));
    });

    it("逃逸路径应返回 null", () => {
      const result = safeJoin(tmpDir, "..", "..", "etc", "passwd");
      expect(result).toBeNull();
    });
  });

  describe("hasNullByte", () => {
    it("应检测 null 字节", () => {
      expect(hasNullByte("foo\0bar")).toBe(true);
      expect(hasNullByte("normal/path")).toBe(false);
    });
  });

  describe("sanitizePath", () => {
    it("正常路径应返回解析后的路径", () => {
      const result = sanitizePath(tmpDir, "test.txt");
      expect(result).toBe(path.resolve(tmpDir, "test.txt"));
    });

    it("null 字节路径应返回 null", () => {
      const result = sanitizePath(tmpDir, "foo\0bar");
      expect(result).toBeNull();
    });

    it("逃逸路径应返回 null", () => {
      const result = sanitizePath(tmpDir, "../../etc/passwd");
      expect(result).toBeNull();
    });

    it("目录内遍历路径应返回解析后的路径", () => {
      const result = sanitizePath(tmpDir, "foo/../bar");
      expect(result).toBe(path.resolve(tmpDir, "bar"));
    });
  });
});
