import { describe, it, expect } from "vitest";
import {
  isRepetitionDominated,
  isRunawayRepetition,
  RunawayStreamWatch,
  REPETITION_LOOP_INTERRUPTED,
  MIN_FRAGMENT_LENGTH,
  STOP_PATH_MIN_CHARS,
  STREAM_TAIL_CHARS,
} from "./repetition-guard";

// ═══════════════════════════════════════════════════════════
// 模型输出重复检测（hermes repetition_guard.py 的 TS 移植）
// ═══════════════════════════════════════════════════════════
describe("isRepetitionDominated", () => {
  it("常量与 hermes 对齐", () => {
    expect(MIN_FRAGMENT_LENGTH).toBe(400);
    expect(STOP_PATH_MIN_CHARS).toBe(16_000);
    expect(STREAM_TAIL_CHARS).toBe(64_000);
    expect(REPETITION_LOOP_INTERRUPTED).toContain("重复循环");
  });

  it("短文本 fail-open（< 400 字符）", () => {
    expect(isRepetitionDominated("hello world\n".repeat(10))).toBe(false);
  });

  it("单行重复主导 → true（echo 形态）", () => {
    // "hello world\n" 重复 100 次 = 1200 字符，单行覆盖 1100 > 600
    const text = "hello world\n".repeat(100);
    expect(text.length).toBeGreaterThanOrEqual(MIN_FRAGMENT_LENGTH);
    expect(isRepetitionDominated(text)).toBe(true);
  });

  it("单字符填充 → true（60 字符窗口计数）", () => {
    const text = "a".repeat(500);
    expect(isRepetitionDominated(text)).toBe(true);
  });

  it("正常文本 → false", () => {
    // 用递增计数器生成真正多样的文本（每行/每个 60 字符窗口都不同）
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`item_${String(i).padStart(6, "0")}: the quick brown fox jumps over the lazy dog ${i}`);
    }
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThanOrEqual(MIN_FRAGMENT_LENGTH);
    expect(isRepetitionDominated(text)).toBe(false);
  });

  it("非字符串输入 → false", () => {
    expect(isRepetitionDominated(null as unknown as string)).toBe(false);
    expect(isRepetitionDominated(undefined as unknown as string)).toBe(false);
  });
});

describe("isRunawayRepetition", () => {
  it("比 isRepetitionDominated 更严格：重复但不同行多 → false（不误伤批量输出）", () => {
    // 每行不同（row_1..row_N），但 60 字符窗口可能重复——
    // 这里构造一个「重复占优但不同行过半」的文本：
    // 用同一前缀 + 不同数字，使窗口计数达标但不同行 > 一半
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`row_${i}: the quick brown fox jumps over the lazy dog`);
    }
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThanOrEqual(MIN_FRAGMENT_LENGTH);
    // isRepetitionDominated 可能为 true（60 字符窗口重复），
    // 但 isRunawayRepetition 必须为 false（200 行全部不同）
    expect(isRunawayRepetition(text)).toBe(false);
  });

  it("单行循环 → true（无行结构可判）", () => {
    const text = "hello world\n".repeat(100);
    expect(isRunawayRepetition(text)).toBe(true);
  });

  it("不重复 → false", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`item_${String(i).padStart(6, "0")}: the quick brown fox jumps over the lazy dog ${i}`);
    }
    const text = lines.join("\n");
    expect(isRunawayRepetition(text)).toBe(false);
  });
});

describe("RunawayStreamWatch", () => {
  it("未达到 STOP_PATH_MIN_CHARS 前不检查", () => {
    const watch = new RunawayStreamWatch();
    // 喂 15k 字符（< 16k）→ 不检查
    const delta = "hello world\n".repeat(1000); // ~12000 chars
    expect(watch.feed(delta)).toBe(false);
    expect(watch.getChars()).toBe(12000);
  });

  it("达到 STOP_PATH_MIN_CHARS 后检查，runaway 判 true", () => {
    const watch = new RunawayStreamWatch();
    // 第一段：>16k 的**多样**文本（递增计数器，不 runaway）
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(`item_${String(i).padStart(6, "0")}: the quick brown fox jumps over the lazy dog ${i}`);
    }
    const normal = lines.join("\n");
    expect(normal.length).toBeGreaterThan(STOP_PATH_MIN_CHARS);
    expect(watch.feed(normal)).toBe(false);
    // 第二段：runaway 文本（单行重复主导）
    const runaway = "hello world\n".repeat(2000); // ~24000 chars
    expect(watch.feed(runaway)).toBe(true);
  });

  it("reset 后重新开始", () => {
    const watch = new RunawayStreamWatch();
    const runaway = "hello world\n".repeat(2000);
    expect(watch.feed(runaway)).toBe(true);
    watch.reset();
    expect(watch.getChars()).toBe(0);
    // reset 后再喂多样文本不应判 runaway
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(`item_${String(i).padStart(6, "0")}: the quick brown fox jumps over the lazy dog ${i}`);
    }
    const normal = lines.join("\n");
    expect(watch.feed(normal)).toBe(false);
  });
});