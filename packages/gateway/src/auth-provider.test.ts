import { describe, it, expect, beforeEach, vi } from "vitest";
import { AuthProvider } from "./auth-provider";
import { ServiceRegistry } from "@evoclaw/core";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

function mockRequest(overrides: Partial<Request> = {}): Request {
  return {
    path: "/api/reporting/some-protected",
    headers: {},
    query: {},
    ...overrides,
  } as Request;
}

function mockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  return res as Response;
}

const mockNext: NextFunction = vi.fn();

describe("AuthProvider", () => {
  let registry: ServiceRegistry;
  const jwtSecret = "test-jwt-secret-for-testing";

  beforeEach(() => {
    registry = new ServiceRegistry();
    vi.clearAllMocks();
  });

  // ── Token Generation ──────────────────────────────

  it("should generate a valid JWT token", () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const token = auth.generateToken("user-1", ["admin"]);
    expect(token).toBeTruthy();
    const decoded = jwt.verify(token, jwtSecret) as any;
    expect(decoded.userId).toBe("user-1");
    expect(decoded.roles).toEqual(["admin"]);
  });

  it("should generate a refresh token", () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const token = auth.generateRefreshToken("user-1");
    const decoded = jwt.verify(token, jwtSecret) as any;
    expect(decoded.userId).toBe("user-1");
    expect(decoded.type).toBe("refresh");
  });

  it("should verify a valid token", () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const token = auth.generateToken("user-1");
    const decoded = auth.verifyToken(token);
    expect(decoded.userId).toBe("user-1");
  });

  it("should throw on invalid token", () => {
    const auth = new AuthProvider(jwtSecret, registry);
    expect(() => auth.verifyToken("invalid-token")).toThrow();
  });

  it("should update the JWT secret", () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const oldToken = auth.generateToken("user-1");
    auth.updateSecret("new-secret");
    // Old token should now fail
    expect(() => jwt.verify(oldToken, "new-secret")).toThrow();
    // New token should work
    const newToken = auth.generateToken("user-1");
    expect(() => jwt.verify(newToken, "new-secret")).not.toThrow();
  });

  // ── Public Paths ──────────────────────────────────

  it("should allow public health paths without auth", async () => {
    const auth = new AuthProvider(jwtSecret, registry);
    for (const path of ["/health", "/healthz", "/live", "/ready", "/readyz"]) {
      const req = mockRequest({ path });
      const res = mockResponse();
      await auth.authenticate(req, res, mockNext);
      expect(mockNext).toHaveBeenCalled();
      mockNext.mockClear();
    }
  });

  it("should allow public API paths without auth", async () => {
    const auth = new AuthProvider(jwtSecret, registry);
    // 安全修复：/api/chat 不再公开，需要认证才能调用以防止
    // 未认证用户消耗 LLM 额度或触发工具执行
    const publicPaths = [
      "/api/health",
      "/api/auth/login",
      "/api/auth/register",
      "/api/status",
      "/api/skills",
    ];
    for (const path of publicPaths) {
      const req = mockRequest({ path });
      const res = mockResponse();
      await auth.authenticate(req, res, mockNext);
      expect(mockNext).toHaveBeenCalled();
      mockNext.mockClear();
    }
  });

  it("should require auth for /api/chat (RCE/abuse protection)", async () => {
    // 安全修复：/api/chat 必须认证，否则未认证调用者可消耗 LLM 额度、
    // 触发工具执行（潜在 RCE）并读取内部数据
    const auth = new AuthProvider(jwtSecret, registry);
    const req = mockRequest({ path: "/api/chat" });
    const res = mockResponse();
    await auth.authenticate(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should require auth for skills sub-paths (RCE protection)", async () => {
    // 安全修复：/api/skills/install 等状态变更操作必须认证，
    // 否则未认证攻击者可安装恶意技能实现 RCE。
    const auth = new AuthProvider(jwtSecret, registry);
    const req = mockRequest({ path: "/api/skills/install" });
    const res = mockResponse();
    await auth.authenticate(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should allow config sub-paths without auth", async () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const req = mockRequest({ path: "/api/config/llm" });
    const res = mockResponse();
    await auth.authenticate(req, res, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it("should allow static files without auth", async () => {
    const auth = new AuthProvider(jwtSecret, registry);
    for (const path of ["/assets/app.js", "/app.css", "/favicon.ico"]) {
      const req = mockRequest({ path });
      const res = mockResponse();
      await auth.authenticate(req, res, mockNext);
      expect(mockNext).toHaveBeenCalled();
      mockNext.mockClear();
    }
  });

  it("should allow root path without auth", async () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const req = mockRequest({ path: "/" });
    const res = mockResponse();
    await auth.authenticate(req, res, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  // ── Cookie Auth ────────────────────────────────────

  it("should allow request with valid cookie token", async () => {
    process.env.WEB_UI_TOKEN = "cookie-secret";
    const auth = new AuthProvider(jwtSecret, registry);
    const req = mockRequest({
      path: "/api/protected",
      headers: {
        cookie: "web_ui_token=cookie-secret",
      },
    });
    const res = mockResponse();
    await auth.authenticate(req, res, mockNext);
    expect(mockNext).toHaveBeenCalled();
    delete process.env.WEB_UI_TOKEN;
  });

  // ── Bearer Token Auth ──────────────────────────────

  it("should allow request with valid Bearer token", async () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const token = auth.generateToken("user-1");
    const req = mockRequest({
      path: "/api/protected",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    const res = mockResponse();
    await auth.authenticate(req, res, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it("should reject request without auth header", async () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const req = mockRequest({ path: "/api/auth/me" });
    const res = mockResponse();
    await auth.authenticate(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should reject request with invalid Bearer token", async () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const req = mockRequest({
      path: "/api/auth/me",
      headers: { authorization: "Bearer invalid" },
    });
    const res = mockResponse();
    await auth.authenticate(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("should reject malformed auth header", async () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const req = mockRequest({
      path: "/api/auth/me",
      headers: { authorization: "Basic something" },
    });
    const res = mockResponse();
    await auth.authenticate(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  // ── Web UI Middleware ──────────────────────────────

  it("should allow API paths through web UI middleware", () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const req = mockRequest({ path: "/api/something" });
    const res = mockResponse();
    auth.webUiAuthMiddleware(req, res, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it("should allow static assets through web UI middleware", () => {
    const auth = new AuthProvider(jwtSecret, registry);
    const req = mockRequest({ path: "/assets/bundle.js" });
    const res = mockResponse();
    auth.webUiAuthMiddleware(req, res, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });
});