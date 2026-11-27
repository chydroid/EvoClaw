import { describe, it, expect } from "vitest";
import {
  sanitizeApiMessages,
  coerceToolName,
  repairToolCallArguments,
  rebalanceJsonClosers,
  INTERRUPTED_PLACEHOLDER,
  UNAVAILABLE_RESULT_PLACEHOLDER,
  type SanitizableMessage,
} from "./api-message-sanitizer";

// ═══════════════════════════════════════════════════════════
// api-message-sanitizer（对标 hermes sanitize_api_messages）
// 覆盖：八道 pass 的修复行为 + 「无改动返回原引用」（前缀缓存安全）
// ═══════════════════════════════════════════════════════════

const user = (content?: unknown): SanitizableMessage =>
  content === undefined ? { role: "user" } : { role: "user", content };
const assistant = (content: unknown, toolCalls?: unknown): SanitizableMessage =>
  toolCalls === undefined
    ? { role: "assistant", content }
    : { role: "assistant", content, tool_calls: toolCalls };
const tool = (id: string, content = "ok", name?: string): SanitizableMessage =>
  name === undefined
    ? { role: "tool", tool_call_id: id, content }
    : { role: "tool", tool_call_id: id, content, name };
const call = (id: string, name = "shell_exec", args: unknown = "{}") => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

describe("sanitizeApiMessages > 缓存安全", () => {
  it("干净消息返回原数组引用（不复制）", () => {
    const messages: SanitizableMessage[] = [
      { role: "system", content: "sys" },
      user("hi"),
      assistant(null, [call("c1")]),
      tool("c1"),
    ];
    expect(sanitizeApiMessages(messages)).toBe(messages);
  });

  it("空数组返回原引用", () => {
    const messages: SanitizableMessage[] = [];
    expect(sanitizeApiMessages(messages)).toBe(messages);
  });

  it("只有被改的消息是新对象，未改消息保持引用", () => {
    const good = user("keep me");
    const bad = user(null);
    const out = sanitizeApiMessages([good, bad]);
    expect(out).not.toBe([good, bad]);
    expect(out[0]).toBe(good);
    expect(out[1]).not.toBe(bad);
    expect(out[1]!.content).toBe(INTERRUPTED_PLACEHOLDER);
  });

  it("不修改入参对象（copy-on-write）", () => {
    const bad = user(null);
    sanitizeApiMessages([bad]);
    expect(bad.content).toBeNull();
  });
});

