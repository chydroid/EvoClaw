import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { ServiceRegistry } from "@evoclaw/core";

interface UserPayload {
  userId: string;
  roles: string[];
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
      console.warn("[AuthProvider] WARNING: JWT secret is shorter than 16 characters. This is insecure for production use.");
    }
    this.webUiToken = process.env.WEB_UI_TOKEN || "";
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
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
    const publicExactPaths = new Set([
      "/health", "/healthz", "/live", "/ready", "/readyz",
      "/api/health", "/api/auth/login", "/api/auth/register", "/api/auth/refresh",
      "/api/status", "/api/bootstrap", "/api/skills", "/api/chat",
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
      "/api/skills",          // Skills sub-paths (install, list, etc.)
    ];

    if (publicPrefixes.some(p => req.path === p || req.path.startsWith(p + "/"))) {
      return next();
    }

    // ── Static assets and UI pages ──
    if (req.path === "/" || req.path.startsWith("/ui") || req.path.startsWith("/assets/") || req.path.match(/\.(html|js|css|png|ico|svg|json)$/)) {
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
      const decoded = jwt.verify(token, this.jwtSecret) as UserPayload;
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
    if (req.path === "/" || req.path === "/index.html" || req.path.startsWith("/assets/") || /\.(png|ico|svg|js|css|json|txt|map|woff2?)$/.test(req.path)) {
      return next();
    }

    if (!this.webUiToken || this.webUiToken.length === 0) {
      if (process.env.NODE_ENV === "production") {
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

  generateRefreshToken(userId: string): string {
    return jwt.sign({ userId, type: "refresh" }, this.jwtSecret, { expiresIn: "7d" });
  }

  verifyToken(token: string): UserPayload {
    return jwt.verify(token, this.jwtSecret) as UserPayload;
  }

  updateSecret(newSecret: string): void {
    this.jwtSecret = newSecret;
  }
}
