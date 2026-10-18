import { describe, it, expect } from "vitest";
import {
  VerificationEvidenceStore,
  getVerificationEvidenceStore,
  resetVerificationEvidenceStore,
  classifyVerificationCommand,
} from "./verification-evidence";

// ═══════════════════════════════════════════════════════════
// 验证证据账本（hermes verification_evidence「编辑失效」语义的 TS 移植）
// 核心不变式：一次验证覆盖某些路径后，再编辑这些路径即判失效，
// 让验证门区分「从未验证」/「验证过但已被改动」/「验证仍然有效」。
// ═══════════════════════════════════════════════════════════
describe("VerificationEvidenceStore > 编辑失效（edit-invalidation）", () => {
  it("从未验证 → getStalePaths 返回 null", () => {
    const s = new VerificationEvidenceStore();
    expect(s.getStalePaths()).toBeNull();
  });

  it("成功验证后无编辑 → 验证有效（返回 []）", () => {
    const s = new VerificationEvidenceStore();
    s.record(["a.ts"], "pnpm test", 0);
    expect(s.getStalePaths()).toEqual([]);
  });

  it("成功验证后又编辑 → 失效路径列表", () => {
    const s = new VerificationEvidenceStore();
    s.record(["a.ts", "b.ts"], "pnpm test", 0);
    s.markEdited(["a.ts"]);
    expect(s.getStalePaths()).toEqual(["a.ts"]);
  });

  it("失败的验证（exitCode !== 0）不清空编辑记录", () => {
    const s = new VerificationEvidenceStore();
    s.markEdited(["a.ts"]); // 先编辑
    s.record(["a.ts"], "pnpm test", 1); // 失败验证：不清空
    expect(s.getStalePaths()).toEqual(["a.ts"]);
  });

  it("成功验证后编辑多条路径 → 全部列入失效列表", () => {
    const s = new VerificationEvidenceStore();
    s.record(["a.ts"], "pnpm test", 0);
    s.markEdited(["a.ts"]);
    s.markEdited(["b.ts"]);
    expect(s.getStalePaths().sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("编辑发生在验证之前 → 验证仍有效", () => {
    const s = new VerificationEvidenceStore();
    s.markEdited(["a.ts"]); // 编辑在前
    s.record(["a.ts"], "pnpm test", 0); // 验证在后，成功清空编辑记录
    expect(s.getStalePaths()).toEqual([]);
  });

  it("clear 重置全部状态", () => {
    const s = new VerificationEvidenceStore();
    s.record(["a.ts"], "pnpm test", 0);
    s.markEdited(["a.ts"]);
    expect(s.getStalePaths()).toEqual(["a.ts"]);
    s.clear();
    expect(s.getStalePaths()).toBeNull();
    expect(s.getLastEvent()).toBeNull();
  });

  it("getState 快照包含 lastEvent / lastEditAt / editedPaths", () => {
    const s = new VerificationEvidenceStore();
    s.record(["a.ts"], "pnpm test", 0);
    const state = s.getState();
    expect(state.lastEvent).not.toBeNull();
    expect(state.lastEvent!.command).toBe("pnpm test");
    expect(state.lastEvent!.exitCode).toBe(0);
    expect(state.editedPaths).toEqual([]);
  });
});

describe("classifyVerificationCommand", () => {
  it("识别 test / lint / typecheck / build / fmt 各类命令", () => {
    expect(classifyVerificationCommand("pnpm test")).toBe("test");
    expect(classifyVerificationCommand("python -m pytest")).toBe("test");
    expect(classifyVerificationCommand("npm run lint")).toBe("lint");
    expect(classifyVerificationCommand("ruff check .")).toBe("lint");
    expect(classifyVerificationCommand("tsc --noEmit")).toBe("typecheck");
    expect(classifyVerificationCommand("pnpm build")).toBe("build");
    expect(classifyVerificationCommand("prettier --write .")).toBe("format");
  });

  it("非验证命令返回 null", () => {
    expect(classifyVerificationCommand("echo hello")).toBeNull();
    expect(classifyVerificationCommand("git status")).toBeNull();
    expect(classifyVerificationCommand("")).toBeNull();
  });
});

describe("getVerificationEvidenceStore 单例", () => {
  it("同一 sessionId 返回同一实例，不同 sessionId 返回不同实例", () => {
    const a = getVerificationEvidenceStore("sess-1");
    const b = getVerificationEvidenceStore("sess-1");
    const c = getVerificationEvidenceStore("sess-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("resetVerificationEvidenceStore 清除指定 session", () => {
    const sid = "sess-reset-test";
    const s = getVerificationEvidenceStore(sid);
    s.record(["a.ts"], "pnpm test", 0);
    resetVerificationEvidenceStore(sid);
    const s2 = getVerificationEvidenceStore(sid);
    expect(s2).not.toBe(s);
    expect(s2.getStalePaths()).toBeNull();
  });
});