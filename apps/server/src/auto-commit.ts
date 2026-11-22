import { execFileSync } from "node:child_process";

export interface AutoCommitResult {
  committed: boolean;
  message?: string;
  reason?: "clean" | "error";
  error?: string;
}

/**
 * 构建自动提交信息。回复预览会剥掉 Markdown 装饰字符，避免 commit 标题
 * 被代码块/标题符号占据；用户原始消息只截断、不做清洗。
 */
export function buildAutoCommitMessage(userMessage: string, agentResponse: string): string {
  const replyPreview = agentResponse
    .replace(/[#*`>\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const msgSubject = replyPreview || userMessage.trim().slice(0, 80) || "auto commit";
  const msgBody = `\n\n---\n🤖 Auto-commit after agent task\nUser: ${userMessage.slice(0, 120)}`;
  return `${msgSubject}${msgBody}`;
}

/**
 * 每次 agent 任务完成后自动 commit 所有变更。
 *
 * ★ 2026-11-22（v25 Task 2 实证）：旧实现用 `execSync(`git commit -m
 * ${JSON.stringify(msg)}`)` 拼 shell 命令。JSON.stringify 只做 JS 转义，
 * 不做 POSIX shell 转义——回复/用户消息里的反引号、`$(...)` 会被 /bin/sh
 * 执行（实测 `Syntax error: EOF in backquote substitution`），自动提交
 * 静默失败。这里改用 execFileSync 传参数数组，完全不经过 shell。
 *
 * 失败只返回错误信息，不抛异常（调用方仅记日志，不中断主流程）。
 */
export function autoCommit(
  repoRoot: string,
  userMessage: string,
  agentResponse: string,
): AutoCommitResult {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repoRoot, stdio: "pipe" });
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    if (!String(status).trim()) return { committed: false, reason: "clean" };

    const message = buildAutoCommitMessage(userMessage, agentResponse);
    execFileSync("git", ["add", "-A"], { cwd: repoRoot, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", message], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    return { committed: true, message };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const detail = e.stderr ? e.stderr.toString() : e.message || String(err);
    return { committed: false, reason: "error", error: detail.trim() };
  }
}
