import { describe, it, expect } from "vitest";
import { stripWorkspaceDirPrefix, resolveWsReceiptPath } from "./workspace-path";

// ═══════════════════════════════════════════════════════════
// 工作区路径契约归一化（v26 smoke 实证 + v29b T3 回执坐标系修复）
// ═══════════════════════════════════════════════════════════
describe("stripWorkspaceDirPrefix", () => {
  it("剥掉单层 data/workspace/ 前缀", () => {
    const r = stripWorkspaceDirPrefix("data/workspace/v29-t3/scanner.js");
    expect(r).toEqual({ value: "v29-t3/scanner.js", stripped: true });
  });

  it("剥掉多层嵌套前缀（双前缀事故形态）", () => {
    const r = stripWorkspaceDirPrefix("data/workspace/data/workspace/a.txt");
    expect(r).toEqual({ value: "a.txt", stripped: true });
  });

  it("无前缀时原样返回、标记未剥", () => {
    const r = stripWorkspaceDirPrefix("v29-t3/scanner.js");
    expect(r).toEqual({ value: "v29-t3/scanner.js", stripped: false });
  });

  it("大写 DATA/WORKSPACE 也剥（大小写不敏感）", () => {
    const r = stripWorkspaceDirPrefix("DATA/WORKSPACE/x.json");
    expect(r).toEqual({ value: "x.json", stripped: true });
  });

  it("./ 前导归一化", () => {
    const r = stripWorkspaceDirPrefix("./data/workspace/a.txt");
    expect(r).toEqual({ value: "a.txt", stripped: true });
  });
});

// ★ 2026-11-23 v29b T3 实证（D3b）：回执存工具侧原始 path（模型传什么记什么），
//   声称路径按 workspace 根解析成绝对路径——两侧坐标系不一致导致同名落点
//   比较永远失配，真实落点对齐的交付物被误报「落点漂移」+ 3 次无谓续跑。
describe("resolveWsReceiptPath（回执→声称同坐标系归一化）", () => {
  const ws = "/home/chy/EvoClaw/data/workspace";

  it("带 data/workspace/ 前缀的相对回执 → 按 workspace 根 resolve（无双前缀）", () => {
    expect(resolveWsReceiptPath(ws, "data/workspace/v29b-t3/scanner.js"))
      .toBe(`${ws}/v29b-t3/scanner.js`);
  });

  it("普通相对回执 → 按 workspace 根 resolve", () => {
    expect(resolveWsReceiptPath(ws, "v29b-t3/fixtures/leak.txt"))
      .toBe(`${ws}/v29b-t3/fixtures/leak.txt`);
  });

  it("绝对回执原样直通（含 data/workspace 中段也不乱剥）", () => {
    expect(resolveWsReceiptPath(ws, `${ws}/v29b-t3/scanner.js`))
      .toBe(`${ws}/v29b-t3/scanner.js`);
  });

  it("空路径退化为 baseDir", () => {
    expect(resolveWsReceiptPath(ws, "")).toBe(ws);
  });
});
