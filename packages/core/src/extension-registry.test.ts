import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  extractExtensionsFromPackageJson,
  discoverExtensions,
  loadExtension,
  loadExtensions,
  classifyExtension,
} from "../src/extension-registry";

describe("extension-registry", () => {
  describe("extractExtensionsFromPackageJson", () => {
    it("从 evoclaw.extensions 字段提取扩展", () => {
      const pkg = {
        name: "@test/pkg",
        version: "1.0.0",
        evoclaw: { extensions: ["./index.ts", "./extra.ts"] },
      };
      const result = extractExtensionsFromPackageJson(pkg, "/tmp/pkg", "@test/pkg", "1.0.0");
      expect(result).toHaveLength(2);
      expect(result[0].entryPath).toBe("./index.ts");
      expect(result[0].sourceField).toBe("evoclaw.extensions");
      expect(result[1].entryPath).toBe("./extra.ts");
    });

    it("从 openclaw.extensions 字段提取扩展（兼容）", () => {
      const pkg = {
        name: "@test/pkg",
        version: "1.0.0",
        openclaw: { extensions: ["./index.ts"] },
      };
      const result = extractExtensionsFromPackageJson(pkg, "/tmp/pkg", "@test/pkg", "1.0.0");
      expect(result).toHaveLength(1);
      expect(result[0].sourceField).toBe("openclaw.extensions");
    });

    it("两个字段同时存在时合并去重（evoclaw 优先）", () => {
      const pkg = {
        name: "@test/pkg",
        version: "1.0.0",
        evoclaw: { extensions: ["./index.ts"] },
        openclaw: { extensions: ["./index.ts", "./extra.ts"] },
      };
      const result = extractExtensionsFromPackageJson(pkg, "/tmp/pkg", "@test/pkg", "1.0.0");
      // ./index.ts 应只出现一次（evoclaw 优先）
      const indexEntries = result.filter((r) => r.entryPath === "./index.ts");
      expect(indexEntries).toHaveLength(1);
      expect(indexEntries[0].sourceField).toBe("evoclaw.extensions");
      expect(result).toHaveLength(2);
      expect(result[1].entryPath).toBe("./extra.ts");
      expect(result[1].sourceField).toBe("openclaw.extensions");
    });

    it("无 extensions 字段返回空数组", () => {
      expect(extractExtensionsFromPackageJson({ name: "x" }, "/tmp", "x", "1.0.0")).toEqual([]);
    });

    it("extensions 非数组返回空", () => {
      const pkg = { evoclaw: { extensions: "not-an-array" } };
      expect(extractExtensionsFromPackageJson(pkg, "/tmp", "x", "1.0.0")).toEqual([]);
    });

    it("extensions 数组中非字符串元素被忽略", () => {
      const pkg = { evoclaw: { extensions: ["./ok.ts", 123, null, "./also-ok.ts"] } };
      const result = extractExtensionsFromPackageJson(pkg, "/tmp", "x", "1.0.0");
      expect(result).toHaveLength(2);
      expect(result[0].entryPath).toBe("./ok.ts");
      expect(result[1].entryPath).toBe("./also-ok.ts");
    });
  });

  describe("discoverExtensions", () => {
    it("扫描临时目录发现扩展（含 scope 目录）", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-ext-test-"));
      try {
        // 创建普通包：pkg-a
        const pkgADir = path.join(tmp, "pkg-a");
        fs.mkdirSync(pkgADir, { recursive: true });
        fs.writeFileSync(
          path.join(pkgADir, "package.json"),
          JSON.stringify({
            name: "pkg-a",
            version: "1.0.0",
            evoclaw: { extensions: ["./index.ts"] },
          }),
        );
        // 创建 scope 包：@scope/pkg-b
        const scopeDir = path.join(tmp, "@scope");
        const pkgBDir = path.join(scopeDir, "pkg-b");
        fs.mkdirSync(pkgBDir, { recursive: true });
        fs.writeFileSync(
          path.join(pkgBDir, "package.json"),
          JSON.stringify({
            name: "@scope/pkg-b",
            version: "2.0.0",
            openclaw: { extensions: ["./main.ts"] },
          }),
        );
        // 创建无扩展的包：pkg-c
        const pkgCDir = path.join(tmp, "pkg-c");
        fs.mkdirSync(pkgCDir, { recursive: true });
        fs.writeFileSync(
          path.join(pkgCDir, "package.json"),
          JSON.stringify({ name: "pkg-c", version: "1.0.0" }),
        );

        const result = discoverExtensions([tmp]);
        // 排序后顺序：pkg-a < @scope/pkg-b
        expect(result).toHaveLength(2);
        expect(result[0].packageName).toBe("@scope/pkg-b");
        expect(result[0].entryPath).toBe("./main.ts");
        expect(result[1].packageName).toBe("pkg-a");
        expect(result[1].entryPath).toBe("./index.ts");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("不存在的目录返回空数组", () => {
      expect(discoverExtensions(["/nonexistent/path/xyz"])).toEqual([]);
    });

    it("跳过无 package.json 的目录", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-ext-test-"));
      try {
        fs.mkdirSync(path.join(tmp, "no-pkg"), { recursive: true });
        expect(discoverExtensions([tmp])).toEqual([]);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("loadExtension", () => {
    it("动态导入模块并返回默认导出", async () => {
      // 用本仓库已存在的模块测试
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-ext-load-"));
      try {
        const modPath = path.join(tmp, "mod.mjs");
        fs.writeFileSync(modPath, "export default { kind: 'channel', channelId: 'test' };");
        const result = await loadExtension({
          packageName: "test",
          packageVersion: "1.0.0",
          packageDir: tmp,
          entryPath: "./mod.mjs",
          sourceField: "evoclaw.extensions",
        });
        expect(result.entry).toMatchObject({ kind: "channel", channelId: "test" });
        expect(result.loadedInMs).toBeGreaterThanOrEqual(0);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("loadExtensions 失败的扩展不中断流程", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-ext-load-"));
      try {
        const okPath = path.join(tmp, "ok.mjs");
        fs.writeFileSync(okPath, "export default { ok: true };");
        const result = await loadExtensions([
          {
            packageName: "ok",
            packageVersion: "1.0.0",
            packageDir: tmp,
            entryPath: "./ok.mjs",
            sourceField: "evoclaw.extensions",
          },
          {
            packageName: "broken",
            packageVersion: "1.0.0",
            packageDir: tmp,
            entryPath: "./nonexistent.mjs",
            sourceField: "evoclaw.extensions",
          },
        ]);
        expect(result.loaded).toHaveLength(1);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].error).toBeInstanceOf(Error);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("classifyExtension", () => {
    it("channel 字段存在 → channel", () => {
      expect(classifyExtension({ channel: {} })).toBe("channel");
    });
    it("provider 字段存在 → provider", () => {
      expect(classifyExtension({ provider: {} })).toBe("provider");
    });
    it("tools 非空数组 → tool", () => {
      expect(classifyExtension({ tools: [{ name: "x" }] })).toBe("tool");
    });
    it("manifest 存在 → plugin", () => {
      expect(classifyExtension({ manifest: { id: "x" } })).toBe("plugin");
    });
    it("无字段 → unknown", () => {
      expect(classifyExtension({ random: 1 })).toBe("unknown");
    });
    it("非对象 → unknown", () => {
      expect(classifyExtension(null)).toBe("unknown");
      expect(classifyExtension("string")).toBe("unknown");
      expect(classifyExtension(undefined)).toBe("unknown");
    });
    it("tools 空数组 → unknown（非 tool）", () => {
      expect(classifyExtension({ tools: [] })).toBe("unknown");
    });
  });
});
