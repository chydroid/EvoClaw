import { describe, it, expect } from "vitest";
import {
  capMessageContent,
  injectTruncationNotice,
  capMessages,
  extractErrorFirstLine,
  SECTION_MAX_CHARS,
  getMaxLenForMessage,
} from "./message-utils";
import type { AgentMessage } from "./message-utils";

describe("capMessageContent", () => {
  it("短内容不截断", () => {
    expect(capMessageContent("short", 100)).toBe("short");
  });

  it("长内容头尾保留", () => {
    const content = "a".repeat(200);
    const result = capMessageContent(content, 100);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("[truncated");
    // 头部 50 字符
    expect(result.startsWith("a".repeat(50))).toBe(true);
    // 尾部 50 字符
    expect(result.endsWith("a".repeat(50))).toBe(true);
  });

  it("默认 maxLen=8000", () => {
    const content = "x".repeat(9000);
    const result = capMessageContent(content);
    expect(result.length).toBeLessThan(9000);
  });

  it("空内容不截断", () => {
    expect(capMessageContent("", 100)).toBe("");
  });
});

describe("injectTruncationNotice", () => {
  it("droppedCount=0 不注入", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
    ];
    const result = injectTruncationNotice(messages, 0);
    expect(result.length).toBe(1);
  });

  it("droppedCount>0 注入通知", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
    ];
    const result = injectTruncationNotice(messages, 5);
    expect(result.length).toBe(2);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("5");
    expect(result[0].content).toContain("truncated");
  });

  it("通知在第一个非 system 消息前", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ];
    const result = injectTruncationNotice(messages, 3);
    expect(result.length).toBe(3);
    expect(result[0].role).toBe("system"); // 原 system
    expect(result[1].role).toBe("system"); // 通知
    expect(result[1].content).toContain("truncated");
    expect(result[2].role).toBe("user"); // 原 user
  });

  it("全是 system 消息时通知追加到末尾", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "sys1" },
      { role: "system", content: "sys2" },
    ];
    const result = injectTruncationNotice(messages, 2);
    expect(result.length).toBe(3);
    expect(result[2].content).toContain("truncated");
  });
});

describe("capMessages", () => {
  it("短消息不截断", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "short" },
    ];
    const result = capMessages(messages, 100);
    expect(result.cappedCount).toBe(0);
    expect(result.messages[0].content).toBe("short");
  });

  it("长消息截断", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "a".repeat(200) },
      { role: "assistant", content: "short" },
    ];
    const result = capMessages(messages, 100);
    expect(result.cappedCount).toBe(1);
    expect(result.messages[0].content.length).toBeLessThan(200);
    expect(result.messages[1].content).toBe("short");
  });
});

describe("extractErrorFirstLine", () => {
  it("提取 stderr 首行", () => {
    const stderr = "Error: file not found\n  at line 42\n  at foo()";
    const result = extractErrorFirstLine(stderr);
    expect(result.errorLine).toBe("Error: file not found");
  });

  it("截断超长错误行", () => {
    const stderr = "x".repeat(300);
    const result = extractErrorFirstLine(stderr, undefined, 100);
    expect(result.errorLine.length).toBe(100);
  });

  it("附加 cmd 信息", () => {
    const result = extractErrorFirstLine("error", "python script.py --arg");
    expect(result.cmdLine).toContain("cmd:");
    expect(result.cmdLine).toContain("python script.py --arg");
  });

  it("cmd 截断到 100 字符", () => {
    const longCmd = "x".repeat(200);
    const result = extractErrorFirstLine("error", longCmd, 200, 100);
    expect(result.cmdLine.length).toBeLessThan(120); // "cmd: " + 100
  });

  it("空 stderr", () => {
    const result = extractErrorFirstLine("");
    expect(result.errorLine).toBe("");
  });
});

describe("SECTION_MAX_CHARS", () => {
  it("常量值", () => {
    expect(SECTION_MAX_CHARS.TOOL_ERROR).toBe(1000);
    expect(SECTION_MAX_CHARS.TOOL_SUCCESS).toBe(800);
    expect(SECTION_MAX_CHARS.TOOL_ARGS).toBe(500);
    expect(SECTION_MAX_CHARS.TOOL_SUMMARY).toBe(1500);
  });
});

describe("getMaxLenForMessage", () => {
  it("tool error 消息", () => {
    const msg: AgentMessage = { role: "tool", content: "Error: something failed" };
    expect(getMaxLenForMessage(msg)).toBe(SECTION_MAX_CHARS.TOOL_ERROR);
  });

  it("tool success 消息", () => {
    const msg: AgentMessage = { role: "tool", content: "OK" };
    expect(getMaxLenForMessage(msg)).toBe(SECTION_MAX_CHARS.TOOL_SUCCESS);
  });

  it("user 消息", () => {
    const msg: AgentMessage = { role: "user", content: "hello" };
    expect(getMaxLenForMessage(msg)).toBe(SECTION_MAX_CHARS.USER_MESSAGE);
  });

  it("assistant 消息", () => {
    const msg: AgentMessage = { role: "assistant", content: "hi" };
    expect(getMaxLenForMessage(msg)).toBe(SECTION_MAX_CHARS.ASSISTANT_MESSAGE);
  });

  it("system 消息", () => {
    const msg: AgentMessage = { role: "system", content: "sys" };
    expect(getMaxLenForMessage(msg)).toBe(SECTION_MAX_CHARS.SYSTEM_MESSAGE);
  });
});
