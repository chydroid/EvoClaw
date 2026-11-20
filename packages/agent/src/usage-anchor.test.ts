import { describe, it, expect } from "vitest";
import {
  captureUsageAnchor,
  anchoredContextTokens,
  anchorMatches,
  messageFingerprint,
  type UsageAnchor,
} from "./usage-anchor";
import type { SessionHistoryEntry } from "./session-persistence";

/** 造一条持久 history 条目（原始消息，P0-9 语义）。 */
const h = (role: string, content: string, extra?: Partial<SessionHistoryEntry>): SessionHistoryEntry => ({
  role,
  content,
  ...extra,
});

describe("messageFingerprint — 内容寻址稳定指纹", () => {
  it("同内容同指纹（对象身份无关，跨轮成立）", () => {
    const a = h("user", "hello");
    const b = h("user", "hello");
    expect(messageFingerprint(a)).toBe(messageFingerprint(b));
    expect(messageFingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("内容或角色变化 → 指纹变化", () => {
    expect(messageFingerprint(h("user", "a"))).not.toBe(messageFingerprint(h("user", "b")));
    expect(messageFingerprint(h("user", "x"))).not.toBe(messageFingerprint(h("assistant", "x")));
  });

  it("tool_calls / tool_call_id / name 进指纹（对齐 hermes _FINGERPRINT_KEYS）", () => {
    const withTools = h("assistant", "", { tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] });
    const withToolsDiff = h("assistant", "", { tool_calls: [{ id: "t2", type: "function", function: { name: "f", arguments: "{}" } }] });
    expect(messageFingerprint(withTools)).not.toBe(messageFingerprint(withToolsDiff));
    expect(messageFingerprint(h("tool", "r", { tool_call_id: "t1" }))).not.toBe(
      messageFingerprint(h("tool", "r", { tool_call_id: "t9" })),
    );
  });

  it("null/undefined/非对象 → null（不抛）", () => {
    expect(messageFingerprint(null)).toBeNull();
    expect(messageFingerprint(undefined)).toBeNull();
    expect(messageFingerprint(42)).toBeNull();
  });
});

describe("captureUsageAnchor — 捕获", () => {
  it("有效 usage + 非空 history → 锚（baseCount = history.length）", () => {
    const history = [h("user", "u1"), h("assistant", "a1")];
    const anchor = captureUsageAnchor(5000, 300, history);
    expect(anchor).not.toBeNull();
    expect(anchor!.promptTokens).toBe(5000);
    expect(anchor!.completionTokens).toBe(300);
    expect(anchor!.baseCount).toBe(2);
    expect(anchor!.basePrefixFp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("promptTokens <= 0（部分 endpoint 不报 usage）→ null，保留旧锚", () => {
    const history = [h("user", "u1")];
    expect(captureUsageAnchor(0, 100, history)).toBeNull();
    expect(captureUsageAnchor(undefined, 100, history)).toBeNull();
    expect(captureUsageAnchor("abc", 100, history)).toBeNull();
    expect(captureUsageAnchor(-5, 100, history)).toBeNull();
  });

  it("空 history → null（首回合无绑定意义）", () => {
    expect(captureUsageAnchor(5000, 100, [])).toBeNull();
  });

  it("负 completion 钳为 0；字符串数字可解析", () => {
    const history = [h("user", "u")];
    const a = captureUsageAnchor(1000, -50, history);
    expect(a!.completionTokens).toBe(0);
    const b = captureUsageAnchor("1000", 100, history);
    expect(b!.promptTokens).toBe(1000);
  });
});

describe("anchoredContextTokens — 消费与 fail-closed", () => {
  const makeAnchor = (history: SessionHistoryEntry[], pt = 5000, ct = 300): UsageAnchor =>
    captureUsageAnchor(pt, ct, history)!;

  it("回合后追加 [user, assistant] 对 → 仍有效，对不重复计（delta 跳过规则）", () => {
    const captured = [h("user", "u1"), h("assistant", "a1")];
    const anchor = makeAnchor(captured);
    // 回合结束：history 追加本回合 [user, assistant]（原始消息字节一致）
    const afterTurn = [...captured, h("user", "u2"), h("assistant", "a2")];
    const tokens = anchoredContextTokens(afterTurn, anchor);
    expect(tokens).toBe(5000 + 300); // delta ≤ 2 全跳过
  });

  it("对之后又追加一轮 → 只粗估多出的条目", () => {
    const captured = [h("user", "u1"), h("assistant", "a1")];
    const anchor = makeAnchor(captured);
    const afterTwoTurns = [...captured, h("user", "u2"), h("assistant", "a2"), h("user", "next question")];
    const tokens = anchoredContextTokens(afterTwoTurns, anchor)!;
    const roughExtra = Math.ceil("next question".length * 0.25) + 4;
    expect(tokens).toBe(5000 + 300 + roughExtra);
  });

  it("历史前缀被改写（剪枝/压缩）→ 指纹失配 → null（fail-closed）", () => {
    const captured = [h("user", "u1"), h("assistant", "a1")];
    const anchor = makeAnchor(captured);
    // 中间条目被剪枝替换（字节变化）
    const rewritten = [h("user", "[pruned]"), h("assistant", "a1"), h("user", "u2"), h("assistant", "a2")];
    expect(anchoredContextTokens(rewritten, anchor)).toBeNull();
    expect(anchorMatches(rewritten, anchor)).toBe(false);
  });

  it("history 变短（截断/splice）→ 失配 null", () => {
    const captured = [h("user", "u1"), h("assistant", "a1")];
    const anchor = makeAnchor(captured);
    expect(anchoredContextTokens([h("user", "u1")], anchor)).toBeNull();
  });

  it("锚为 null/undefined → null（无锚调用方回退全量估算）", () => {
    const history = [h("user", "u1")];
    expect(anchoredContextTokens(history, null)).toBeNull();
    expect(anchoredContextTokens(history, undefined)).toBeNull();
  });

  it("回合后仅追加 assistant（残缺 delta）→ 跳过，仍有效", () => {
    const captured = [h("user", "u1"), h("assistant", "a1")];
    const anchor = makeAnchor(captured);
    const after = [...captured, h("assistant", "partial")];
    expect(anchoredContextTokens(after, anchor)).toBe(5000 + 300);
  });
});
