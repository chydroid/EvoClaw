import { describe, it, expect, vi } from "vitest";
import {
  VerificationEvidenceStore,
  getVerificationEvidenceStore,
  resetVerificationEvidenceStore,
  classifyVerificationCommand,
  isVerificationExitAttributable,
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

describe("失败事件不得伪装成「已验证」", () => {
  it("编辑后发生一次失败验证（跨毫秒）→ 仍需复验", () => {
    const s = new VerificationEvidenceStore();
    let t = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => t);
    try {
      s.markEdited(["a.ts"]);
      t += 5; // 失败事件时间戳晚于最后一次编辑
      s.record(["a.ts"], "pnpm test", 1);
    } finally {
      nowSpy.mockRestore();
    }
    expect(s.getStalePaths()).toEqual(["a.ts"]);
  });
});

describe("isVerificationExitAttributable（退出码可归因判定）", () => {
  it("直跑检查命令 → 可归因", () => {
    expect(isVerificationExitAttributable("pnpm test")).toBe(true);
    expect(isVerificationExitAttributable("node --test diff.test.js")).toBe(true);
    expect(isVerificationExitAttributable("cd x && node --test y.js")).toBe(true);
    expect(isVerificationExitAttributable("pytest -q 2>&1")).toBe(true);
  });

  it("接管道 → 不可归因（tail 恒 0，掩盖检查失败）", () => {
    expect(isVerificationExitAttributable("node --test x.js 2>&1 | tail -20")).toBe(false);
    expect(isVerificationExitAttributable("pnpm test | grep PASS")).toBe(false);
    expect(isVerificationExitAttributable("vitest run 2>&1 | tail -5")).toBe(false);
  });

  it("或链吞掉失败 → 不可归因", () => {
    expect(isVerificationExitAttributable("node --test x.js || true")).toBe(false);
    expect(isVerificationExitAttributable("pnpm test || echo failed")).toBe(false);
  });

  it("顺序分隔 + 恒 0 收尾命令 → 不可归因（v16 Task 4 实证）", () => {
    expect(isVerificationExitAttributable("python3 test_redact.py; echo \"test-exit=$?\"")).toBe(false);
    expect(isVerificationExitAttributable("pnpm test; true")).toBe(false);
    expect(isVerificationExitAttributable("node --test x.js ; printf done")).toBe(false);
    expect(isVerificationExitAttributable("vitest run; exit 0")).toBe(false);
  });

  it("顺序分隔但收尾是真实检查 → 仍可归因", () => {
    expect(isVerificationExitAttributable("cd x; node --test y.js")).toBe(true);
    expect(isVerificationExitAttributable("cd x; npm run build")).toBe(true);
  });

  it("引号内的分号（内联脚本）不参与收尾判定", () => {
    expect(isVerificationExitAttributable("node -e 'if (a) { b(); } ; check()'")).toBe(true);
    expect(isVerificationExitAttributable("python3 -c \"import x; x.run()\"")).toBe(true);
  });

  it("空命令 → 不可归因（fail-closed）", () => {
    expect(isVerificationExitAttributable("")).toBe(false);
  });
});

