/**
 * mcp-oauth.test — MCP OAuth 客户端测试（对标 hermes-agent tools/mcp_oauth*.py）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  generatePkceVerifier,
  generatePkceChallenge,
  generateState,
  generateNonce,
  generateClientId,
  loadToken,
  saveToken,
  deleteToken,
  getTokenPath,
  isTokenExpiring,
  isTokenExpired,
  tokenResponseToStorage,
  buildPkceAuthorizationUrl,
  type OAuthServerMetadata,
  type OAuthTokenStorage,
  type TokenResponse,
} from "../src/mcp-oauth";

describe("PKCE 工具", () => {
  it("generatePkceVerifier 生成 URL-safe 字符串（RFC 7636 要求 43-128 字符）", () => {
    const verifier = generatePkceVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toContain("=");
  });

  it("generatePkceVerifier 生成唯一值", () => {
    const v1 = generatePkceVerifier();
    const v2 = generatePkceVerifier();
    expect(v1).not.toBe(v2);
  });

  it("generatePkceChallenge 使用 S256 哈希", () => {
    const verifier = generatePkceVerifier();
    const challenge = generatePkceChallenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain("=");
    expect(challenge).not.toBe(verifier);
  });

  it("generatePkceChallenge 相同输入产生相同输出", () => {
    const verifier = "test-verifier-123";
    expect(generatePkceChallenge(verifier)).toBe(generatePkceChallenge(verifier));
  });

  it("generateState 生成非空字符串", () => {
    const state = generateState();
    expect(state).toBeTruthy();
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generateState 生成唯一值", () => {
    expect(generateState()).not.toBe(generateState());
  });

  it("generateNonce 生成非空字符串", () => {
    const nonce = generateNonce();
    expect(nonce).toBeTruthy();
  });

  it("generateClientId 生成 CIMD URL", () => {
    const id = generateClientId("https://example.com/mcp");
    expect(id).toContain("https://example.com");
    expect(id).toContain("oauth");
  });
});

describe("Token 存储", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch { /* ignore */ }
  });

  it("saveToken + loadToken 往返", () => {
    const tokenPath = path.join(tempDir, "test-token.json");
    const token: OAuthTokenStorage = {
      access_token: "access-123",
      token_type: "Bearer",
      expires_at: Date.now() + 3600000,
      refresh_token: "refresh-456",
      client_id: "client-789",
      server_url: "https://example.com",
    };

    saveToken(tokenPath, token);
    const loaded = loadToken(tokenPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.access_token).toBe("access-123");
    expect(loaded!.refresh_token).toBe("refresh-456");
  });

  it("loadToken 不存在的文件返回 null", () => {
    const result = loadToken(path.join(tempDir, "nonexistent.json"));
    expect(result).toBeNull();
  });

  it("loadToken 无效 JSON 返回 null", () => {
    const badPath = path.join(tempDir, "bad.json");
    fs.writeFileSync(badPath, "not valid json");
    expect(loadToken(badPath)).toBeNull();
  });

  it("loadToken 无 access_token 返回 null", () => {
    const badPath = path.join(tempDir, "no-token.json");
    fs.writeFileSync(badPath, JSON.stringify({ token_type: "Bearer" }));
    expect(loadToken(badPath)).toBeNull();
  });

  it("deleteToken 删除文件", () => {
    const tokenPath = path.join(tempDir, "to-delete.json");
    saveToken(tokenPath, {
      access_token: "x",
      token_type: "Bearer",
    });
    expect(fs.existsSync(tokenPath)).toBe(true);
    deleteToken(tokenPath);
    expect(fs.existsSync(tokenPath)).toBe(false);
  });

  it("deleteToken 不存在的文件不抛异常", () => {
    expect(() => deleteToken(path.join(tempDir, "nope.json"))).not.toThrow();
  });

  it("getTokenPath 生成安全文件名", () => {
    const p = getTokenPath(tempDir, "https://api.example.com/mcp");
    expect(p).toContain(tempDir);
    expect(p).toContain("mcp-oauth");
    expect(fs.existsSync(p)).toBe(false);
  });

  it("getTokenPath 处理特殊字符", () => {
    const p = getTokenPath(tempDir, "https://api.example.com/path?query=1&x=2");
    expect(p).not.toContain("?");
    expect(p).not.toContain("&");
  });

  it("isTokenExpiring 检测即将过期", () => {
    const expiring: OAuthTokenStorage = {
      access_token: "x",
      token_type: "Bearer",
      expires_at: Date.now() + 30000, // 30 秒后过期
    };
    expect(isTokenExpiring(expiring)).toBe(true);

    const fresh: OAuthTokenStorage = {
      access_token: "x",
      token_type: "Bearer",
      expires_at: Date.now() + 3600000, // 1 小时后
    };
    expect(isTokenExpiring(fresh)).toBe(false);
  });

  it("isTokenExpiring 无过期时间返回 false", () => {
    expect(isTokenExpiring({ access_token: "x", token_type: "Bearer" })).toBe(false);
  });

  it("isTokenExpired 检测已过期", () => {
    const expired: OAuthTokenStorage = {
      access_token: "x",
      token_type: "Bearer",
      expires_at: Date.now() - 1000,
    };
    expect(isTokenExpired(expired)).toBe(true);

    const valid: OAuthTokenStorage = {
      access_token: "x",
      token_type: "Bearer",
      expires_at: Date.now() + 3600000,
    };
    expect(isTokenExpired(valid)).toBe(false);
  });

  it("isTokenExpired 无过期时间返回 false", () => {
    expect(isTokenExpired({ access_token: "x", token_type: "Bearer" })).toBe(false);
  });
});

