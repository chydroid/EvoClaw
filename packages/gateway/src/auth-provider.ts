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
    this.webUiToken = process.env.WEB_UI_TOKEN || "";
  }

  private getCookie(req: Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    const cookies = header.split(";").reduce<Record<string, string>>((acc, c) => {
      const [k, ...v] = c.trim().split("=");
      if (k) acc[k] = decodeURIComponent(v.join("="));
      return acc;
    }, {});
    return cookies[name];
  }

  async authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const publicPaths = ["/health", "/healthz", "/live", "/ready", "/readyz", "/api/health", "/api/auth/login", "/api/auth/register", "/api/cli/execute", "/api/config/llm", "/api/config/avatars", "/api/config/channels", "/api/status", "/api/system/services", "/api/chat", "/api/skills", "/api/skills/refresh", "/api/bootstrap", "/api/events/snapshot", "/api/permission-relay/pending", "/api/permission-relay/history", "/api/crestodian/health", "/api/crestodian/overview", "/api/crestodian/diagnostics", "/api/permission/approve", "/api/permission/deny", "/api/sessions"];

    if (publicPaths.includes(req.path)) {
      return next();
    }

    // Allow all sub-paths under these public API prefixes
    if (req.path.startsWith("/api/skills/") || req.path.startsWith("/api/config/") || req.path.startsWith("/api/bootstrap/") || req.path.startsWith("/api/events") || req.path.startsWith("/api/permission-relay/") || req.path.startsWith("/api/crestodian/") || req.path.startsWith("/api/sessions/") || req.path.startsWith("/api/evolution/") || req.path.startsWith("/api/compactions") || req.path.startsWith("/api/scheduler/") || req.path.startsWith("/api/system/") || req.path.startsWith("/api/channels/") || req.path.startsWith("/api/plugins") || req.path.startsWith("/api/permission/")) {
      return next();
    }

    if (req.path === "/" || req.path.startsWith("/ui") || req.path.startsWith("/assets/") || req.path.match(/\.(html|js|css|png|ico|svg|json)$/)) {
      return next();
    }

    const cookieToken = this.getCookie(req, "web_ui_token");
    if (cookieToken && cookieToken === this.webUiToken) {
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

    if (tokenFromUrl && tokenFromUrl === this.webUiToken) {
      res.cookie("web_ui_token", tokenFromUrl, {
        httpOnly: true,
        sameSite: "strict",
        maxAge: 24 * 60 * 60 * 1000,
      });
    }

    if (tokenFromUrl && tokenFromUrl !== this.webUiToken) {
      res.cookie("web_ui_token", "", { maxAge: 0 });
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
