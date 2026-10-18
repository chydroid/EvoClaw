import { describe, it, expect } from "vitest";
import {
  ToolCallLoopDetector,
  PROGRESS_RESET_TOOLS,
} from "./guardrails";

type Step = [toolName: string, success: boolean, result: string];

/** 依次喂入工具调用，返回每步的检测结果。 */
function run(detector: ToolCallLoopDetector, steps: Step[]) {
  return steps.map(([toolName, success, result]) => detector.check(toolName, {}, success, result));
}

describe("ToolCallLoopDetector — identical_cycle（hermes oh-my-pi#10521 对齐）", () => {
  it("交替 A,B 循环不足 3 个完整周期时不告警", () => {
    const d = new ToolCallLoopDetector();
    // 2 laps（A,B,A,B）+ 一次 A：历史长度 5 < 2×3，窗口不够。
    // 结果交替变化（r_a/r_b）→ 不会先被 no_progress 抢报。
    const results = run(d, [
      ["tool_a", true, "r_a"],
      ["tool_b", true, "r_b"],
      ["tool_a", true, "r_a"],
      ["tool_b", true, "r_b"],
      ["tool_a", true, "r_a"],
    ]);
    expect(results.every(r => r.detection === "none")).toBe(true);
  });

  it("交替 A,B 循环 3 个完整周期时告警（默认 warn 阈值）", () => {
    const d = new ToolCallLoopDetector();
    const results = run(d, [
      ["tool_a", true, "r_a"],
      ["tool_b", true, "r_b"],
      ["tool_a", true, "r_a"],
      ["tool_b", true, "r_b"],
      ["tool_a", true, "r_a"],
      ["tool_b", true, "r_b"], // 第 6 次 = 3 laps → warn
    ]);
    expect(results[5]).toMatchObject({ detection: "identical_cycle", action: "warn", count: 3 });
    // warn 消息标注周期长度（尾部工具序列仅 halt 消息携带）
    expect(results[5]!.message).toContain("2 步周期");
  });

  it("交替 A,B 循环 5 个完整周期时阻断（默认 halt 阈值）", () => {
    const d = new ToolCallLoopDetector();
    const steps: Step[] = [];
    for (let lap = 0; lap < 5; lap++) {
      steps.push(["tool_a", true, "r_a"], ["tool_b", true, "r_b"]);
    }
    const results = run(d, steps);
    const halt = results.find(r => r.action === "halt");
    expect(halt).toMatchObject({ detection: "identical_cycle", count: 5 });
  });

  it("结果与工具序列都在变化时不判为周期循环（no_progress 与 cycle 均不误报）", () => {
    const d = new ToolCallLoopDetector();
    const results = run(d, [
      ["tool_a", true, "r1"],
      ["tool_b", true, "r2"],
      ["tool_a", true, "r3"],
      ["tool_b", true, "r4"],
      ["tool_a", true, "r5"],
      ["tool_b", true, "r6"],
    ]);
    expect(results.every(r => r.detection === "none")).toBe(true);
  });
});

describe("ToolCallLoopDetector — web_search_cap（hermes LoopCapConfig 对齐）", () => {
  it("web_search 类工具达到硬顶 50 前放行，第 51 次阻断", () => {
    const d = new ToolCallLoopDetector();
    const results: import("./guardrails").ToolLoopCheckResult[] = [];
    for (let i = 1; i <= 50; i++) {
      results.push(d.check("web_search", { q: `q${i}` }, true, `res${i}`));
    }
    expect(results.every(r => r.detection === "none")).toBe(true);
    const over = d.check("web_search", { q: "q51" }, true, "res51");
    expect(over).toMatchObject({ detection: "web_search_cap", action: "halt", count: 51, threshold: 50 });
  });

  it("计数按工具名归并（web_fetch / scrapling_fetch 共享硬顶）", () => {
    const d = new ToolCallLoopDetector({ maxWebSearchesPerTurn: 3 });
    const steps: Step[] = [
      ["web_search", true, "a"],
      ["web_fetch", true, "b"],
      ["scrapling_fetch", true, "c"],
    ];
    const results = run(d, steps);
    expect(results.every(r => r.detection === "none")).toBe(true);
    const over = d.check("browser_search", {}, true, "d");
    expect(over).toMatchObject({ detection: "web_search_cap", action: "halt" });
  });

  it("maxWebSearchesPerTurn=0 表示不限制", () => {
    const d = new ToolCallLoopDetector({ maxWebSearchesPerTurn: 0 });
    const results = run(d, Array.from({ length: 60 }, (_, i) => ["web_search", true, `r${i}`] as Step));
    expect(results.every(r => r.detection === "none")).toBe(true);
  });
});

