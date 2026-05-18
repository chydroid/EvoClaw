import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { AuthProvider } from "./auth-provider";
import { ProtocolAdapter } from "./protocol-adapter";
import { MCPGateway } from "./mcp-gateway";

export interface GatewayConfig {
  port: number;
  host: string;
  corsOrigins: string[];
  jwtSecret: string;
  enableMCP: boolean;
  enableREST: boolean;
  rateLimitWindow: number;
  rateLimitMax: number;
}

const DEFAULT_CORS_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:5173").split(",").map((s) => s.trim());
const DEFAULT_PORT = parseInt(process.env.ECOCLAW_PORT || "3000", 10);
const DEFAULT_HOST = process.env.ECOCLAW_HOST || "0.0.0.0";

export class GatewayServer {
  private app: Express;
  private server: http.Server | null = null;
  private config: GatewayConfig;
  private authProvider: AuthProvider;
  private protocolAdapter: ProtocolAdapter;
  private mcpGateway: MCPGateway;
  private requestCounts: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.app = express();
    this.config = {
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      corsOrigins: DEFAULT_CORS_ORIGINS,
      jwtSecret: process.env.JWT_SECRET || "evoclaw-dev-secret",
      enableMCP: true,
      enableREST: true,
      rateLimitWindow: 60000,
      rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || "100", 10),
    };

    this.authProvider = new AuthProvider(this.config.jwtSecret, registry);
    this.registry.registerService("authProvider", this.authProvider);
    this.protocolAdapter = new ProtocolAdapter(registry, eventBus);
    this.mcpGateway = new MCPGateway(registry, eventBus);
  }

  configure(config: Partial<GatewayConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.jwtSecret) {
      this.authProvider.updateSecret(config.jwtSecret);
    }
  }

  loadPersistedConfig(): void {
    this.protocolAdapter.loadPersistedConfig();
  }

  async start(): Promise<void> {
    this.setupMiddleware();
    this.setupRoutes();

    if (this.config.enableMCP) {
      this.mcpGateway.initialize();
    }

    const { port, host } = this.config;
    this.server = this.app.listen(port, host, () => {
      console.log(`[Gateway] EcoClaw Gateway listening on http://${host}:${port}`);
      this.eventBus.publish("system.ready", { port, host }, "gateway").catch((err) => { console.debug("[Gateway] Event publish error:", err); });
    });
  }

  async stop(): Promise<void> {
    console.log("[Gateway] Shutting down...");
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.log("[Gateway] Force closing after timeout");
          resolve();
        }, 10000);

        this.server!.close((err) => {
          clearTimeout(timeout);
          if (err) {
            console.error("[Gateway] Error during close:", err.message);
            reject(err);
          } else {
            console.log("[Gateway] All connections closed gracefully");
            resolve();
          }
        });
      });
      this.server = null;
    }
  }

  private setupMiddleware(): void {
    this.app.use(cors({ origin: this.config.corsOrigins, credentials: true }));
    this.app.use(express.json({ limit: "10mb" }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(this.requestLogger.bind(this));
    this.app.use(this.rateLimiter.bind(this));
    this.app.use(this.authProvider.authenticate.bind(this.authProvider));
  }

  private rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    this.cleanupRateLimitEntries(now);

    const entry = this.requestCounts.get(key);

    if (!entry || now > entry.resetAt) {
      this.requestCounts.set(key, { count: 1, resetAt: now + this.config.rateLimitWindow });
      next();
      return;
    }

    if (entry.count >= this.config.rateLimitMax) {
      res.status(429).json({ error: "Too Many Requests", retryAfter: Math.ceil((entry.resetAt - now) / 1000) });
      return;
    }

    entry.count++;
    next();
  }

  private cleanupRateLimitEntries(now: number): void {
    for (const [key, entry] of this.requestCounts) {
      if (now > entry.resetAt) {
        this.requestCounts.delete(key);
      }
    }
  }

  private setupRoutes(): void {
    this.app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "ok",
        version: "0.2.0",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });

    this.app.get("/api/health", (_req: Request, res: Response) => {
      res.json({
        status: "ok",
        version: "0.2.0",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });

    this.app.get("/live", (_req: Request, res: Response) => {
      res.status(200).json({ status: "alive" });
    });

    this.app.get("/ready", (_req: Request, res: Response) => {
      const serviceInfos = this.registry.getAllServiceInfos?.() || [];
      const unhealthyServices = serviceInfos.filter(
        (info) => info.status === "error"
      );
      if (unhealthyServices.length > 0) {
        res.status(503).json({ status: "not ready", unhealthyServices: unhealthyServices.map((s) => s.name) });
      } else {
        res.json({ status: "ready", services: serviceInfos.length });
      }
    });

    if (this.config.enableREST) {
      this.protocolAdapter.mountREST(this.app);
    }

    this.setupWebUI();

    this.app.use(this.errorHandler.bind(this));
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: "Not Found" });
    });
  }

  private setupWebUI(): void {
    const webUiPath = path.resolve(__dirname, "..", "..", "..", "packages", "web-ui", "dist");

    this.app.use(this.authProvider.webUiAuthMiddleware.bind(this.authProvider));
    this.app.use(express.static(webUiPath));
    this.app.get(/^(?!\/api\/|\/health|\/live|\/ready).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(webUiPath, "index.html"));
    });
  }

  private requestLogger(req: Request, _res: Response, next: NextFunction): void {
    console.log(`[Gateway] ${req.method} ${req.path}`);
    next();
  }

  private errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
    console.error("[Gateway] Error:", err.message);
    const isProduction = process.env.NODE_ENV === "production";
    res.status(500).json({
      error: "Internal Server Error",
      ...(isProduction ? {} : { message: err.message }),
    });
  }

  getApp(): Express {
    return this.app;
  }
}