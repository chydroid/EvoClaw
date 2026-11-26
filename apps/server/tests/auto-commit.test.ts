import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { autoCommit, buildAutoCommitMessage, isAutoCommitEnabled } from "../src/auto-commit";

/**
 * 自动提交回归（v25 Task 2 实证，2026-11-22）。
 *
 * 旧实现用 `execSync(`git commit -m ${JSON.stringify(msg)}`)`：JSON.stringify
 * 只做 JS 转义，不做 POSIX shell 转义。用户消息/agent 回复里带反引号或
 * `$(...)` 时，/bin/sh 会尝试命令替换——实测报
 * `Syntax error: EOF in backquote substitution`，自动提交静默失败
 * （git add 已执行，变更悬在工作区）。
 *
 * 新实现 execFileSync 参数数组，完全绕过 shell。本测试用真实临时仓库
 * 证明反引号/`$()` 能原样写入 commit message。
 */

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

describe("auto-commit shell 转义回归", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-autocommit-"));
    git(dir, ["init", "-q"]);
    fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "seed"]);
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  it("用户消息含反引号与 $() 时提交成功且原文入 message", () => {
    fs.writeFileSync(path.join(dir, "work.txt"), "done\n");
    const userMessage = "跑一下 `git status` 和 $(date +%s) 看看";
    const reply = "完成 `work.txt` 交付";

    const r = autoCommit(dir, userMessage, reply);
    expect(r.committed, r.error).toBe(true);

    const body = git(dir, ["log", "-1", "--format=%B"]);
    // 用户原始消息原样保留（反引号 + $() 都不经 shell）
    expect(body).toContain("$(date +%s)");
    expect(body).toContain("跑一下 `git status`");
    // 回复预览按既有约定剥 Markdown 装饰字符
    expect(body).toContain("完成 work.txt 交付");
    // 工作区已干净（add + commit 生效）
    expect(git(dir, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("无变更时返回 clean 且不报错", () => {
    const r = autoCommit(dir, "u", "r");
    expect(r.committed).toBe(false);
    expect(r.reason).toBe("clean");
  });

  it("非 git 目录返回 error 而不抛异常", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-notgit-"));
    try {
      const r = autoCommit(plain, "u", "r");
      expect(r.committed).toBe(false);
      expect(r.reason).toBe("error");
      expect(r.error).toBeTruthy();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("isAutoCommitEnabled 开关（默认关闭，hermes 对齐）", () => {
  it("未设置 / 空串 / 关闭值 → false", () => {
    for (const v of [undefined, "", " ", "0", "false", "no", "off", "disabled", "2"]) {
      const env = v === undefined ? {} : { EVOCLAW_AUTO_COMMIT: v };
      expect(isAutoCommitEnabled(env), `value=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("1/true/yes/on（大小写与空白不敏感）→ true", () => {
    for (const v of ["1", "true", "TRUE", "yes", "YES", "on", "  On  "]) {
      expect(isAutoCommitEnabled({ EVOCLAW_AUTO_COMMIT: v }), `value=${JSON.stringify(v)}`).toBe(true);
    }
  });
});

describe("buildAutoCommitMessage", () => {
  it("回复预览剥 Markdown 装饰并截断，原始用户消息不剥", () => {
    const msg = buildAutoCommitMessage("原样 `x` 保留", "# 标题\n\n**加粗** 正文");
    expect(msg).toContain("标题 加粗 正文");
    expect(msg).toContain("User: 原样 `x` 保留");
  });

  it("回复为空时用用户消息前 80 字符做标题", () => {
    const msg = buildAutoCommitMessage("  任务描述  ", "   ");
    expect(msg.startsWith("任务描述")).toBe(true);
  });
});
