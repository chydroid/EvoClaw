import { describe, it, expect } from "vitest";
import {
  serializedMessagesBytes,
  recoverPayloadTooLarge,
  shouldSoftFailUnexplainedRejection,
  clampOutputCap,
  BYTE_SHRINK_RATIO,
  UNEXPLAINED_REJECTION_FRACTION,
  OUTPUT_CAP_MARGIN,
  MAX_COMPRESSION_ATTEMPTS,
  COMPRESSION_EXHAUSTED_NOTICE,
} from "./turn-overflow";

// ═══════════════════════════════════════════════════════════
// 413 / context-overflow 恢复（hermes turn_overflow.py 的 TS 移植）
// ═══════════════════════════════════════════════════════════
describe("常量（hermes 对齐）", () => {
  it("常量值正确", () => {
    expect(BYTE_SHRINK_RATIO).toBe(0.95);
    expect(UNEXPLAINED_REJECTION_FRACTION).toBe(0.5);
    expect(OUTPUT_CAP_MARGIN).toBe(64);
    expect(MAX_COMPRESSION_ATTEMPTS).toBe(3);
    expect(COMPRESSION_EXHAUSTED_NOTICE).toContain("compression exhausted");
  });
});

describe("serializedMessagesBytes", () => {
  it("计算消息列表的序列化字节数", () => {
    const messages = [{ role: "user", content: "hello" }];
    expect(serializedMessagesBytes(messages)).toBe(JSON.stringify(messages).length);
  });

  it("空列表 → 4 字节（[]）", () => {
    expect(serializedMessagesBytes([])).toBe(2);
  });
});

describe("recoverPayloadTooLarge（413 字节打分）", () => {
  it("压缩后字节缩水 ≥5% → retry", () => {
    // 长消息（1000 字符）压缩成短消息（100 字符）→ 缩水 90%
    const longMsg = "x".repeat(1000);
    const messages = [{ role: "user", content: longMsg }];
    const compressFn = () => [{ role: "user", content: "short" }];
    const result = recoverPayloadTooLarge(messages, compressFn);
    expect(result.verdict).toBe("retry");
    expect(result.newMessages).not.toBeNull();
    expect(result.newBytes).toBeLessThan(result.originalBytes * BYTE_SHRINK_RATIO);
  });

  it("压缩后字节几乎不变 → exhausted", () => {
    const messages = [{ role: "user", content: "x".repeat(1000) }];
    // 压缩函数返回几乎相同的内容（只去掉 1 个字符 → 缩水 < 5%）
    const compressFn = () => [{ role: "user", content: "x".repeat(999) }];
    const result = recoverPayloadTooLarge(messages, compressFn, { maxAttempts: 1 });
    expect(result.verdict).toBe("exhausted");
    expect(result.newMessages).toBeNull();
    expect(result.message).toContain("compression exhausted");
  });

  it("压缩函数返回 null → exhausted", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = recoverPayloadTooLarge(messages, () => null);
    expect(result.verdict).toBe("exhausted");
    expect(result.newMessages).toBeNull();
  });

  it("消息数减少也算有进展（即使字节不变）", () => {
    const messages = [
      { role: "user", content: "x".repeat(500) },
      { role: "assistant", content: "y".repeat(500) },
    ];
    // 压缩后去掉一条消息，字节减少但不足 5%（500/1000 = 50% → 实际缩水 50%）
    const compressFn = () => [{ role: "user", content: "x".repeat(500) }];
    const result = recoverPayloadTooLarge(messages, compressFn);
    expect(result.verdict).toBe("retry");
  });
});

describe("shouldSoftFailUnexplainedRejection", () => {
  it("请求远低于窗口（< 50%）→ true", () => {
    expect(shouldSoftFailUnexplainedRejection(1000, 10_000)).toBe(true);
  });

  it("请求接近窗口 → false", () => {
    expect(shouldSoftFailUnexplainedRejection(8000, 10_000)).toBe(false);
  });

  it("contextLength 为 0 → false", () => {
    expect(shouldSoftFailUnexplainedRejection(1000, 0)).toBe(false);
  });
});

describe("clampOutputCap（hermes _clamp_output_cap）", () => {
  it("clamp 到 min(provider, local) - 64", () => {
    // provider 可用 4096，本地可用 = 10000 - 2000 = 8000，min=4096，-64 = 4032
    expect(clampOutputCap(4096, 2000, 10_000)).toBe(4032);
  });

  it("本地可用更小时用本地值", () => {
    // provider 可用 4096，本地可用 = 10000 - 9500 = 500，min=500，-64 = 436
    expect(clampOutputCap(4096, 9500, 10_000)).toBe(436);
  });

  it("本地估计超调时回退到 provider 值", () => {
    // 本地可用 = 10000 - 12000 = -2000（超调）→ 用 provider - 64
    expect(clampOutputCap(4096, 12_000, 10_000)).toBe(4032);
  });

  it("safe_out 至少为 1", () => {
    // provider 可用 10，本地可用 = 100 - 95 = 5，min=5，-64 → max(1, -59) = 1
    expect(clampOutputCap(10, 95, 100)).toBe(1);
  });
});