describe("未归因运行（unattributed run）", () => {
  it("markUnattributedRun 不影响证据有效性，成功验证后清空", () => {
    const s = new VerificationEvidenceStore();
    s.markEdited(["a.js"]);
    s.markUnattributedRun("node --test a.js | tail");
    expect(s.getLastUnattributedRun()).toBe("node --test a.js | tail");
    // 未归因运行没有 record()，工作区仍是「从未有可信验证」→ null（调用方据此 nudge）
    expect(s.getStalePaths()).toBeNull();
    expect(s.getState().editedPaths).toEqual(["a.js"]);
    // 之后一次真实成功的干净验证会清空编辑记录与未归因标记
    s.record(["a.js"], "node --test a.js", 0);
    expect(s.getStalePaths()).toEqual([]);
    expect(s.getLastUnattributedRun()).toBeNull();
  });

  it("clear() 同时清空未归因标记", () => {
    const s = new VerificationEvidenceStore();
    s.markUnattributedRun("pnpm test | tail");
    s.clear();
    expect(s.getLastUnattributedRun()).toBeNull();
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

// ═══════════════════════════════════════════════════════════
// ★ 2026-11-19（v18 压测 Task 1）测试红门：getLastFailedAttributable
// 故障签名——模型跑了自测、测试红（可归因 exit≠0）、仍声称全绿收尾。
// 门语义：最后一条可归因验证是失败且其后无成功覆盖 → 返回失败事实；
// 一旦有成功验证入账 → 失败事实失效（返回 null）。
// ═══════════════════════════════════════════════════════════
describe("VerificationEvidenceStore > 测试红门（getLastFailedAttributable）", () => {
  it("从未验证 → null", () => {
    const s = new VerificationEvidenceStore();
    expect(s.getLastFailedAttributable()).toBeNull();
  });

  it("唯一验证失败 → 返回失败事实（命令+退出码）", () => {
    const s = new VerificationEvidenceStore();
    s.record(["a.py"], "python3 test_a.py", 1);
    const f = s.getLastFailedAttributable();
    expect(f).not.toBeNull();
    expect(f!.command).toBe("python3 test_a.py");
    expect(f!.exitCode).toBe(1);
  });

  it("失败后成功验证覆盖 → 失效（返回 null）", () => {
    const s = new VerificationEvidenceStore();
    s.record(["a.py"], "python3 test_a.py", 1);
    s.record(["a.py"], "python3 test_a.py", 0);
    expect(s.getLastFailedAttributable()).toBeNull();
  });

  it("成功后再次失败 → 再次返回失败事实", () => {
    const s = new VerificationEvidenceStore();
    s.record(["a.py"], "python3 test_a.py", 0);
    s.record(["a.py"], "python3 test_a.py", 2);
    expect(s.getLastFailedAttributable()!.exitCode).toBe(2);
  });

  it("clear 后 → null", () => {
    const s = new VerificationEvidenceStore();
    s.record(["a.py"], "python3 test_a.py", 1);
    s.clear();
    expect(s.getLastFailedAttributable()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 2026-11-19（v18 复跑 Task 3）连续未归因计数：getUnattributedStreak
// 故障签名——模型用 `python3 test.py; echo "rc=$?"` / `| tail` 反复跑红测试
// （6 次全败），每次退出码被掩盖 → 账本无失败事件 → 测试红门静默。
// 语义：连续 unattributed 计数累加；任何可归因 record() 清零；clear() 清零。
// ═══════════════════════════════════════════════════════════
describe("VerificationEvidenceStore > 连续未归因计数（getUnattributedStreak）", () => {
  it("连续 markUnattributedRun 累加", () => {
    const s = new VerificationEvidenceStore();
    s.markUnattributedRun("python3 test.py; echo rc=$?");
    s.markUnattributedRun("python3 test.py | tail");
    s.markUnattributedRun("python3 test.py; echo done");
    expect(s.getUnattributedStreak()).toBe(3);
  });

  it("可归因 record()（无论成败）清零", () => {
    const s = new VerificationEvidenceStore();
    s.markUnattributedRun("a; echo 1");
    s.markUnattributedRun("b | tail");
    s.record(["a.py"], "python3 test_a.py", 1); // 失败但可归因 → 清零
    expect(s.getUnattributedStreak()).toBe(0);
  });

  it("clear() 清零", () => {
    const s = new VerificationEvidenceStore();
    s.markUnattributedRun("a; echo 1");
    s.markUnattributedRun("b; echo 2");
    s.clear();
    expect(s.getUnattributedStreak()).toBe(0);
  });

  it("从未 unattributed → 0", () => {
    const s = new VerificationEvidenceStore();
    s.record(["a.py"], "python3 test_a.py", 0);
    expect(s.getUnattributedStreak()).toBe(0);
  });
});