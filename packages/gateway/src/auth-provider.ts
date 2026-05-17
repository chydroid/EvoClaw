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
    const publicPaths = ["/health", "/live", "/ready", "/api/auth/login", "/api/auth/register", "/api/cli/execute"];

    if (publicPaths.includes(req.path)) {
      return next();
    }

    if (req.path === "/" || req.path.startsWith("/assets/") || req.path.match(/\.(html|js|css|png|ico|svg|json)$/)) {
      return next();
    }

    const cookieToken = this.getCookie(req, "web_ui_token");
    if (cookieToken && cookieToken === this.webUiToken && req.method === "GET") {
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
    if (req.path.startsWith("/api/") || req.path === "/health" || req.path === "/live" || req.path === "/ready") {
      return next();
    }

    if (req.path.startsWith("/assets/") || /\.(png|ico|svg|js|css|json|txt|map)$/.test(req.path)) {
      return next();
    }

    if (!this.webUiToken || this.webUiToken.length === 0) {
      return next();
    }

    const token = req.query.token as string || this.getCookie(req, "web_ui_token");

    if (!token) {
      res.status(401).send(`
        <!DOCTYPE html>
        <html>
        <head><title>EcoClaw - Authentication Required</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 100px;">
          <h1>🔐 Authentication Required</h1>
          <p>Please provide a valid token to access the EcoClaw Web UI.</p>
          <form method="GET" action="/">
            <input type="password" name="token" placeholder="Enter token" style="padding: 10px; font-size: 16px;" />
            <button type="submit" style="padding: 10px 20px; font-size: 16px;">Access</button>
          </form>
        </body>
        </html>
      `);
      return;
    }

    if (token !== this.webUiToken) {
      res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head><title>EcoClaw - Access Denied</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 100px;">
          <h1>🚫 Access Denied</h1>
          <p>Invalid token. Please try again.</p>
          <a href="/">Go back</a>
        </body>
        </html>
      `);
      return;
    }

    res.cookie("web_ui_token", token, {
      httpOnly: false,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });
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