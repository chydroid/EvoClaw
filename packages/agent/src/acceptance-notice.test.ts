import { describe, it, expect } from "vitest";
import {
  summarizeAcceptance,
  hasAcceptanceViolations,
  buildAcceptanceCorrection,
  buildAcceptanceFooter,
  buildWrapUpNotice,
} from "./acceptance-notice";

// ═══════════════════════════════════════════════════════════
// 验收文案：续跑指令 / 收尾 footer / 80% 轮次提醒。
// 这些措辞是产品行为（弱模型对措辞极敏感），单测锁定关键指令，
// 防止后续重构把「先补必交文件再收尾」丢掉。
// ═══════════════════════════════════════════════════════════

describe("summarizeAcceptance", () => {
  it("按 issue 类型归并，冻结输入单列", () => {
    const summary = summarizeAcceptance(
      [
        { kind: "missing", raw: "a.py", path: "/w/a.py" },
        { kind: "undersized", raw: "README.md", path: "/w/README.md", actualBytes: 10, minBytes: 300 },
        { kind: "under_asserted", raw: "t.py", path: "/w/t.py", actualAssertions: 2, minAssertions: 8 },
      ],
      [{ raw: "in.json", path: "/w/in.json", kind: "modified", snapshot: { raw: "in.json", path: "/w/in.json", bytes: 1, hash: "h" } }],
    );
    expect(summary).toEqual({
      missing: ["/w/a.py"],
      undersized: [{ path: "/w/README.md", actualBytes: 10, minBytes: 300 }],
      underAsserted: [{ path: "/w/t.py", actualAssertions: 2, minAssertions: 8 }],
      frozen: [{ path: "/w/in.json", kind: "modified" }],
    });
    expect(hasAcceptanceViolations(summary)).toBe(true);
  });

  it("空输入无违规", () => {
    const summary = summarizeAcceptance([]);
    expect(hasAcceptanceViolations(summary)).toBe(false);
  });
});

describe("buildAcceptanceCorrection", () => {
  it("无违规返回空字符串（调用方可直接 || undefined）", () => {
    expect(buildAcceptanceCorrection(summarizeAcceptance([]))).toBe("");
  });

  it("缺失项：要求 file_write 真正创建 + 绝对路径原样传入", () => {
    const text = buildAcceptanceCorrection(summarizeAcceptance([
      { kind: "missing", raw: "report.json", path: "/w/report.json" },
    ]));
    expect(text).toContain("交付物契约未满足");
    expect(text).toContain("`/w/report.json`");
    expect(text).toContain("file_write");
  });

  it("阈值项：要求在原文件上补足，禁止重建整个文件", () => {
    const text = buildAcceptanceCorrection(summarizeAcceptance([
      { kind: "undersized", raw: "README.md", path: "/w/README.md", actualBytes: 10, minBytes: 300 },
      { kind: "under_asserted", raw: "t.py", path: "/w/t.py", actualAssertions: 2, minAssertions: 8 },
    ]));
    expect(text).toContain("当前 10 字节，任务要求 ≥300 字节");
    expect(text).toContain("当前 2 个断言，任务要求 ≥8 个");
    expect(text).toContain("不要重建整个文件");
    expect(text).toContain("真实断言");
    expect(text).toContain("重跑测试确认退出码 0");
  });

  it("冻结项：说明已还原 + 要求改实现而非改夹具", () => {
    const text = buildAcceptanceCorrection(summarizeAcceptance(
      [],
      [{ raw: "in.json", path: "/w/in.json", kind: "modified", snapshot: { raw: "in.json", path: "/w/in.json", bytes: 1, hash: "h" } }],
    ));
    expect(text).toContain("冻结输入被修改");
    expect(text).toContain("原始内容已**还原**");
    expect(text).toContain("frozen-archive");
    expect(text).toContain("修正实现/断言");
  });

  it("三类问题同时存在时全部给出", () => {
    const text = buildAcceptanceCorrection(summarizeAcceptance(
      [
        { kind: "missing", raw: "a.py", path: "/w/a.py" },
        { kind: "undersized", raw: "README.md", path: "/w/README.md", actualBytes: 1, minBytes: 300 },
      ],
      [{ raw: "in.json", path: "/w/in.json", kind: "missing", snapshot: { raw: "in.json", path: "/w/in.json", bytes: 1, hash: "h" } }],
    ));
    expect(text).toContain("交付物契约未满足");
    expect(text).toContain("交付物未达到任务写明的验收门槛");
    expect(text).toContain("冻结输入被修改");
  });
});

describe("buildAcceptanceFooter", () => {
  it("无违规返回 undefined（不污染回复）", () => {
    expect(buildAcceptanceFooter(summarizeAcceptance([]))).toBeUndefined();
  });

  it("逐条列出未达标事实，并声明任务未全部完成", () => {
    const footer = buildAcceptanceFooter(summarizeAcceptance(
      [
        { kind: "missing", raw: "a.py", path: "/w/a.py" },
        { kind: "undersized", raw: "README.md", path: "/w/README.md", actualBytes: 10, minBytes: 300 },
        { kind: "under_asserted", raw: "t.py", path: "/w/t.py", actualAssertions: 2, minAssertions: 8 },
      ],
      [{ raw: "in.json", path: "/w/in.json", kind: "modified", snapshot: { raw: "in.json", path: "/w/in.json", bytes: 1, hash: "h" } }],
    ));
    expect(footer).toContain("任务验收未全部满足");
    expect(footer).toContain("`/w/a.py`：任务要求交付，磁盘上不存在");
    expect(footer).toContain("10 字节 < 任务要求 300 字节");
    expect(footer).toContain("2 个断言 < 任务要求 8 个");
    expect(footer).toContain("被修改");
    expect(footer).toContain("请勿据此认为任务已全部完成");
  });
});

describe("buildWrapUpNotice", () => {
  it("列出必交产物与缺失项，给出「先补文件再验收」的执行顺序", () => {
    const notice = buildWrapUpNotice(32, 40, ["/w/a.py", "/w/report.json"], ["/w/report.json"]);
    expect(notice).toContain("32/40");
    expect(notice).toContain("80%");
    expect(notice).toContain("`/w/a.py`");
    expect(notice).toContain("当前仍缺失的必交产物");
    expect(notice).toContain("`/w/report.json`");
    expect(notice).toContain("① 写缺失的必交文件");
  });

  it("无缺失时不渲染缺失清单，但仍给验收顺序", () => {
    const notice = buildWrapUpNotice(32, 40, ["/w/a.py"], []);
    expect(notice).not.toContain("当前仍缺失的必交产物");
    expect(notice).toContain("① 确认全部必交产物已落盘");
  });

  it("不要求「停止验证」——红测试必须先修绿（与测试红门一致）", () => {
    const notice = buildWrapUpNotice(32, 40, [], []);
    expect(notice).not.toContain("停止验证");
    expect(notice).toContain("不要带着红测试收尾");
    expect(notice).toContain("确认退出码 0");
  });
});
