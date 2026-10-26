/**
 * mcp-oauth-manager.test — MCP OAuth 管理器测试（对标 hermes-agent tools/mcp_oauth_manager.py）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  McpOAuthManager,
  createOAuthManager,
  generateTestToken,
  ensureSecureDir,
  type OAuthServerState,
} from "../src/mcp-oauth-manager";
import {
  saveToken,
  getTokenPath,
  type OAuthTokenStorage,
} from "../src/mcp-oauth";

describe("McpOAuthManager", () => {
  let tempDir: string;
  let manager: McpOAuthManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-mgr-test-"));
    manager = createOAuthManager(tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch { /* ignore */ }
  });

  describe("getStatus", () => {
    it("无 token 时返回 unauthenticated", () => {
      const status = manager.getStatus("https://api.example.com");
      expect(status.status).toBe("unauthenticated");
      expect(status.hasToken).toBe(false);
      expect(status.hasRefreshToken).toBe(false);
      expect(status.needsRefresh).toBe(false);
    });

    it("有有效 token 时返回 authenticated", () => {
      const serverUrl = "https://api.example.com";
      const tokenPath = getTokenPath(tempDir, serverUrl);
      saveToken(tokenPath, generateTestToken(serverUrl));

      const status = manager.getStatus(serverUrl);
      expect(status.status).toBe("authenticated");
      expect(status.hasToken).toBe(true);
      expect(status.hasRefreshToken).toBe(true);
      expect(status.needsRefresh).toBe(false);
    });

    it("token 即将过期时 needsRefresh 为 true", () => {
      const serverUrl = "https://api.example.com";
      const tokenPath = getTokenPath(tempDir, serverUrl);
      saveToken(tokenPath, {
        access_token: "expired-token",
        token_type: "Bearer",
        expires_at: Date.now() + 30000, // 30 秒后过期
        refresh_token: "refresh-token",
        client_id: "client-id",
        server_url: serverUrl,
      });

      const status = manager.getStatus(serverUrl);
      expect(status.needsRefresh).toBe(true);
    });

    it("token 已过期且无刷新 token 时返回 unauthenticated", () => {
      const serverUrl = "https://api.example.com";
      const tokenPath = getTokenPath(tempDir, serverUrl);
      saveToken(tokenPath, {
        access_token: "expired-token",
        token_type: "Bearer",
        expires_at: Date.now() - 1000,
      });

      const status = manager.getStatus(serverUrl);
      expect(status.status).toBe("unauthenticated");
      expect(status.hasRefreshToken).toBe(false);
    });
  });

  describe("getToken", () => {
    it("无 token 时返回 null", async () => {
      const token = await manager.getToken({ serverUrl: "https://api.example.com", dataDir: tempDir });
      expect(token).toBeNull();
    });

    it("有有效 token 时返回 access_token", async () => {
      const serverUrl = "https://api.example.com";
      const testToken = generateTestToken(serverUrl);
      const tokenPath = getTokenPath(tempDir, serverUrl);
      saveToken(tokenPath, testToken);

      const token = await manager.getToken({ serverUrl, dataDir: tempDir });
      expect(token).toBe(testToken.access_token);
    });

    it("token 已过期且无刷新 token 时返回 null", async () => {
      const serverUrl = "https://api.example.com";
      const tokenPath = getTokenPath(tempDir, serverUrl);
      saveToken(tokenPath, {
        access_token: "expired-token",
        token_type: "Bearer",
        expires_at: Date.now() - 1000,
      });

      const token = await manager.getToken({ serverUrl, dataDir: tempDir });
      expect(token).toBeNull();
    });
  });

  describe("logout", () => {
    it("删除 token 文件并清除缓存", () => {
      const serverUrl = "https://api.example.com";
      const tokenPath = getTokenPath(tempDir, serverUrl);
      saveToken(tokenPath, generateTestToken(serverUrl));

      // 验证 token 存在
      expect(fs.existsSync(tokenPath)).toBe(true);
      manager.getStatus(serverUrl); // 缓存状态

      manager.logout(serverUrl);

      expect(fs.existsSync(tokenPath)).toBe(false);
      const status = manager.getStatus(serverUrl);
      expect(status.status).toBe("unauthenticated");
    });
  });

  describe("clearCache", () => {
    it("清除缓存的状态", () => {
      const serverUrl = "https://api.example.com";
      const tokenPath = getTokenPath(tempDir, serverUrl);
      saveToken(tokenPath, generateTestToken(serverUrl));

      const statusBefore = manager.getStatus(serverUrl);
      expect(statusBefore.status).toBe("authenticated");

      manager.clearCache();

      const statusAfter = manager.getStatus(serverUrl);
      expect(statusAfter.status).toBe("authenticated"); // 重新从磁盘加载
    });
  });
});

describe("generateTestToken", () => {
  it("生成包含随机值的测试 token", () => {
    const token = generateTestToken("https://example.com");
    expect(token.access_token).toContain("test-access-");
    expect(token.refresh_token).toContain("test-refresh-");
    expect(token.token_type).toBe("Bearer");
    expect(token.server_url).toBe("https://example.com");
    expect(token.expires_at).toBeGreaterThan(Date.now());
  });

  it("不同调用生成不同 token", () => {
    const t1 = generateTestToken("https://example.com");
    const t2 = generateTestToken("https://example.com");
    expect(t1.access_token).not.toBe(t2.access_token);
    expect(t1.refresh_token).not.toBe(t2.refresh_token);
  });
});

describe("ensureSecureDir", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-dir-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch { /* ignore */ }
  });

  it("创建 mcp-oauth 子目录", () => {
    ensureSecureDir(tempDir);
    const oauthDir = path.join(tempDir, "mcp-oauth");
    expect(fs.existsSync(oauthDir)).toBe(true);
    expect(fs.statSync(oauthDir).isDirectory()).toBe(true);
  });

  it("目录已存在时不报错", () => {
    ensureSecureDir(tempDir);
    expect(() => ensureSecureDir(tempDir)).not.toThrow();
  });
});
