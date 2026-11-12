/**
 * P5 MCP OAuth 路由测试：status / authenticate（失败路径）/ logout。
 * 不连接真实 MCP server（enableMCP=false），只验证路由与 token 状态面。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { GatewayServer } from "./gateway-server";
import { getTokenPath, saveToken } from "./mcp-oauth";
import type { AddressInfo } from "net";

describe("GatewayServer — MCP OAuth routes（P5）", () => {
  let tmpDir: string;
  let gateway: GatewayServer;
  let port = 0;
  let token = "";
  let oauthStub: http.Server | null = null;

  const serverUrl = "https://mcp.example.com";

  const baseUrl = (): string => `http://127.0.0.1:${port}`;
  const authed = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  const writeMcpConfig = (extra: Record<string, unknown> = {}): void => {
    fs.writeFileSync(
      path.join(tmpDir, "mcp-servers.json"),
      JSON.stringify({
        mcpServers: {
          oauth1: {
            type: "streamable-http",
            url: serverUrl,
            oauth: { enabled: true, scopes: ["tools.read"] },
          },
          stdio1: { type: "stdio", command: "node" },
          ...extra,
        },
      }),
      "utf-8",
    );
  };

  const startGateway = async (): Promise<void> => {
    gateway = new GatewayServer(new ServiceRegistry(), new EventBus());
    gateway.initMigrations(tmpDir, "0.0.0");
    gateway.configure({
      port: 0,
      host: "127.0.0.1",
      enableWS: false,
      enableMCP: false,
      shutdownTimeoutMs: 2000,
    });
    await gateway.start();
    const address = (gateway as unknown as { server: http.Server }).server.address() as AddressInfo;
    port = address.port;
    token = (gateway as unknown as { authProvider: { generateToken(u: string, r: string[]): string } })
      .authProvider.generateToken("test-user", ["admin"]);
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-routes-"));
    writeMcpConfig();
    await startGateway();
  });

  afterEach(async () => {
    await gateway.stop();
    if (oauthStub) {
      await new Promise<void>((resolve) => oauthStub!.close(() => resolve()));
      oauthStub = null;
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("GET status：未知 server 404；stdio 404", async () => {
    const missing = await fetch(`${baseUrl()}/api/mcp-oauth/nope/status`, { headers: authed() });
    expect(missing.status).toBe(404);

    const stdio = await fetch(`${baseUrl()}/api/mcp-oauth/stdio1/status`, { headers: authed() });
    expect(stdio.status).toBe(404);
  });

  it("GET status：无 token → unauthenticated，且不泄露 token 内容", async () => {
    const res = await fetch(`${baseUrl()}/api/mcp-oauth/oauth1/status`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      server: "oauth1",
      enabled: true,
      status: "unauthenticated",
      hasToken: false,
      hasRefreshToken: false,
    });
    expect(JSON.stringify(body)).not.toContain("access_token");
  });

  it("GET status：已有 token → authenticated", async () => {
    saveToken(getTokenPath(tmpDir, serverUrl), {
      access_token: "secret-access",
      token_type: "Bearer",
      expires_at: Date.now() + 3600_000,
      refresh_token: "secret-refresh",
      client_id: "cid",
      server_url: serverUrl,
    });

    const res = await fetch(`${baseUrl()}/api/mcp-oauth/oauth1/status`, { headers: authed() });
    const body = await res.json();
    expect(body.status).toBe("authenticated");
    expect(body.hasToken).toBe(true);
    expect(body.hasRefreshToken).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret-access");
    expect(JSON.stringify(body)).not.toContain("secret-refresh");
  });

  it("POST logout：删除 token，后续 status 回到 unauthenticated", async () => {
    const tokenPath = getTokenPath(tmpDir, serverUrl);
    saveToken(tokenPath, {
      access_token: "a",
      token_type: "Bearer",
      expires_at: Date.now() + 3600_000,
      refresh_token: "r",
      client_id: "cid",
      server_url: serverUrl,
    });

    const res = await fetch(`${baseUrl()}/api/mcp-oauth/oauth1/logout`, {
      method: "POST",
      headers: authed(),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(tokenPath)).toBe(false);

    const status = await fetch(`${baseUrl()}/api/mcp-oauth/oauth1/status`, { headers: authed() });
    const body = await status.json();
    expect(body.status).toBe("unauthenticated");
  });

  it("POST authenticate：metadata 发现失败 → 502（fail-closed，不返回假成功）", async () => {
    // 本地返回 404 的“OAuth 服务器”
    oauthStub = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end("nope");
    });
    await new Promise<void>((resolve) => oauthStub!.listen(0, "127.0.0.1", () => resolve()));
    const stubPort = (oauthStub.address() as AddressInfo).port;
    writeMcpConfig({
      oauth1: {
        type: "streamable-http",
        url: `http://127.0.0.1:${stubPort}`,
        oauth: { enabled: true },
      },
    });

    const res = await fetch(`${baseUrl()}/api/mcp-oauth/oauth1/authenticate`, {
      method: "POST",
      headers: { ...authed(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("OAuth flow failed");
  });

  it("路由需要鉴权（未带 token 返回 401）", async () => {
    const res = await fetch(`${baseUrl()}/api/mcp-oauth/oauth1/status`);
    expect(res.status).toBe(401);
  });
});