describe("ToolCallLoopDetector — 成功 mutation 进度重置（hermes PROGRESS_RESET 语义）", () => {
  it("成功 shell_exec 清空精确/同名失败计数（改完再跑是新实验）", () => {
    const d = new ToolCallLoopDetector();
    // 同一调用失败 2 次 → 第 2 次触发 exact_failure 告警
    const r1 = d.check("deploy_tool", { v: "1" }, false, "boom");
    const r2 = d.check("deploy_tool", { v: "1" }, false, "boom");
    expect(r1!.detection).toBe("none");
    expect(r2!).toMatchObject({ detection: "exact_failure", action: "warn" });
    // 成功 mutation（PROGRESS_RESET_TOOLS）重置
    const r3 = d.check("shell_exec", { cmd: "fix" }, true, "ok");
    expect(r3!.detection).toBe("none");
    // 失败计数从 1 重新起算 → 不再告警
    const r4 = d.check("deploy_tool", { v: "1" }, false, "boom");
    expect(r4!.detection).toBe("none");
    expect(d.getExactFailureCount("deploy_tool", { v: "1" })).toBe(1);
  });

  it("成功 mutation 同时重置停滞计数（consecutiveSameResults）", () => {
    const d = new ToolCallLoopDetector();
    const same = "identical-output";
    const steps: Step[] = [
      ["read_tool", true, same],
      ["read_tool", true, same], // 连续相同 1 次
      ["file_create", true, "wrote"], // PROGRESS_RESET：清空停滞状态
      ["read_tool", true, same], // 计数重新开始，不构成 no_progress
    ];
    const results = run(d, steps);
    expect(results.every(r => r.detection === "none")).toBe(true);
  });

  it("PROGRESS_RESET_TOOLS 覆盖文件/shell/办公文档/浏览器动作", () => {
    expect(PROGRESS_RESET_TOOLS.has("shell_exec")).toBe(true);
    expect(PROGRESS_RESET_TOOLS.has("file_create")).toBe(true);
    expect(PROGRESS_RESET_TOOLS.has("pptx_create")).toBe(true);
    expect(PROGRESS_RESET_TOOLS.has("browser_click")).toBe(true);
    // 只读工具不在重置集合（重复读不应清空失败证据）
    expect(PROGRESS_RESET_TOOLS.has("file_read")).toBe(false);
    expect(PROGRESS_RESET_TOOLS.has("web_search")).toBe(false);
  });
});

describe("ToolCallLoopDetector — resetTurn 清场", () => {
  it("resetTurn 后 web_search 计数与周期历史全部清零", () => {
    const d = new ToolCallLoopDetector({ maxWebSearchesPerTurn: 2 });
    d.check("web_search", { q: "1" }, true, "r1");
    d.check("web_search", { q: "2" }, true, "r1");
    // 3 次超限阻断
    expect(d.check("web_search", { q: "3" }, true, "r1")).toMatchObject({ detection: "web_search_cap", action: "halt" });
    d.resetTurn();
    // 新 turn：计数归零，前 2 次放行
    expect(d.check("web_search", { q: "1" }, true, "r1").detection).toBe("none");
    expect(d.check("web_search", { q: "2" }, true, "r1").detection).toBe("none");
    expect(d.check("web_search", { q: "3" }, true, "r1").detection).toBe("web_search_cap");
  });
});
