import { describe, it, expect } from "vitest";
import { normalizeToolActionArg } from "./tool-arg-normalization";

/**
 * v10 Task 6 事故回归（2026-11-10）：
 * 模型把 action 枚举值写坏成 "create\n</parameter=overwrite>\ntrue"，
 * 各工具严格 === dispatch 整条调用报废。全局归一化在调用汇合点做
 * 「首 token」匹配，只改 action 一个键。
 */

const fileWriteDef = {
  parameters: {
    action: { type: "string", enum: ["create", "modify"], required: true },
    path: { type: "string", required: true },
  },
};

describe("normalizeToolActionArg — action 枚举容错", () => {
  it("实测事故取值（换行 + 伪 XML 尾巴）→ 归一化为 create", () => {
    const r = normalizeToolActionArg(fileWriteDef, {
      action: "create\n</parameter=overwrite>\ntrue",
      path: "v10-script/gps-relativity-script.md",
      content: "x",
    });
    expect(r.args.action).toBe("create");
    expect(r.rewrittenFrom).toBe("create\n</parameter=overwrite>\ntrue");
    expect(r.rewrittenTo).toBe("create");
    expect(r.args.path).toBe("v10-script/gps-relativity-script.md");
  });

  it("大小写混写（MODIFY）→ 归一化为枚举原值", () => {
    const r = normalizeToolActionArg(fileWriteDef, { action: "MODIFY", path: "a.md" });
    expect(r.args.action).toBe("modify");
    expect(r.rewrittenTo).toBe("modify");
  });

  it("前后空白 → trim 后归一化", () => {
    const r = normalizeToolActionArg(fileWriteDef, { action: "  create  " });
    expect(r.args.action).toBe("create");
  });

  it("合法取值 → 原样返回且不标记改写", () => {
    const args = { action: "modify", path: "a.md" };
    const r = normalizeToolActionArg(fileWriteDef, args);
    expect(r.args).toBe(args);
    expect(r.rewrittenFrom).toBeUndefined();
  });

  it("首 token 不匹配任何枚举值 → 不改写（交 handler 报错）", () => {
    const r = normalizeToolActionArg(fileWriteDef, { action: "delete everything" });
    expect(r.args.action).toBe("delete everything");
    expect(r.rewrittenFrom).toBeUndefined();
  });

  it("无枚举声明 / 非对象参数 / 非字符串取值 / 空串 → 均不改写", () => {
    expect(
      normalizeToolActionArg({ parameters: { action: { type: "string" } } }, { action: "Create!" })
        .args.action,
    ).toBe("Create!");
    expect(normalizeToolActionArg(undefined, { action: "create\nx" }).args.action).toBe(
      "create\nx",
    );
    expect(normalizeToolActionArg(fileWriteDef, { action: 1 }).args.action).toBe(1);
    expect(normalizeToolActionArg(fileWriteDef, { action: "" }).args.action).toBe("");
    expect(normalizeToolActionArg(fileWriteDef, {}).args.action).toBeUndefined();
  });

  it("枚举里非字符串成员被过滤，不影响匹配", () => {
    const def = { parameters: { action: { enum: ["list", 3, null, "new"] } } };
    const r = normalizeToolActionArg(def, { action: "NEW\njunk" });
    expect(r.args.action).toBe("new");
  });

  it("多词枚举值（recall_runs）按下划线 token 正确匹配", () => {
    const def = { parameters: { action: { enum: ["create", "recall_runs", "retry_dlq"] } } };
    const r = normalizeToolActionArg(def, { action: "RECALL_RUNS\n</parameter=name>\nx" });
    expect(r.args.action).toBe("recall_runs");
  });
});
