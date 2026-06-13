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
    const publicPaths = ["/health", "/healthz", "/live", "/ready", "/readyz", "/api/health", "/api/auth/login", "/api/auth/register", "/api/auth/refresh", "/api/cli/execute", "/api/config/llm", "/api/config/avatars", "/api/config/channels", "/api/status", "/api/chat", "/api/skills", "/api/skills/refresh", "/api/bootstrap", "/api/events/snapshot", "/api/permission-relay/pending", "/api/permission-relay/history", "/api/crestodian/health", "/api/crestodian/overview", "/api/crestodian/diagnostics", "/api/sessions"];

    if (publicPaths.includes(req.path)) {
      return next();
    }

    // Allow all sub-paths under these public API prefixes (with or without trailing slash)
    if (
      req.path.startsWith("/api/skills/") || req.path === "/api/skills" ||
      req.path.startsWith("/api/config/") || req.path === "/api/config" ||
      req.path.startsWith("/api/config-rpc") ||
      req.path.startsWith("/api/bootstrap/") || req.path === "/api/bootstrap" ||
      req.path.startsWith("/api/events") ||
      req.path.startsWith("/api/permission-relay/") ||
      req.path.startsWith("/api/crestodian/") ||
      req.path.startsWith("/api/sessions/") || req.path === "/api/sessions" ||
      req.path.startsWith("/api/evolution/") ||
      req.path.startsWith("/api/compactions") ||
      req.path.startsWith("/api/scheduler/") ||
      req.path.startsWith("/api/channels/") ||
      req.path.startsWith("/api/plugins") ||
      req.path.startsWith("/api/retention/") ||
      req.path.startsWith("/api/health/") ||
      req.path.startsWith("/api/models/") ||
      req.path.startsWith("/api/dead-letter-queue/") ||
      req.path.startsWith("/api/message-templates") ||
      req.path.startsWith("/api/reply-refs") ||
      req.path.startsWith("/api/canvas/") ||
      req.path.startsWith("/api/feature-flags") ||
      req.path.startsWith("/api/queue") ||
      req.path.startsWith("/api/agent/") ||
      req.path.startsWith("/api/memory/") || req.path === "/api/memory" ||
      req.path.startsWith("/api/tools") ||
      req.path.startsWith("/api/sandbox/") ||
      req.path.startsWith("/api/reporting/") ||
      req.path.startsWith("/api/system/") ||
      req.path.startsWith("/api/security/") ||
      req.path.startsWith("/api/file/") ||
      req.path.startsWith("/api/logs") ||
      req.path.startsWith("/api/version") ||
      req.path.startsWith("/api/approvals/") ||
      req.path.startsWith("/api/tracing/") ||
      req.path.startsWith("/api/evals/") ||
      req.path === "/api/executions" ||
      req.path.startsWith("/api/executions/") ||
      req.path.startsWith("/a2a/") ||
      req.path === "/a2a"
    ) {
      return next();
    }

    if (req.path === "/" || req.path.startsWith("/ui") || req.path.startsWith("/assets/") || req.path.match(/\.(html|js|css|png|ico|svg|json)$/)) {
      return next();
    }

    // For paths that don't match any known API prefix, skip auth and let
    // the 404 middleware handle them. This avoids returning 401 for routes
    // that simply don't exist, which leaks no information and gives a
    // more accurate response.
    if (req.path.startsWith("/api/") && !req.path.startsWith("/api/auth/")) {
      // Known API prefixes that should require auth if no public match
      const knownApiPrefixes = [
        "/api/chat", "/api/skills", "/api/config", "/api/bootstrap", "/api/events",
        "/api/permission-relay", "/api/crestodian", "/api/sessions", "/api/evolution",
        "/api/compactions", "/api/scheduler", "/api/channels", "/api/plugins",
        "/api/permission", "/api/retention", "/api/health", "/api/models",
        "/api/dead-letter-queue", "/api/message-templates", "/api/reply-refs",
        "/api/canvas", "/api/feature-flags", "/api/queue", "/api/agent",
        "/api/memory", "/api/tools", "/api/sandbox", "/api/reporting",
        "/api/system", "/api/security", "/api/file", "/api/logs", "/api/version",
        "/api/approvals", "/api/tracing", "/api/evals", "/api/executions",
        "/api/steer", "/api/workboard", "/api/mcp", "/api/guardrails",
        "/api/prompt-cache", "/api/acp", "/api/observability", "/api/computed-status",
      ];
      const isKnownApi = knownApiPrefixes.some(p => req.path === p || req.path.startsWith(p + "/"));
      if (!isKnownApi) {
        // Unknown API path — skip auth, let 404 handler deal with it
        return next();
      }
    }

    const cookieToken = this.getCookie(req, "web_ui_token");
    if (cookieToken && this.safeEqual(cookieToken, this.webUiToken)) {
      return next();
    }

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

    if (req.path.startsWith("/assets/") || /\.(png|ico|svg|js|css|json|txt|map|woff2?)$/.test(req.path)) {
      return next();
    }

    if (!this.webUiToken || this.webUiToken.length === 0) {
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
