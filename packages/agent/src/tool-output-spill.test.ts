/**
 * tool-output-spill 行为测试：头尾截断 + spill 落盘 + 幂等守卫。
 * 背景：2026-11-05 事故（sess_mw2axgpv）——代码输出被 stripWebNoise 腐蚀导致任务失败，
 * 修复为 Hermes 式「保真 + 头 40%/尾 60% 截断 + spill 文件 + 单一幂等标记」。
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isTruncatedOrSpilled,
  sanitizeExecResult,
  truncationNotice,
  truncateHeadTail,
} from "./tool-output-spill";

describe("truncateHeadTail", () => {
  it("returns input unchanged when within budget", () => {
    const text = "a".repeat(100);
    expect(truncateHeadTail(text, 100)).toBe(text);
  });

  it("truncates head 40% / tail 60% and embeds the fixed marker", () => {
    const text = "H".repeat(200) + "T".repeat(300); // 500 total
    const out = truncateHeadTail(text, 100);
    expect(out).toContain("[OUTPUT TRUNCATED -");
    const head = out.slice(0, 40);
    const tail = out.slice(out.length - 60);
    expect(head).toBe("H".repeat(40));
    expect(tail).toBe("T".repeat(60));
    // 标记中字符数与总量一致
    expect(out).toContain("[OUTPUT TRUNCATED - 400 chars omitted out of 500 total]");
  });

  it("is idempotent: already-truncated content passes through verbatim", () => {
    const first = truncateHeadTail("X".repeat(400), 100);
    const second = truncateHeadTail(first, 100);
    expect(second).toBe(first);
  });

  it("does not truncate content carrying a spill path marker", () => {
    const withMarker = JSON.stringify({
      output: "Y".repeat(400),
      full_output_path: "/tmp/spill.log",
    });
    expect(truncateHeadTail(withMarker, 100)).toBe(withMarker);
  });
});

describe("truncationNotice", () => {
  it("is a single fixed-shape marker (downstream recognizes one form)", () => {
    const n = truncationNotice(10, 50);
    expect(n).toContain("[OUTPUT TRUNCATED - 10 chars omitted out of 50 total]");
  });
});

describe("isTruncatedOrSpilled", () => {
  it("detects truncation marker or spill field", () => {
    expect(isTruncatedOrSpilled("[OUTPUT TRUNCATED - 1 chars omitted out of 2 total]")).toBe(true);
    expect(isTruncatedOrSpilled(JSON.stringify({ full_output_path: "/x" }))).toBe(true);
    expect(isTruncatedOrSpilled("plain text")).toBe(false);
  });
});

describe("sanitizeExecResult", () => {
  let tmpWorkspace: string;
  let spilledFiles: string[];

  afterEach(() => {
    for (const f of spilledFiles) fs.rmSync(f, { force: true });
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  function makeWorkspace(): string {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "spill-test-"));
    spilledFiles = [];
    return tmpWorkspace;
  }

  it("leaves short output untouched (no spill, no truncation)", () => {
    const result = { success: true, output: "hello", exitCode: 0 };
    const out = sanitizeExecResult(makeWorkspace(), "call-1", result, 48000);
    expect(out.output).toBe("hello");
    expect(out).not.toHaveProperty("full_output_path");
    expect(out).not.toHaveProperty("truncation_note");
  });

  it("spills full output and attaches head/tail-truncated view for long output", () => {
    const ws = makeWorkspace();
    const full = "A".repeat(100000);
    const out = sanitizeExecResult(ws, "call-2", { success: true, output: full, exitCode: 0 }, 48000);
    const next = out as { output: string; full_output_path?: string; truncation_note?: string };
    expect(next.output.length).toBeLessThan(full.length);
    expect(next.output).toContain("[OUTPUT TRUNCATED -");
    expect(next.full_output_path).toBeTruthy();
    expect(next.truncation_note).toContain("read it with file_read");
    // 原文完整落盘（字节级保真——事故后不再做任何「内容整形」）
    const onDisk = fs.readFileSync(next.full_output_path as string, "utf8");
    expect(onDisk).toBe(full);
    spilledFiles = fs.readdirSync(path.join(ws, "tool-spill")).map((f) => path.join(ws, "tool-spill", f));
  });

  it("does not mutate the input object", () => {
    const ws = makeWorkspace();
    const input = { success: true, output: "B".repeat(100000), exitCode: 0 };
    const out = sanitizeExecResult(ws, "call-3", input, 48000);
    expect(out).not.toBe(input);
    expect(input.output.length).toBe(100000);
    expect(input).not.toHaveProperty("full_output_path");
  });
});
