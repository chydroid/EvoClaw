/**
 * shell_result_hints 回归测试（对标 hermes terminal_tool_result.py + terminal_hints.py）
 *
 * 覆盖三类真实浪费：
 *   - 信息性非零退出码被当成失败（grep/diff/test/git 的 1）
 *   - 信号终止码看不懂（137=OOM、139=SIGSEGV）
 *   - 失败输出没有恢复提示（command not found / 跑错解释器 / 合并冲突）
 * 以及反向约束：退出码 0 的掩盖成功告警必须保守（只读命令头不告警）。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  interpretSignalExit,
  interpretSignalName,
  interpretExitCode,
  annotateFailure,
  annotateMaskedSuccess,
  shellResultAnnotations,
  isInformationalExit,
} from "../src/tools/shell-result-hints";
import { extractWriteTargets, ensureWriteTargetParents } from "../src/tools/shell-media-tools";

describe("interpretSignalExit", () => {
  it("负数退出码是确定的信号终止", () => {
    expect(interpretSignalExit(-9)).toContain("SIGKILL");
    expect(interpretSignalExit(-11)).toContain("SIGSEGV");
  });

  it("128+signum 用「通常」措辞（程序也可能自己 exit 139）", () => {
    expect(interpretSignalExit(137)).toContain("通常");
    expect(interpretSignalExit(137)).toContain("SIGKILL");
  });

  it("SIGINT(130) 与普通退出码不给信号说明", () => {
    expect(interpretSignalExit(130)).toBeNull();
    expect(interpretSignalExit(1)).toBeNull();
    expect(interpretSignalExit(0)).toBeNull();
  });

  it("-1 是「退出码不可得」哨兵，不得凭空断言 SIGHUP", () => {
    // closeInfo.code ?? -1 → -1 表示被信号终止但拿不到码。照 -signum 解读
    // 会给出「命令被信号 1 终止」这条**假事实**。
    expect(interpretSignalExit(-1)).toBeNull();
    expect(interpretExitCode("whatever", -1)).toBeNull();
    expect(shellResultAnnotations("whatever", -1, "boom")).toEqual({});
  });
});

describe("interpretSignalName — Node close 回调的 signal 名", () => {
  // v34 T4 实证：`child.on("close", (code) => …)` 只取 code 时，被信号杀死的
  // 子进程 code 是 null，模型只收到 {success:false, exitCode:null}，
  // 信号这条唯一事实完全丢失。signal 名必须独立接线。

  it("SIGKILL 给出 OOM/显式 kill 的解释", () => {
    expect(interpretSignalName("SIGKILL")).toContain("SIGKILL");
    expect(interpretSignalName("SIGKILL")).toContain("OOM");
  });

  it("SIGTERM / SIGSEGV 有各自说明", () => {
    expect(interpretSignalName("SIGTERM")).toContain("SIGTERM");
    expect(interpretSignalName("SIGSEGV")).toContain("段错误");
  });

  it("SIGINT 返回 null（中断标记路径负责）", () => {
    expect(interpretSignalName("SIGINT")).toBeNull();
  });

  it("null / undefined 返回 null（正常退出）", () => {
    expect(interpretSignalName(null)).toBeNull();
    expect(interpretSignalName(undefined)).toBeNull();
  });

  it("未知信号名仍如实报出，不编造解释", () => {
    const note = interpretSignalName("SIGSYS");
    expect(note).toContain("SIGSYS");
    expect(note).not.toContain("OOM");
  });

  it("shellResultAnnotations 优先用 signal 名（exitCode 是 -1 哨兵）", () => {
    const a = shellResultAnnotations("bash -c 'sleep 30'", -1, "", "SIGTERM");
    expect(a.exit_code_meaning).toContain("SIGTERM");
  });

  it("没有 signal 时退回退出码语义", () => {
    const a = shellResultAnnotations("grep foo .", 1, "", null);
    expect(a.exit_code_meaning).toContain("没有匹配");
  });
});

describe("interpretExitCode — 按命令的非零但正常", () => {
  it("grep 无匹配", () => {
    expect(interpretExitCode("grep -r foo .", 1)).toContain("没有匹配");
  });

  it("diff 有差异", () => {
    expect(interpretExitCode("diff a.txt b.txt", 1)).toContain("差异");
  });

  it("test 条件为假", () => {
    expect(interpretExitCode("test -f x", 1)).toContain("条件为假");
  });

  it("取管道最后一段的 base command", () => {
    expect(interpretExitCode("cat run.log | grep vitest", 1)).toContain("没有匹配");
  });

  it("跳过 VAR=val 前缀与路径", () => {
    expect(interpretExitCode("LC_ALL=C /usr/bin/grep foo f", 1)).toContain("没有匹配");
  });

  it("curl 退出码语义", () => {
    expect(interpretExitCode("curl http://x", 7)).toContain("无法连接");
    expect(interpretExitCode("curl http://x", 28)).toContain("超时");
  });

  it("退出码 0 与未知命令返回 null", () => {
    expect(interpretExitCode("grep foo .", 0)).toBeNull();
    expect(interpretExitCode("mycustomcmd", 1)).toBeNull();
  });
});

describe("annotateFailure — 输出模式恢复提示", () => {
  it("裸 python 不存在 → 指向 python3", () => {
    const h = annotateFailure("python x.py", 127, "bash: line 1: python: command not found");
    expect(h).toContain("python3");
  });

  it("ModuleNotFoundError 优先怀疑解释器", () => {
    const h = annotateFailure("python3 x.py", 1, "ModuleNotFoundError: No module named 'requests'");
    expect(h).toContain("venv");
  });

  it("git 合并冲突 → 不要原样重试", () => {
    const h = annotateFailure("git merge feature", 1, "CONFLICT (content): Merge conflict in a.py\nAutomatic merge failed");
    expect(h).toContain("冲突");
  });

  it("已在 → 换名或删除", () => {
    const h = annotateFailure("git branch x", 128, "fatal: a branch named 'x' already exists");
    expect(h).toContain("已存在");
  });

  it("无匹配输出时退回通用退出码提示", () => {
    expect(annotateFailure("whatever", 137, "Killed")).toContain("SIGKILL");
    expect(annotateFailure("whatever", 126, "x")).toContain("126");
  });

  it("退出码 0 永不给失败提示", () => {
    expect(annotateFailure("python x.py", 0, "command not found")).toBeNull();
  });
});

describe("annotateMaskedSuccess — 掩盖成功告警（保守）", () => {
  it("管道接 tail + 强失败特征 → 告警", () => {
    const note = annotateMaskedSuccess("npm test 2>&1 | tail -20", "3 failed\nFAILED src/a.test.ts");
    expect(note).toContain("tail");
  });

  it("`|| echo` 兜底 + 强失败特征 → 告警", () => {
    const note = annotateMaskedSuccess("make build || echo FAILED", "make: *** [build] Error 1\nBUILD FAILED");
    expect(note).toContain("||");
  });

  it("只读命令头不告警（grep 源码里的 error 字样是内容）", () => {
    expect(annotateMaskedSuccess("grep -r 'npm ERR!' src | tail -5", "npm ERR! found in code")).toBeNull();
  });

  it("没有强失败特征不告警", () => {
    expect(annotateMaskedSuccess("node x.js | tail -3", "all good\nDone")).toBeNull();
  });

  it("没有掩盖形态不告警", () => {
    expect(annotateMaskedSuccess("npm test", "1 failed")).toBeNull();
  });
});

describe("shellResultAnnotations — 统一入口", () => {
  it("信息性退出码只给 exit_code_meaning，不叠失败提示", () => {
    const a = shellResultAnnotations("grep foo .", 1, "");
    expect(a.exit_code_meaning).toContain("没有匹配");
    expect(a.hint).toBeUndefined();
  });

  it("真失败给 hint", () => {
    const a = shellResultAnnotations("python x.py", 127, "python: command not found");
    expect(a.hint).toContain("python3");
  });

  it("退出码 0 正常时返回空对象", () => {
    expect(shellResultAnnotations("node x.js", 0, "ok")).toEqual({});
  });

  it("退出码 0 但掩盖成功 → 只给 hint", () => {
    const a = shellResultAnnotations("npm test | tail -5", 0, "2 failed");
    expect(a.exit_code_meaning).toBeUndefined();
    expect(a.hint).toContain("tail");
  });
});

describe("isInformationalExit / non_error_exit（失败分类器豁免）", () => {
  it("grep/diff/test 的 1 标记为非错误退出", () => {
    for (const [cmd, code] of [["grep -r x .", 1], ["diff a b", 1], ["test -f x", 1], ["rg foo .", 1]] as const) {
      expect(isInformationalExit(cmd, code)).toBe(true);
    }
  });

  it("信号终止与未知命令不算信息性退出", () => {
    expect(isInformationalExit("grep x .", 137)).toBe(false);
    expect(isInformationalExit("mycmd", 1)).toBe(false);
    expect(isInformationalExit("grep x .", 0)).toBe(false);
  });

  it("有语义说明≠不是错误：curl 连不上 / git 1 / find 1 都仍算失败", () => {
    // 回归：曾用 EXIT_CODE_SEMANTICS 判定 non_error_exit，于是 curl 退出 7
    // （无法连接）被豁免失败记账 → 失败链与自动续跑都不触发。
    for (const [cmd, code] of [
      ["curl http://x", 7],
      ["curl http://x", 28],
      ["git diff", 1],
      ["find . -name x", 1],
    ] as const) {
      expect(interpretExitCode(cmd, code)).not.toBeNull();
      expect(isInformationalExit(cmd, code)).toBe(false);
      expect(shellResultAnnotations(cmd, code, "boom").non_error_exit).toBeUndefined();
    }
  });

  it("shellResultAnnotations 给信息性退出码带 non_error_exit", () => {
    const a = shellResultAnnotations("grep -c foo f", 1, "");
    expect(a.non_error_exit).toBe(true);
    expect(a.exit_code_meaning).toContain("没有匹配");
  });

  it("真失败不带 non_error_exit", () => {
    expect(shellResultAnnotations("python x.py", 127, "not found").non_error_exit).toBeUndefined();
  });
});

describe("extractWriteTargets — 只为真实写目标补父目录（v34 实证）", () => {
  it("程序参数不是写目标（不再凭空建 tests/）", () => {
    // 事故：python3 investigate.py … tests/test_calc.py 造出 data/workspace/tests/
    const targets = extractWriteTargets("python3 investigate.py repo tests/test_calc.py");
    expect(targets).toEqual([]);
  });

  it("重定向目标被识别", () => {
    expect(extractWriteTargets("echo hi > out/a.txt")).toContain("out/a.txt");
    expect(extractWriteTargets("node x.js >> logs/run.log")).toContain("logs/run.log");
    expect(extractWriteTargets("cmd 2> err/err.txt")).toContain("err/err.txt");
    expect(extractWriteTargets("cmd &> both/log.txt")).toContain("both/log.txt");
  });

  it("tee / touch 的参数被识别（跳过 -a 等开关）", () => {
    expect(extractWriteTargets("echo x | tee -a run/trace.txt")).toContain("run/trace.txt");
    expect(extractWriteTargets("touch a/b.txt c/d.txt")).toEqual(["a/b.txt", "c/d.txt"]);
  });

  it("fd 复制（>&2）与 /dev/null 不算写目标", () => {
    expect(extractWriteTargets("cmd > /dev/null 2>&1")).not.toContain("/dev/null");
    expect(extractWriteTargets("cmd 2>&1")).toEqual([]);
  });

  it("引号包裹的写目标（含空格路径）也被识别", () => {
    expect(extractWriteTargets('echo hi > "out dir/a.txt"')).toEqual(["out dir/a.txt"]);
    expect(extractWriteTargets("echo hi > 'logs/run 1.log'")).toEqual(["logs/run 1.log"]);
    expect(extractWriteTargets('echo x | tee "my dir/t.txt"')).toEqual(["my dir/t.txt"]);
  });

  it("变量/命令替换不是静态写目标（不得按字面量建目录）", () => {
    // 事故同族：`> "$OUT"` 若按字面量补父目录，会造出名为 `$OUT` 的目录。
    expect(extractWriteTargets('cmd > "$OUT"')).toEqual([]);
    expect(extractWriteTargets("cmd > ${LOG}/app.log")).toEqual([]);
    expect(extractWriteTargets("cmd > $(mktemp)")).toEqual([]);
    expect(extractWriteTargets("echo x | tee \"$TMPFILE\"")).toEqual([]);
    // 但含变量的静态前缀仍是真路径？不——整串不可静态求值，一律跳过（保守）
    expect(extractWriteTargets("cmd > logs/$NAME.txt")).toEqual([]);
  });

  it("ensureWriteTargetParents 只为写目标建父目录", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "evo-wt-"));
    try {
      ensureWriteTargetParents("python3 run.py args/thing.py", root);
      expect(fs.existsSync(path.join(root, "args"))).toBe(false);
      ensureWriteTargetParents("echo hi > nested/deep/out.txt", root);
      expect(fs.existsSync(path.join(root, "nested", "deep"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