describe("sanitizeApiMessages > pass 1 非法 role", () => {
  it("丢弃 API 不接受的 role", () => {
    const out = sanitizeApiMessages([
      user("a"),
      { role: "narration", content: "b" },
      assistant("c"),
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("保留 developer/function 等合法 role", () => {
    const out = sanitizeApiMessages([
      { role: "developer", content: "d" },
      { role: "function", content: "f", name: "x" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["developer", "function"]);
  });
});

describe("sanitizeApiMessages > pass 2 空内容", () => {
  it("非末条空 user/assistant 补中断占位符", () => {
    const out = sanitizeApiMessages([user(""), assistant("  "), user("last")]);
    expect(out[0]!.content).toBe(INTERRUPTED_PLACEHOLDER);
    expect(out[1]!.content).toBe(INTERRUPTED_PLACEHOLDER);
    expect(out[2]!.content).toBe("last");
  });

  it("末条 content 为 null/缺省时也补占位符（本项目网关实测 400）", () => {
    expect(sanitizeApiMessages([user("a"), user(null)])[1]!.content).toBe(
      INTERRUPTED_PLACEHOLDER,
    );
    expect(sanitizeApiMessages([user("a"), { role: "user" }])[1]!.content).toBe(
      INTERRUPTED_PLACEHOLDER,
    );
    expect(sanitizeApiMessages([user("a"), assistant(null)])[1]!.content).toBe(
      INTERRUPTED_PLACEHOLDER,
    );
  });

  it("末条空串/空数组是合法设计态，不动", () => {
    const emptyString = user("");
    const emptyArray = user([]);
    expect(sanitizeApiMessages([user("a"), emptyString])[1]).toBe(emptyString);
    expect(sanitizeApiMessages([user("a"), emptyArray])[1]).toBe(emptyArray);
  });

  it("有 tool_calls 的空 content assistant 不补占位符（已有载荷）", () => {
    const msg = assistant(null, [call("c1")]);
    const out = sanitizeApiMessages([user("a"), msg, tool("c1")]);
    expect(out[1]).toBe(msg);
  });

  it("多模态 text 块为空视为空内容", () => {
    const out = sanitizeApiMessages([
      user([{ type: "text", text: "   " }]),
      user("last"),
    ]);
    expect(out[0]!.content).toBe(INTERRUPTED_PLACEHOLDER);
  });

  it("非 text 多模态块视为有载荷", () => {
    const msg = user([{ type: "image_url", image_url: { url: "data:..." } }]);
    expect(sanitizeApiMessages([msg, user("last")])[0]).toBe(msg);
  });
});

describe("sanitizeApiMessages > pass 3 空 tool_calls", () => {
  it("assistant 上的 tool_calls: [] 删键（严格网关 400）", () => {
    const out = sanitizeApiMessages([user("a"), assistant("x", [])]);
    expect("tool_calls" in out[1]!).toBe(false);
  });

  it("非空 tool_calls 保留", () => {
    const msg = assistant("x", [call("c1")]);
    const out = sanitizeApiMessages([user("a"), msg, tool("c1")]);
    expect(out[1]).toBe(msg);
  });
});

describe("sanitizeApiMessages > pass 4 tool_calls 修复", () => {
  it("arguments 为对象 → 序列化为字符串", () => {
    const out = sanitizeApiMessages([
      user("a"),
      assistant("x", [call("c1", "shell_exec", { cmd: "ls" })]),
      tool("c1"),
    ]);
    const tc = (out[1]!.tool_calls as Array<{ function: { arguments: unknown } }>)[0]!;
    expect(typeof tc.function.arguments).toBe("string");
    expect(JSON.parse(tc.function.arguments as string)).toEqual({ cmd: "ls" });
  });

  it("arguments 为 null/None/空串 → \"{}\"", () => {
    for (const raw of [null, undefined, "", "   ", "None", "null"]) {
      const out = sanitizeApiMessages([
        user("a"),
        assistant("x", [call("c1", "shell_exec", raw)]),
        tool("c1"),
      ]);
      const tc = (out[1]!.tool_calls as Array<{ function: { arguments: unknown } }>)[0]!;
      expect(tc.function.arguments).toBe("{}");
    }
  });

  it("截断的 arguments 补右括号", () => {
    const out = sanitizeApiMessages([
      user("a"),
      assistant("x", [call("c1", "shell_exec", '{"cmd": "ls"')]),
      tool("c1"),
    ]);
    const tc = (out[1]!.tool_calls as Array<{ function: { arguments: string } }>)[0]!;
    expect(JSON.parse(tc.function.arguments)).toEqual({ cmd: "ls" });
  });

  it("非法 function.name 折叠为安全字符集", () => {
    const out = sanitizeApiMessages([
      user("a"),
      assistant("x", [call("c1", "my tool!")]),
      tool("c1"),
    ]);
    const tc = (out[1]!.tool_calls as Array<{ function: { name: string } }>)[0]!;
    expect(tc.function.name).toBe("my_tool");
  });

  it("tool_call 元素不是对象时替换为安全占位调用", () => {
    const out = sanitizeApiMessages([
      user("a"),
      assistant("x", ["garbage"]),
      tool(""),
    ]);
    const tc = (out[1]!.tool_calls as Array<{ function: { name: string } }>)[0]!;
    expect(tc.function.name).toBe("invalid_tool_call");
  });

  it("缺 type 时不改写（与 hermes 一致：只修 name/arguments）", () => {
    const msg = assistant("x", [{ id: "c1", function: { name: "shell_exec", arguments: "{}" } }]);
    const out = sanitizeApiMessages([user("a"), msg, tool("c1")]);
    expect(out[1]).toBe(msg);
  });
});

describe("sanitizeApiMessages > pass 5-6 配对", () => {
  it("缺 tool_call_id 的 tool 结果被丢弃", () => {
    const out = sanitizeApiMessages([
      user("a"),
      assistant("x", [call("c1")]),
      tool("c1"),
      { role: "tool", content: "orphan" },
    ]);
    expect(out.filter((m) => m.role === "tool").length).toBe(1);
  });

  it("未应答的 tool_call 在段末补桩", () => {
    const out = sanitizeApiMessages([user("a"), assistant("x", [call("c1"), call("c2")])]);
    const tools = out.filter((m) => m.role === "tool");
    expect(tools.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    expect(tools[0]!.content).toBe(UNAVAILABLE_RESULT_PLACEHOLDER);
    expect(tools[0]!.name).toBe("shell_exec");
  });

  it("出现在声明之前的 tool 结果被丢弃", () => {
    const out = sanitizeApiMessages([
      user("a"),
      tool("c1"),
      assistant("x", [call("c1")]),
      tool("c1"),
    ]);
    expect(out.filter((m) => m.role === "tool").length).toBe(1);
    expect(out.findIndex((m) => m.role === "tool")).toBeGreaterThan(
      out.findIndex((m) => m.role === "assistant"),
    );
  });

  it("user 消息打断 tool 段时先 flush 未应答声明", () => {
    const out = sanitizeApiMessages([
      user("a"),
      assistant("x", [call("c1")]),
      user("b"),
    ]);
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user"]);
  });

  it("配对完整时保持原引用", () => {
    const messages = [user("a"), assistant("x", [call("c1")]), tool("c1")];
    expect(sanitizeApiMessages(messages)).toBe(messages);
  });
});

describe("sanitizeApiMessages > pass 7-8 去重与命名对齐", () => {
  it("重复未应答的 tool_call_id 折叠", () => {
    const out = sanitizeApiMessages([
      user("a"),
      assistant("x", [call("c1"), call("c1")]),
      tool("c1"),
    ]);
    const tcs = out[1]!.tool_calls as unknown[];
    expect(tcs.length).toBe(1);
  });

  it("llama.cpp 常量 id 复用不误删（outstanding 语义，hermes #93251）", () => {
    const messages = [
      user("a"),
      assistant("x", [call("c1")]),
      tool("c1", "r1"),
      assistant("y", [call("c1")]),
      tool("c1", "r2"),
    ];
    const out = sanitizeApiMessages(messages);
    expect(out).toBe(messages);
    expect(out.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["r1", "r2"]);
  });

  it("tool 结果 name 对齐到调用声明", () => {
    const out = sanitizeApiMessages([
      user("a"),
      assistant("x", [call("c1", "shell_exec")]),
      tool("c1", "ok", "wrong_name"),
    ]);
    expect(out[2]!.name).toBe("shell_exec");
  });

  it("name 已一致时保持原引用", () => {
    const messages = [user("a"), assistant("x", [call("c1", "shell_exec")]), tool("c1", "ok", "shell_exec")];
    expect(sanitizeApiMessages(messages)).toBe(messages);
  });
});

describe("coerceToolName", () => {
  it("合法名原样返回", () => {
    expect(coerceToolName("shell_exec")).toBe("shell_exec");
    expect(coerceToolName("a-b_c1")).toBe("a-b_c1");
    expect(coerceToolName("_x_")).toBe("_x_");
  });

  it("非法字符折叠为下划线并去重", () => {
    expect(coerceToolName("my tool!!")).toBe("my_tool");
    expect(coerceToolName("a  b")).toBe("a_b");
  });

  it("折叠后首尾下划线剥离", () => {
    expect(coerceToolName("  x!  ")).toBe("x");
    expect(coerceToolName("!x!")).toBe("x");
  });

  it("截断到 64 字符", () => {
    expect(coerceToolName("a".repeat(100)).length).toBe(64);
  });

  it("非字符串/全非法 → fallback", () => {
    expect(coerceToolName(undefined)).toBe("invalid_tool_call");
    expect(coerceToolName(42)).toBe("invalid_tool_call");
    expect(coerceToolName("!!!")).toBe("invalid_tool_call");
    expect(coerceToolName("", "fb")).toBe("fb");
  });
});

describe("rebalanceJsonClosers", () => {
  it("补齐缺失的右括号", () => {
    expect(rebalanceJsonClosers('{"a": [1, 2')).toBe('{"a": [1, 2]}');
    expect(rebalanceJsonClosers('{"a": {"b": 1')).toBe('{"a": {"b": 1}}');
  });

  it("忽略字符串字面量内的括号", () => {
    expect(rebalanceJsonClosers('{"code": "}"}')).toBe('{"code": "}"}');
  });

  it("错配右括号前插入缺失的内层括号", () => {
    expect(rebalanceJsonClosers('{"a": [{"b": 1}}')).toBe('{"a": [{"b": 1}]}');
  });

  it("未闭合字符串返回 null（不猜测）", () => {
    expect(rebalanceJsonClosers('{"a": "unterminated')).toBeNull();
  });
});

describe("repairToolCallArguments", () => {
  it("合法 JSON 原样返回", () => {
    const raw = '{"a":1}';
    expect(repairToolCallArguments(raw)).toBe(raw);
  });

  it("尾逗号被去掉", () => {
    expect(JSON.parse(repairToolCallArguments('{"a":1,}'))).toEqual({ a: 1 });
  });

  it("裸控制字符被转义", () => {
    const out = repairToolCallArguments('{"a":"line1\nline2"}');
    expect(JSON.parse(out)).toEqual({ a: "line1\nline2" });
  });

  it("对象/数组重新序列化", () => {
    expect(JSON.parse(repairToolCallArguments({ a: 1 }))).toEqual({ a: 1 });
    expect(JSON.parse(repairToolCallArguments([1, 2]))).toEqual([1, 2]);
  });

  it("不可修复 → \"{}\"", () => {
    expect(repairToolCallArguments("not json at all")).toBe("{}");
    expect(repairToolCallArguments("null")).toBe("{}");
    expect(repairToolCallArguments("None")).toBe("{}");
    expect(repairToolCallArguments(42)).toBe("{}");
    expect(repairToolCallArguments(true)).toBe("{}");
  });
});

describe("sanitizeApiMessages > 端到端", () => {
  it("污染历史一次修干净（坏消息组合）", () => {
    const out = sanitizeApiMessages([
      { role: "narration", content: "drop me" },
      user(null),
      assistant("", []),
      user([{ type: "text", text: "" }]),
      assistant(null, [
        { id: "dup", function: { name: "a b", arguments: null } },
        { id: "dup", function: { name: "ok_name", arguments: '{"x":' } },
      ]),
      tool("dup", "r1", "mismatch"),
      { role: "tool", content: "no id" },
      tool("ghost"),
    ]);
    expect(out.every((m) => ["system", "user", "assistant", "tool"].includes(m.role))).toBe(true);
    // 所有 tool 结果都有 id 且都能被对应声明解释
    const declared = new Set<string>();
    for (const m of out) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Array<{ id: string }>) declared.add(tc.id);
      }
      if (m.role === "tool") {
        expect(typeof m.tool_call_id).toBe("string");
        expect(declared.has(m.tool_call_id as string)).toBe(true);
      }
    }
    // 没有空 tool_calls 数组；user/system 消息不再有 null content
    // （assistant content null 是合法的——网关探针实测 200，不强制补）
    for (const m of out) {
      if (m.role === "assistant") {
        expect(Array.isArray(m.tool_calls) && m.tool_calls.length === 0).toBe(false);
        continue;
      }
      expect(m.content === null || m.content === undefined).toBe(false);
    }
  });
});
