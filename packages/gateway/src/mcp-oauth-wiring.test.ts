/**
 * P5 MCP OAuth 接线测试：
 * - auth-aware fetch：Bearer 注入 + 401 刷新一次重试 + 刷新失败 fail-closed
 * - OAuth 配置形状校验
 * - 跨进程刷新栅栏：两实例只消费一次 refresh token；锁超时 fail-closed
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import {
  createMcpAuthFetch,
  validateMcpOAuthConfig,
  type ExternalMCPServerConfig,
  type McpOAuthTokenProvider,
} from "./mcp-client-transport";
import { createOAuthManager } from "./mcp-oauth-manager";
import { saveToken, getTokenPath, type OAuthTokenStorage } from "./mcp-oauth";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const headerOf = (init: RequestInit | undefined, name: string): string | null =>
  new Headers((init?.headers ?? {}) as ConstructorParameters<typeof Headers>[0]).get(name);

describe("createMcpAuthFetch（P5）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("每个请求注入 Bearer token，并合并静态/请求头", async () => {
    const seen: RequestInit[] = [];
    const baseFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return jsonResponse({ ok: true });
    };
    const provider: McpOAuthTokenProvider = {
      getToken: async () => "access-1",
      refreshToken: async () => null,
    };

    const authFetch = createMcpAuthFetch(provider, { "X-Static": "s" }, baseFetch);
    const res = await authFetch("https://mcp.example.com/tools", {
      method: "POST",
      body: "{}",
      headers: { "X-Req": "r" },
    });

    expect(res.status).toBe(200);
    expect(headerOf(seen[0], "authorization")).toBe("Bearer access-1");
    expect(headerOf(seen[0], "x-static")).toBe("s");
    expect(headerOf(seen[0], "x-req")).toBe("r");
  });

  it("401 时强制刷新一次并重试，重试使用新 token", async () => {
    const seen: RequestInit[] = [];
    const baseFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return seen.length === 1 ? new Response("", { status: 401 }) : jsonResponse({ ok: true });
    };
    const getToken = vi.fn(async () => "old-token");
    const refreshToken = vi.fn(async () => "new-token");
    const authFetch = createMcpAuthFetch({ getToken, refreshToken }, undefined, baseFetch);

    const res = await authFetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" });

    expect(res.status).toBe(200);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(headerOf(seen[0], "authorization")).toBe("Bearer old-token");
    expect(headerOf(seen[1], "authorization")).toBe("Bearer new-token");
  });

  it("刷新失败时返回原始 401（不静默重试）", async () => {
    let calls = 0;
    const baseFetch = async () => {
      calls++;
      return new Response("", { status: 401 });
    };
    const authFetch = createMcpAuthFetch(
      { getToken: async () => "t", refreshToken: async () => null },
      undefined,
      baseFetch,
    );

    const res = await authFetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
  });

  it("流式 body 不重试（避免二次消费）", async () => {
    let calls = 0;
    const baseFetch = async () => {
      calls++;
      return new Response("", { status: 401 });
    };
    const refreshToken = vi.fn(async () => "new");
    const authFetch = createMcpAuthFetch(
      { getToken: async () => "t", refreshToken },
      undefined,
      baseFetch,
    );

    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    // Node 的 fetch 接受 ReadableStream，但类型层面用 unknown 断言绕过 DOM lib 限制
    const res = await authFetch("https://mcp.example.com/mcp", {
      method: "POST",
      body: stream as unknown as RequestInit["body"],
    });
    expect(res.status).toBe(401);
    expect(refreshToken).not.toHaveBeenCalled();
    expect(calls).toBe(1);
  });
});

describe("validateMcpOAuthConfig（P5）", () => {
  const base = (over: Partial<ExternalMCPServerConfig>): ExternalMCPServerConfig => ({
    type: "streamable-http",
    url: "https://mcp.example.com",
    oauth: { enabled: true },
    ...over,
  });

  it("合法 HTTP + oauth 配置通过", () => {
    expect(validateMcpOAuthConfig(base({}))).toEqual([]);
  });

  it("无 oauth 字段直接通过", () => {
    expect(validateMcpOAuthConfig({ type: "stdio", command: "node" })).toEqual([]);
  });

  it("stdio 不接受 oauth", () => {
    const errors = validateMcpOAuthConfig({ type: "stdio", command: "node", oauth: { enabled: true } });
    expect(errors.join("\n")).toContain("only supported for sse / streamable-http");
  });

  it("启用 oauth 但缺 url / url 非法", () => {
    expect(validateMcpOAuthConfig(base({ url: undefined })).join()).toContain("requires config.url");
    expect(validateMcpOAuthConfig(base({ url: "not a url" })).join()).toContain("valid absolute config.url");
  });

  it("scopes / clientId 类型错误", () => {
    const errors = validateMcpOAuthConfig(
      base({ oauth: { enabled: true, scopes: [""], clientId: "" } }),
    );
    expect(errors.length).toBe(2);
  });
});

describe("跨进程刷新栅栏（P5）", () => {
  const serverUrl = "https://mcp.example.com";
  const tempDirs: string[] = [];

  const makeTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-p5-"));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of tempDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  const seedExpiringToken = (dataDir: string): void => {
    const token: OAuthTokenStorage = {
      access_token: "old-access",
      token_type: "Bearer",
      expires_at: Date.now() + 1000, // 在刷新窗口内
      refresh_token: "refresh-1",
      client_id: "client-1",
      server_url: serverUrl,
    };
    saveToken(getTokenPath(dataDir, serverUrl), token);
  };

  it("两实例并发刷新只消费一次 refresh token", async () => {
    const dataDir = makeTempDir();
    seedExpiringToken(dataDir);

    let tokenPosts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/token")) {
        tokenPosts++;
        // 模拟授权服务器：旧 refresh token 只能成功一次
        return jsonResponse({
          access_token: "new-access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-2",
        });
      }
      if (url.includes(".well-known/oauth-authorization-server")) {
        return jsonResponse({ issuer: serverUrl, token_endpoint: `${serverUrl}/token` });
      }
      return new Response("not found", { status: 404 });
    }));

    const a = createOAuthManager(dataDir);
    const b = createOAuthManager(dataDir);
    const [ta, tb] = await Promise.all([a.refresh(serverUrl), b.refresh(serverUrl)]);

    expect(tokenPosts).toBe(1);
    expect(ta?.access_token).toBe("new-access");
    expect(tb?.access_token).toBe("new-access");
  });

  it("锁被活进程占用时超时 fail-closed", async () => {
    const dataDir = makeTempDir();
    seedExpiringToken(dataDir);

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(".well-known/oauth-authorization-server")) {
        return jsonResponse({ issuer: serverUrl, token_endpoint: `${serverUrl}/token` });
      }
      return jsonResponse({ access_token: "should-not-happen" });
    }));

    // 预置一个由当前进程“持有”的锁，模拟另一个实例正在刷新
    const lockDir = path.join(dataDir, "locks");
    fs.mkdirSync(lockDir, { recursive: true });
    const lockName = `mcp-oauth-refresh-${crypto
      .createHash("sha256")
      .update(serverUrl)
      .digest("hex")
      .slice(0, 16)}`;
    fs.writeFileSync(
      path.join(lockDir, `${lockName}.lock`),
      JSON.stringify({ pid: process.pid, token: "held-by-other", acquiredAt: Date.now() }),
    );

    const manager = createOAuthManager(dataDir, { refreshLockTimeoutMs: 250 });
    await expect(manager.refresh(serverUrl)).rejects.toThrow(/refresh lock unavailable/);
  });

  it("token 文件损坏时不崩溃（loadToken 返回 null）", async () => {
    const dataDir = makeTempDir();
    const tokenPath = getTokenPath(dataDir, serverUrl);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, "{ corrupt", "utf-8");

    const manager = createOAuthManager(dataDir);
    await expect(manager.refresh(serverUrl)).resolves.toBeNull();
    expect(manager.getStatus(serverUrl).status).toBe("unauthenticated");
  });
});
