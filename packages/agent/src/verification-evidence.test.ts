import { describe, it, expect, vi } from "vitest";
import {
  VerificationEvidenceStore,
  getVerificationEvidenceStore,
  resetVerificationEvidenceStore,
  classifyVerificationCommand,
  isVerificationExitAttributable,
  pipelineLeadsLastPipe,
  resolvePipelineHeadExitCode,
  resolveStatusSentinelExitCode,
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
    // ★ 2026-11-19：isVerificationExitAttributable 现在含 PIPESTATUS 升级
    //   （pipelineLeadsLastPipe → true）——但该升级只在**数组真实存在**时由
    //   llm-caller 接线生效；本函数自身无结果可看，对管道命令保守判 false
    //   的行为不变（fail-closed 基线）。
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
// ═══════════════════════════════════════════════════════════
// PIPESTATUS 管道首段归因（2026-11-19，hermes base_session_env.py /
// verification_evidence._segment_status 的 TS 移植）
// ═══════════════════════════════════════════════════════════
describe("pipelineLeadsLastPipe（检查命令是否在最后一条管道首段）", () => {
  it("管道首段 → true", () => {
    expect(pipelineLeadsLastPipe("pnpm test | tail -20")).toBe(true);
    expect(pipelineLeadsLastPipe("node --test x.js 2>&1 | tail -20")).toBe(true);
    expect(pipelineLeadsLastPipe("vitest run 2>&1 | grep PASS | wc -l")).toBe(true);
  });
  it("管道非首段（首段非验证命令）→ false", () => {
    expect(pipelineLeadsLastPipe("cat run.log | grep vitest")).toBe(false);
    expect(pipelineLeadsLastPipe("echo hi | node --test x.js")).toBe(false);
  });
  it("无管道 → false", () => {
    expect(pipelineLeadsLastPipe("python3 test_x.py")).toBe(false);
    expect(pipelineLeadsLastPipe("")).toBe(false);
  });
  it("或链 → false（掩盖形态不适用 PIPESTATUS）", () => {
    expect(pipelineLeadsLastPipe("node --test x.js || true")).toBe(false);
  });
  it("引号内的 | 不算管道分隔", () => {
    expect(pipelineLeadsLastPipe(`echo "a|b"`)).toBe(false);
    expect(pipelineLeadsLastPipe(`grep "x|y" run.log`)).toBe(false);
  });
  it("前段管道 + 末段非管道命令 → false（末段无 |）", () => {
    expect(pipelineLeadsLastPipe("pnpm test | tee out.log")).toBe(true);
  });
  it("引号内的分号不产生新顶层片段", () => {
    expect(pipelineLeadsLastPipe(`node --test -e "console.log('a');console.log('b')" | tail -1`)).toBe(true);
  });
});

describe("resolvePipelineHeadExitCode（PIPESTATUS[0] 读取）", () => {
  it("有数组且首段是数字 → 返回首段", () => {
    expect(resolvePipelineHeadExitCode({ pipelineStatus: [7, 0] })).toBe(7);
    expect(resolvePipelineHeadExitCode({ pipelineStatus: [0] })).toBe(0);
  });
  it("数组缺失/空/首段非数字 → null（fail-closed）", () => {
    expect(resolvePipelineHeadExitCode({})).toBe(null);
    expect(resolvePipelineHeadExitCode({ pipelineStatus: [] })).toBe(null);
    expect(resolvePipelineHeadExitCode({ pipelineStatus: [NaN, 0] })).toBe(null);
    expect(resolvePipelineHeadExitCode({ pipelineStatus: "7 0" })).toBe(null);
    expect(resolvePipelineHeadExitCode(null)).toBe(null);
    expect(resolvePipelineHeadExitCode("result")).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════
// 状态哨兵退出码恢复（2026-11-22，v24 压测举一反三）
// `python3 test_x.py; echo "EXIT=$?"` 的 shell 退出码被 echo 掩盖，但 stdout
// 里写着真值——严格两段式 + 模板整行匹配才归因，其余维持 fail-closed。
// ═══════════════════════════════════════════════════════════
describe("resolveStatusSentinelExitCode（cmd; echo \"EXIT=$?\"）", () => {
  it("从输出恢复失败退出码", () => {
    expect(resolveStatusSentinelExitCode(
      'cd /w && python3 test_crdt.py; echo "EXIT=$?"',
      { output: "FAIL=2\nEXIT=1" },
    )).toBe(1);
  });
  it("支持任意前后缀模板（---TEST-EXIT: $?---）", () => {
    expect(resolveStatusSentinelExitCode(
      'python3 test_lineage.py; echo "---TEST-EXIT: $?---"',
      { output: "18/18 PASS\n---TEST-EXIT: 0---" },
    )).toBe(0);
  });
  it("从末行向前找，哨兵输出在最后（不误取检查命令自己的同形输出）", () => {
    expect(resolveStatusSentinelExitCode(
      'node --test x.js; echo "EXIT=$?"',
      { output: "EXIT=0\nassert failed\nEXIT=2" },
    )).toBe(2);
  });
  it("无引号 / ${?} 形态", () => {
    expect(resolveStatusSentinelExitCode("pytest -q; echo rc=$?", { output: "rc=3" })).toBe(3);
    expect(resolveStatusSentinelExitCode("pytest -q; echo rc=${?}", { output: "rc=0" })).toBe(0);
  });
  it("ANSI 颜色不干扰整行匹配", () => {
    expect(resolveStatusSentinelExitCode(
      'pytest -q; echo "EXIT=$?"',
      { output: "\x1b[31mEXIT=5\x1b[0m" },
    )).toBe(5);
  });
  it("管道 / 或链 / 单引号 / printf → null（fail-closed）", () => {
    expect(resolveStatusSentinelExitCode(
      'pytest -q | tail -5; echo "EXIT=$?"', { output: "EXIT=0" },
    )).toBe(null);
    expect(resolveStatusSentinelExitCode(
      'pytest -q || true; echo "EXIT=$?"', { output: "EXIT=0" },
    )).toBe(null);
    expect(resolveStatusSentinelExitCode(
      "pytest -q; echo 'EXIT=$?'", { output: "EXIT=$?" },
    )).toBe(null);
    expect(resolveStatusSentinelExitCode(
      'pytest -q; printf "EXIT=%d\\n" $?', { output: "EXIT=0" },
    )).toBe(null);
  });
  it("★ 多段链：哨兵紧邻验证命令即可归因（v25 Task 6 举一反三）", () => {
    // 旧实现要求恰好两段 → `cd dir; pytest; echo $?` 拿不到证据。
    // `$?` 只反映紧邻前一条命令，前置 cd/尾部 echo 都篡改不了它。
    expect(resolveStatusSentinelExitCode(
      'cd /w; pytest -q; echo "EXIT=$?"', { output: "EXIT=0" },
    )).toBe(0);
    expect(resolveStatusSentinelExitCode(
      'pytest -q; echo "EXIT=$?"; echo done', { output: "EXIT=0\ndone" },
    )).toBe(0);
    expect(resolveStatusSentinelExitCode(
      'cd /w; node --check a.js; node --test a.test.js; echo "EXIT=$?"',
      { output: "EXIT=1" },
    )).toBe(1);
    // 哨兵紧邻的不是验证命令（CLI 冒烟）→ 不归因
    expect(resolveStatusSentinelExitCode(
      'cd /w; node --test a.test.js; node cli.js run; echo "EXIT=$?"',
      { output: "EXIT=0" },
    )).toBe(null);
    // 有多对时取最后一对有效哨兵
    expect(resolveStatusSentinelExitCode(
      'pytest -q; echo "A=$?"; pytest -q; echo "B=$?"',
      { output: "A=0\nB=1" },
    )).toBe(1);
  });
  it("首段不是验证命令 / 输出缺模板行 / 越界码 → null", () => {
    expect(resolveStatusSentinelExitCode(
      'cat log.txt; echo "EXIT=$?"', { output: "EXIT=0" },
    )).toBe(null);
    expect(resolveStatusSentinelExitCode(
      'pytest -q; echo "EXIT=$?"', { output: "no marker here" },
    )).toBe(null);
    expect(resolveStatusSentinelExitCode(
      'pytest -q; echo "EXIT=$?"', { output: "EXIT=999" },
    )).toBe(null);
    expect(resolveStatusSentinelExitCode(
      'pytest -q; echo "EXIT=$?"', {},
    )).toBe(null);
  });
});

describe("未归因运行的 since 清除语义（hermes last_unattributed_run）", () => {
  it("任何可归因 record()（无论成败）都清空 unattributedRun", () => {
    const s = new VerificationEvidenceStore();
    s.markUnattributedRun("pnpm test | tail -20");
    expect(s.getLastUnattributedRun()).not.toBeNull();
    // 失败的可归因运行也清除——模型已经用直跑方式留下了可信结果
    s.record(["a.py"], "pnpm test", 1);
    expect(s.getLastUnattributedRun()).toBeNull();
    expect(s.getUnattributedStreak()).toBe(0);
  });
  it("未归因运行不清零 streak，可归因运行清零", () => {
    const s = new VerificationEvidenceStore();
    s.markUnattributedRun("a | tail");
    s.markUnattributedRun("b; echo done");
    s.markUnattributedRun("c || true");
    expect(s.getUnattributedStreak()).toBe(3);
    s.markUnattributedRun("d | tail");
    expect(s.getUnattributedStreak()).toBe(4);
    s.record(["x.js"], "node --test x.js", 1);
    expect(s.getUnattributedStreak()).toBe(0);
  });
});
