import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { ServiceRegistry } from "@evoclaw/core";

interface UserPayload {
  userId: string;
  roles: string[];
}

export class AuthProvider {
  constructor(
    private jwtSecret: string,
    private registry: ServiceRegistry
  ) {}

  async authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const publicPaths = ["/health", "/live", "/ready", "/api/auth/login", "/api/auth/register", "/api/cli/execute"];

    if (publicPaths.includes(req.path)) {
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