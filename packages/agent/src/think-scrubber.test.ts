import { describe, it, expect, beforeEach } from "vitest";
import { StreamingThinkScrubber, stripThinkBlocks } from "./think-scrubber";

describe("stripThinkBlocks", () => {
  it("应剥离 <think> 块保留可见文本", () => {
    const result = stripThinkBlocks("<think>secret</think>visible");
    expect(result).toBe("visible");
  });

  it("应支持 5 种 think-tag 变体", () => {
    const variants = [
      "<think>",
      "<thinking>",
      "<thought>",
      "<reasoning>",
      "<REASONING_SCRATCHPAD>",
    ];
    for (const tag of variants) {
      const closeTag = tag.replace("<", "</");
      const input = `${tag}internal reasoning${closeTag}visible output`;
      const result = stripThinkBlocks(input);
      expect(result).toBe("visible output");
    }
  });

  it("大小写不敏感匹配", () => {
    const result = stripThinkBlocks("<THINK>secret</THINK>visible");
    expect(result).toBe("visible");
  });

  it("无 think 块时应原样返回", () => {
    expect(stripThinkBlocks("just plain text")).toBe("just plain text");
  });

  it("空字符串应返回空字符串", () => {
    expect(stripThinkBlocks("")).toBe("");
  });

  it("应处理多个 think 块", () => {
    const result = stripThinkBlocks("<think>a</think>visible1<think>b</think>visible2");
    expect(result).toBe("visible1visible2");
  });
});

describe("StreamingThinkScrubber", () => {
  let scrubber: StreamingThinkScrubber;

  beforeEach(() => {
    scrubber = new StreamingThinkScrubber();
  });

  it("完整 chunk 应剥离 think 块", () => {
    expect(scrubber.feed("<think>secret</think>visible")).toBe("visible");
  });

  it("跨 chunk 边界的 think 块应被正确剥离", () => {
    // 分多次投喂："<think>" 跨边界
    const c1 = scrubber.feed("<thi");
    const c2 = scrubber.feed("nk>secret</think>visible");
    expect(c1).toBe("");
    expect(c2).toBe("visible");
  });

  it("闭合对跨 chunk 应被完整剥离", () => {
    const c1 = scrubber.feed("<think>sec");
    expect(c1).toBe("");
    const c2 = scrubber.feed("ret</think>hello");
    expect(c2).toBe("hello");
  });

  it("可见文本应在 feed 时输出", () => {
    const result = scrubber.feed("hello world");
    expect(result).toBe("hello world");
  });

  it("flush 应输出暂存的非 tag 尾巴", () => {
    // "<thin" 是 "<think>" 的前缀 → feed 暂存（可能是开 tag 跨 chunk），
    // flush 时确认不是真实 tag → 按原样释放。
    scrubber.feed("<thin");
    expect(scrubber.flush()).toBe("<thin");
  });

  it("flush 在未闭合块内应丢弃暂存内容", () => {
    scrubber.feed("<think>some reasoning");
    expect(scrubber.flush()).toBe("");
  });

  it("reset 应清除状态", () => {
    scrubber.feed("<think>secret");
    scrubber.reset();
    expect(scrubber.feed("visible")).toBe("visible");
  });

  it("块边界的未闭合开 tag 应被识别（行首）", () => {
    // 开 tag 必须在行首/空白行后才被识别为推理块
    const c1 = scrubber.feed("line1\n");
    expect(c1).toBe("line1\n");
    const c2 = scrubber.feed("<think>secret</think>line2");
    expect(c2).toBe("line2");
  });

  it("空 feed 应返回空字符串", () => {
    expect(scrubber.feed("")).toBe("");
  });

  it("应处理 thinking 变体的流式剥离", () => {
    const c1 = scrubber.feed("<thinki");
    expect(c1).toBe("");
    const c2 = scrubber.feed("ng>hidden</thinking>shown");
    expect(c2).toBe("shown");
  });
});
