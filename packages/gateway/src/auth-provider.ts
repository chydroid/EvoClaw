import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { ServiceRegistry } from "@evoclaw/core";

interface UserPayload {
  userId: string;
  roles: string[];
  type?: "refresh";
}

export class AuthProvider {
  private webUiToken: string;

  constructor(
    private jwtSecret: string,
    private registry: ServiceRegistry
  ) {
    if (!jwtSecret || jwtSecret.length === 0) {
      throw new Error("JWT secret must be a non-empty string. Set JWT_SECRET environment variable or pass it in config.");
    }
    if (jwtSecret.length < 16) {
      process.stderr.write("[AuthProvider] WARNING: JWT secret is shorter than 16 characters. This is insecure for production use.\n");
    }
    this.webUiToken = process.env.WEB_UI_TOKEN || "";
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    // 长度不同时仍执行一次 timingSafeEqual 消耗时间，避免基于长度差异的时序泄露。
    // 对齐 ws-protocol.ts 的 constantTimeEqual 和 webhook-manager.ts 的 safeEqual。
    if (bufA.length !== bufB.length) {
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }

  private getCookie(req: Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    const cookies = header.split(";").reduce<Record<string, string>>((acc, c) => {
      const [k, ...v] = c.trim().split("=");
      if (k) { try { acc[k] = decodeURIComponent(v.join("=")); } catch { acc[k] = v.join("="); } }
      return acc;
    }, {});
    return cookies[name];
  }

  async authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    // ── Public paths that never require authentication ──
    // 安全：/api/chat 不再公开。未认证调用者可借此消耗 LLM 额度、
    // 触发工具执行（潜在 RCE）并读取内部数据。WebUI 必须先通过
    // /api/auth/login 获取 JWT 或配置 WEB_UI_TOKEN cookie 后再调用。
    const publicExactPaths = new Set([
      "/health", "/healthz", "/live", "/ready", "/readyz",
      "/api/health", "/api/auth/login", "/api/auth/register", "/api/auth/refresh",
      "/api/status", "/api/bootstrap", "/api/skills",
      // 技能市场只读端点：search/trending/categories 仅返回 catalog 元数据，
      // 不触及本地技能安装或状态变更，安全可公开。安装端点 /api/marketplace/install
      // 仍需认证，防止未认证攻击者通过安装恶意技能实现 RCE。
      "/api/marketplace/search",
      "/api/marketplace/trending",
      "/api/marketplace/categories",
      "/api/marketplace/debug",
    ]);

    if (publicExactPaths.has(req.path)) {
      return next();
    }

    // ── Public path prefixes (read-only, non-sensitive) ──
    const publicPrefixes = [
      "/api/config/llm",      // LLM config needed for UI bootstrap
      "/api/config/avatars",  // Avatar config needed for UI
      "/api/config/channels", // Channel config needed for UI
      "/api/events",          // SSE event stream (has its own auth via query param)
      "/api/marketplace/skills/", // 技能市场详情只读端点（GET /api/marketplace/skills/:slug/details）
      // 注意：/api/skills 已从此处移除。保留 publicExactPaths 中的 /api/skills
      // 仅允许 GET 列表免认证；所有子路径（install/delete/config/curate 等
      // 状态变更操作）必须认证，否则未认证攻击者可安装恶意技能实现 RCE。
    ];

    if (publicPrefixes.some(p => req.path === p || req.path.startsWith(p + "/"))) {
      return next();
    }

    // ── Static assets and UI pages ──
    // 安全：仅允许 /assets/ 前缀和 /ui 前缀的静态资源免认证。
    // 不再使用宽泛的扩展名正则（含 .json），否则 /api/foo.json 等
    // 动态路由会绕过认证。
    if (req.path === "/" || req.path === "/ui" || req.path.startsWith("/ui/") || req.path.startsWith("/assets/") ||
        (req.path.match(/\.(html|js|css|png|ico|svg)$/) && !req.path.startsWith("/api/"))) {
      return next();
    }

    // ── A2A paths use their own auth (api_key or none based on config) ──
    if (req.path.startsWith("/a2a/") || req.path === "/a2a") {
      return next();
    }

    // ── All other /api/ paths REQUIRE authentication ──
    // Check cookie token first
    const cookieToken = this.getCookie(req, "web_ui_token");
    if (cookieToken && this.safeEqual(cookieToken, this.webUiToken)) {
      return next();
    }

    // Check Bearer token
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const decoded = jwt.verify(token, this.jwtSecret, { algorithms: ["HS256"] }) as UserPayload;
      (req as Request & { user: UserPayload }).user = decoded;
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
    }
  }

  webUiAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.path.startsWith("/api/") || req.path === "/health" || req.path === "/healthz" || req.path === "/live" || req.path === "/ready" || req.path === "/readyz") {
      return next();
    }

    // Allow the SPA HTML page and static assets to load without auth
    // so the React app can render its own login form
    if (req.path === "/" || req.path === "/index.html" || req.path === "/manifest.json" ||
        req.path.startsWith("/assets/") ||
        /\.(png|ico|svg|js|css|txt|map|woff2?)$/.test(req.path)) {
      return next();
    }

    if (!this.webUiToken || this.webUiToken.length === 0) {
      if (process.env.ALLOW_NO_AUTH !== "true") {
        res.status(401).send("Unauthorized: WEB_UI_TOKEN not configured");
        return;
      }
      return next();
    }

    const tokenFromUrl = req.query.token as string;
    const tokenFromCookie = this.getCookie(req, "web_ui_token");

    if (tokenFromUrl && this.safeEqual(tokenFromUrl, this.webUiToken)) {
      res.cookie("web_ui_token", tokenFromUrl, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        maxAge: 24 * 60 * 60 * 1000,
      });
    }

    if (tokenFromUrl && !this.safeEqual(tokenFromUrl, this.webUiToken)) {
      // Only reject if cookie is also invalid
      if (!tokenFromCookie || !this.safeEqual(tokenFromCookie, this.webUiToken)) {
        res.cookie("web_ui_token", "", { maxAge: 0 });
        res.status(401).send("Unauthorized: invalid token");
        return;
      }
      // Cookie is valid, ignore invalid URL token
    }

    // Validate cookie token when no URL token is provided
    if (!tokenFromUrl && tokenFromCookie && !this.safeEqual(tokenFromCookie, this.webUiToken)) {
      res.cookie("web_ui_token", "", { maxAge: 0 });
      res.status(401).send("Unauthorized: invalid token");
      return;
    }

    // Require authentication if token is configured but neither URL nor cookie provides a valid token
    if (!tokenFromUrl && !tokenFromCookie) {
      res.status(401).send("Unauthorized: authentication required");
      return;
    }

    next();
  }

  generateToken(userId: string, roles: string[] = ["user"]): string {
    return jwt.sign({ userId, roles }, this.jwtSecret, { expiresIn: "24h" });
  }

  generateRefreshToken(userId: string, roles: string[] = ["user"]): string {
    // 必须将 roles 写入 refresh token，否则刷新时无法恢复用户角色，
    // 导致管理员刷新后权限被降级为 ["user"]。
    return jwt.sign({ userId, roles, type: "refresh" }, this.jwtSecret, { expiresIn: "7d" });
  }

  verifyToken(token: string): UserPayload {
    // 显式指定算法，纵深防御防止 alg:none 攻击
    return jwt.verify(token, this.jwtSecret, { algorithms: ["HS256"] }) as UserPayload;
  }

  updateSecret(newSecret: string): void {
    this.jwtSecret = newSecret;
  }
}
