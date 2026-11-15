import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  stripInlineImages,
  wrapForPaging,
  truncateWebText,
  buildTruncationFooter,
  storeWebText,
  STORED_LINE_WIDTH,
  MAX_STORED_TEXT_CHARS,
} from "../src/tools/web-fetch-truncate";

describe("stripInlineImages", () => {
  it("替换 data:image base64 为 [IMAGE]", () => {
    const text = "before data:image/png;base64,AAAAbbbbCCCC== after";
    expect(stripInlineImages(text)).toBe("before [IMAGE] after");
  });

  it("普通文本不变", () => {
    expect(stripInlineImages("hello world")).toBe("hello world");
  });
});

describe("wrapForPaging", () => {
  it("短文本原样返回", () => {
    expect(wrapForPaging("abc", 10)).toBe("abc");
  });

  it("按宽度折行且不丢字符", () => {
    const text = "x".repeat(25);
    const wrapped = wrapForPaging(text, 10);
    expect(wrapped.split("\n").length).toBe(3);
    expect(wrapped.replace(/\n/g, "").length).toBe(25);
  });

  it("非法宽度回落默认宽度", () => {
    const text = "x".repeat(STORED_LINE_WIDTH + 5);
    const wrapped = wrapForPaging(text, 0);
    expect(wrapped.split("\n").length).toBe(2);
  });
});

describe("truncateWebText", () => {
  it("未超预算 → 原样返回，不截断", () => {
    const r = truncateWebText("short page", 5000);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("short page");
    expect(r.omittedChars).toBe(0);
    expect(r.omittedStartLine).toBeUndefined();
  });

  it("超预算 → head+tail，保留首尾、省略中段", () => {
    const head = "H".repeat(3000);
    const middle = "M".repeat(20000);
    const tail = "T".repeat(3000);
    const text = head + middle + tail;
    const r = truncateWebText(text, 5000);
    expect(r.truncated).toBe(true);
    expect(r.totalChars).toBe(text.length);
    expect(r.text.startsWith("H")).toBe(true);
    expect(r.text.endsWith("T")).toBe(true);
    expect(r.text).toContain("已省略");
    expect(r.omittedChars).toBeGreaterThan(0);
    // 呈现文本（含 marker）不超过预算一个 marker 的合理范围
    expect(r.text.length).toBeLessThanOrEqual(5000 + 10);
  });

  it("省略区间行号基于 STORED_LINE_WIDTH 折行", () => {
    const text = "x".repeat(STORED_LINE_WIDTH * 10);
    const r = truncateWebText(text, 5000);
    expect(r.omittedStartLine).toBeGreaterThanOrEqual(1);
    expect(r.omittedEndLine).toBeGreaterThan(r.omittedStartLine!);
    expect(r.omittedEndLine).toBeLessThanOrEqual(10);
  });

  it("非法 charLimit 回落 5000", () => {
    const r = truncateWebText("x".repeat(6000), NaN);
    expect(r.truncated).toBe(true);
  });
});

describe("buildTruncationFooter", () => {
  it("包含落盘路径与可用的 file_read 调用（offset/limit 一致）", () => {
    const footer = buildTruncationFooter({
      totalChars: 50000,
      shownChars: 5000,
      storedPath: "/tmp/x/abc.txt",
      omittedStartLine: 3,
      omittedEndLine: 24,
    });
    expect(footer).toContain("/tmp/x/abc.txt");
    expect(footer).toContain('file_read path="/tmp/x/abc.txt"');
    expect(footer).toContain("offset=3");
    expect(footer).toContain("limit=22"); // 24-3+1
  });
});

describe("storeWebText", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-webstore-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("落盘并返回路径，内容按宽度折行可回读", () => {
    const text = "a".repeat(STORED_LINE_WIDTH + 123);
    const p = storeWebText(text, "https://example.com/page", dir);
    expect(p).not.toBeNull();
    const onDisk = fs.readFileSync(p!, "utf-8");
    expect(onDisk.replace(/\n/g, "")).toBe(text);
  });

  it("同 URL 幂等（同文件覆盖）", () => {
    const p1 = storeWebText("hello", "https://example.com/a", dir);
    const p2 = storeWebText("world", "https://example.com/a", dir);
    expect(p1).toBe(p2);
    expect(fs.readFileSync(p2!, "utf-8")).toBe("world");
  });

  it("超大文本被截到 MAX_STORED_TEXT_CHARS 上限内", () => {
    const big = "x".repeat(MAX_STORED_TEXT_CHARS + 5000);
    const p = storeWebText(big, "https://example.com/big", dir);
    expect(p).not.toBeNull();
    const onDisk = fs.readFileSync(p!, "utf-8").replace(/\n/g, "");
    expect(onDisk.length).toBe(MAX_STORED_TEXT_CHARS);
  });
});
