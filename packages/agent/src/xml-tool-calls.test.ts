/**
 * XML 工具调用解析回归测试。
 *
 * v34 复盘：旧实现把 id 生成写在解析循环里（每轮 `callIdx = 0`），同一回合
 * 内反复产出 `parsed_invoke_0`。OpenAI 协议要求 tool_call_id 唯一，且
 * `pruneUnpairedToolMessages` 按 id 配对 assistant(tool_calls) 与 tool 结果——
 * 重复 id 会让跨轮的 tool 结果配错调用。
 */
import { describe, it, expect } from "vitest";
import { parseXmlToolCalls } from "./xml-tool-calls";

const seqIds = () => {
  const seen = new Map<string, number>();
  return (kind: string) => {
    const n = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, n);
    return `${kind}-${n}`;
  };
};

describe("parseXmlToolCalls", () => {
  it("<invoke> 形态：参数能 JSON 解析就解析，否则保留字符串", () => {
    const calls = parseXmlToolCalls(
      `<invoke name="write_file"><parameter name="path">a.ts</parameter>` +
        `<parameter name="lines">42</parameter>` +
        `<parameter name="flag">true</parameter></invoke>`,
      seqIds(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("write_file");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      path: "a.ts",
      lines: 42,
      flag: true,
    });
  });

  it("多个 <invoke> 各自一条，参数互不串味", () => {
    const calls = parseXmlToolCalls(
      `<invoke name="a"><parameter name="x">1</parameter></invoke>` +
        `<invoke name="b"><parameter name="y">2</parameter></invoke>`,
      seqIds(),
    );
    expect(calls.map((c) => c.function.name)).toEqual(["a", "b"]);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ x: 1 });
    expect(JSON.parse(calls[1].function.arguments)).toEqual({ y: 2 });
  });

  it("<minimax:tool_call> 的 JSON 参数被原样保留", () => {
    const calls = parseXmlToolCalls(
      `<minimax:tool_call><function_name>run</function_name>` +
        `<parameters>{"cmd":"ls -la","timeout":5}</parameters></minimax:tool_call>`,
      seqIds(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("run");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ cmd: "ls -la", timeout: 5 });
  });

  it("<minimax:tool_call> 的非 JSON 参数退回 XML 形态", () => {
    const calls = parseXmlToolCalls(
      `<minimax:tool_call><function_name>run</function_name>` +
        `<parameters><parameter name="cmd">ls</parameter></parameters></minimax:tool_call>`,
      seqIds(),
    );
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ cmd: "ls" });
  });

  it("两种形态混排时顺序稳定（invoke 先，minimax 后）", () => {
    const calls = parseXmlToolCalls(
      `<minimax:tool_call><function_name>m</function_name><parameters>{}</parameters></minimax:tool_call>` +
        `<invoke name="i"><parameter name="k">v</parameter></invoke>`,
      seqIds(),
    );
    expect(calls.map((c) => c.function.name)).toEqual(["i", "m"]);
  });

  it("无 XML 调用时返回空数组", () => {
    expect(parseXmlToolCalls("普通文本，没有工具调用", seqIds())).toEqual([]);
    expect(parseXmlToolCalls("", seqIds())).toEqual([]);
  });

  it("id 由注入的生成器发放，跨轮不重复", () => {
    // 模拟两轮解析共用同一个回合级计数器（生产里是 parsedCallSeq）
    let seq = 0;
    const nextId = (kind: string) => `parsed_${kind}_${seq++}`;
    const round1 = parseXmlToolCalls(`<invoke name="a"><parameter name="x">1</parameter></invoke>`, nextId);
    const round2 = parseXmlToolCalls(`<invoke name="a"><parameter name="x">1</parameter></invoke>`, nextId);
    expect(round1[0].id).not.toBe(round2[0].id);
    // 每轮内部的 id 也必须唯一
    const two = parseXmlToolCalls(
      `<invoke name="a"><parameter name="x">1</parameter></invoke>` +
        `<invoke name="b"><parameter name="y">2</parameter></invoke>`,
      nextId,
    );
    expect(new Set(two.map((c) => c.id)).size).toBe(2);
  });
});