describe("buildPkceAuthorizationUrl", () => {
  const metadata: OAuthServerMetadata = {
    issuer: "https://api.example.com",
    authorization_endpoint: "https://api.example.com/oauth/authorize",
    token_endpoint: "https://api.example.com/oauth/token",
  };

  it("生成包含必需参数的 URL", () => {
    const result = buildPkceAuthorizationUrl(metadata, "client-123", "http://localhost:8080/callback");
    const url = new URL(result.authorizationUrl);

    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8080/callback");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("包含 scope 参数", () => {
    const result = buildPkceAuthorizationUrl(metadata, "client-123", "http://localhost/cb", "read write");
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get("scope")).toBe("read write");
  });

  it("不包含 scope 参数时 URL 无 scope", () => {
    const result = buildPkceAuthorizationUrl(metadata, "client-123", "http://localhost/cb");
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("code_challenge 与 code_verifier 匹配", () => {
    const result = buildPkceAuthorizationUrl(metadata, "client-123", "http://localhost/cb");
    expect(generatePkceChallenge(result.codeVerifier)).toBe(result.codeChallenge);
  });
});

describe("tokenResponseToStorage", () => {
  it("转换完整 TokenResponse", () => {
    const response: TokenResponse = {
      access_token: "access-123",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refresh-456",
      scope: "read write",
    };
    const storage = tokenResponseToStorage(response, "client-789", "https://example.com");
    expect(storage.access_token).toBe("access-123");
    expect(storage.token_type).toBe("Bearer");
    expect(storage.refresh_token).toBe("refresh-456");
    expect(storage.scope).toBe("read write");
    expect(storage.client_id).toBe("client-789");
    expect(storage.server_url).toBe("https://example.com");
    expect(storage.expires_at).toBeGreaterThan(Date.now());
  });

  it("TokenResponse 无 expires_in 时 expires_at 为 undefined", () => {
    const response: TokenResponse = {
      access_token: "access-123",
      token_type: "Bearer",
    };
    const storage = tokenResponseToStorage(response, "client-789", "https://example.com");
    expect(storage.expires_at).toBeUndefined();
  });

  it("TokenResponse 无 refresh_token 时 refresh_token 为 undefined", () => {
    const response: TokenResponse = {
      access_token: "access-123",
      token_type: "Bearer",
      expires_in: 3600,
    };
    const storage = tokenResponseToStorage(response, "client-789", "https://example.com");
    expect(storage.refresh_token).toBeUndefined();
  });

  it("TokenResponse 无 scope 时 scope 为 undefined", () => {
    const response: TokenResponse = {
      access_token: "access-123",
      token_type: "Bearer",
    };
    const storage = tokenResponseToStorage(response, "client-789", "https://example.com");
    expect(storage.scope).toBeUndefined();
  });

  it("TokenResponse 无 token_type 时默认 Bearer", () => {
    const response = { access_token: "access-123" } as TokenResponse;
    const storage = tokenResponseToStorage(response, "client-789", "https://example.com");
    expect(storage.token_type).toBe("Bearer");
  });
});
