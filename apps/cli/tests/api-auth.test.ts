/**
 * CLI apiRequest 鉴权回归测试（P5 收尾）。
 *
 * Gateway 对非公开 /api/* 要求 web_ui_token cookie；CLI 此前完全不带认证，
 * 导致所有需要鉴权的命令 401。这里验证 token 注入与 401 提示，不泄露令牌值。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { apiRequest, authFailureHint, getWebUiToken, setPort } from "../src/utils/api";

/** 启动一个只回显请求头的临时 HTTP server */
async function echoServer(): Promise<{ port: number; close: () => Promise<void>; headers: () => http.IncomingHttpHeaders }> {
  let seen: http.IncomingHttpHeaders = {};
  const server = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    headers: () => seen,
  };
}

describe("CLI apiRequest 鉴权", () => {
  let tmpDir: string | undefined;

  /** 让 envPaths() 的 cwd 分支指向临时目录，避免真正 chdir（worker 中不支持） */
  const withTempCwd = (dir: string): void => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    fs.writeFileSync(path.join(dir, ".env"), "WEB_UI_TOKEN=from-dotenv-value\n");
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("显式 token 以 web_ui_token cookie 发送", async () => {
    const srv = await echoServer();
    try {
      setPort(srv.port);
      await apiRequest("GET", "/api/mcp-oauth/x/status", undefined, { token: "abc-123" });
      expect(srv.headers().cookie).toBe("web_ui_token=abc-123");
    } finally {
      await srv.close();
    }
  });

  it("自动读取当前目录 .env 的 WEB_UI_TOKEN（不打印、不写 process.env）", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-cli-auth-"));
    withTempCwd(tmpDir);
    vi.stubEnv("WEB_UI_TOKEN", "");
    vi.stubEnv("EVOCLAW_WEB_UI_TOKEN", "");
    expect(getWebUiToken()).toBe("from-dotenv-value");
    expect(process.env.WEB_UI_TOKEN).toBe("");
  });

  it("显式环境变量优先于 .env", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-cli-auth-"));
    withTempCwd(tmpDir);
    vi.stubEnv("WEB_UI_TOKEN", "");
    vi.stubEnv("EVOCLAW_WEB_UI_TOKEN", "explicit-value");
    expect(getWebUiToken()).toBe("explicit-value");
  });

  it("401/403 给出可读且不含令牌的提示", () => {
    expect(authFailureHint(401)).toContain("WEB_UI_TOKEN");
    expect(authFailureHint(403)).toContain("WEB_UI_TOKEN");
    expect(authFailureHint(200)).toBeNull();
    expect(authFailureHint(401)).not.toContain("abc-123");
  });
});
