import { describe, it, expect } from "vitest";
import {
  deriveTitle,
  isTitleableUserMessage,
  stripControlWrappers,
  shouldApplyTitle,
  applyDerivedTitle,
  MAX_DERIVED_TITLE_CHARS,
  type TitleSource,
} from "../src/session-title";

describe("isTitleableUserMessage", () => {
  it("普通用户消息可派生", () => {
    expect(isTitleableUserMessage("帮我修复登录按钮在手机上没反应的问题")).toBe(true);
  });
  it("空消息不可派生", () => {
    expect(isTitleableUserMessage("   ")).toBe(false);
  });
  it("机器 opener 不可派生", () => {
    expect(isTitleableUserMessage("[CONTEXT COMPACTION HANDOFF] ...")).toBe(false);
    expect(isTitleableUserMessage("[System: The active model for this chat has changed to x")).toBe(false);
  });
  it("附件-only opener 不可派生", () => {
    expect(isTitleableUserMessage("@file:src/deep/path/really/long/file.ts")).toBe(false);
  });
});

describe("stripControlWrappers", () => {
  it("剥除控制标签保留正文", () => {
    expect(stripControlWrappers("<command-name>x</command-name>帮我重构")).toBe("x帮我重构");
  });
});

describe("deriveTitle", () => {
  it("取首个有意义行", () => {
    expect(deriveTitle("\n\n  修复 Postgres 连接池耗尽  \n更多内容")).toBe("修复 Postgres 连接池耗尽");
  });

  it("未超上限原样", () => {
    expect(deriveTitle("Fix login button on mobile")).toBe("Fix login button on mobile");
  });

  it("超上限按词边界裁 + 省略号", () => {
    const long = "Investigate and fix the issue where the login button does not respond on mobile devices";
    const t = deriveTitle(long)!;
    expect(t.length).toBeLessThanOrEqual(MAX_DERIVED_TITLE_CHARS + 1);
    expect(t.endsWith("…")).toBe(true);
  });

  it("不可派生返回 null", () => {
    expect(deriveTitle("@file:foo.ts")).toBeNull();
    expect(deriveTitle("[SYSTEM] x")).toBeNull();
  });

  it("剥 tick 控制包裹后派生", () => {
    expect(deriveTitle("<task-notification>build done</task-notification>记录一下")).toContain("记录一下");
  });
});

describe("shouldApplyTitle（provenance 权威序 derived < llm < user）", () => {
  it("空标题可应用任意来源", () => {
    expect(shouldApplyTitle(null, "derived")).toBe(true);
    expect(shouldApplyTitle({}, "derived")).toBe(true);
  });
  it("derived 不能覆盖 llm", () => {
    expect(shouldApplyTitle({ title: "llm title", titleSource: "llm" }, "derived")).toBe(false);
  });
  it("llm 可覆盖 derived", () => {
    expect(shouldApplyTitle({ title: "d", titleSource: "derived" }, "llm")).toBe(true);
  });
  it("任何来源都不能覆盖 user", () => {
    expect(shouldApplyTitle({ title: "u", titleSource: "user" }, "llm")).toBe(false);
    expect(shouldApplyTitle({ title: "u", titleSource: "user" }, "derived")).toBe(false);
  });
});

describe("applyDerivedTitle", () => {
  it("空会话应用 derived", () => {
    const r = applyDerivedTitle({}, "帮我分析这段日志");
    expect(r).toEqual({ title: "帮我分析这段日志", titleSource: "derived" });
  });
  it("已有 derived 不重复覆盖", () => {
    expect(applyDerivedTitle({ title: "x", titleSource: "derived" }, "新消息")).toBeNull();
  });
  it("用户 customName 永不覆盖", () => {
    expect(applyDerivedTitle({ customName: "用户命名" }, "帮我分析")).toBeNull();
  });
  it("已有 llm 标题不被 derived 覆盖", () => {
    expect(applyDerivedTitle({ title: "llm", titleSource: "llm" }, "新消息")).toBeNull();
  });
  it("不可派生的消息返回 null", () => {
    expect(applyDerivedTitle({}, "@file:x.ts")).toBeNull();
  });
});

describe("TitleSource 类型完整性", () => {
  it("三档来源齐全", () => {
    const srcs: TitleSource[] = ["derived", "llm", "user"];
    expect(srcs.length).toBe(3);
  });
});
