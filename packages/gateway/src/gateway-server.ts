import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import type { Observability } from "@evoclaw/infrastructure";
import { AuthProvider } from "./auth-provider";
import { ProtocolAdapter } from "./protocol-adapter";
import { MCPGateway } from "./mcp-gateway";
import { ProtocolHandler } from "./ws-protocol";
import { WSServerTransport } from "./ws-server-transport";

export interface GatewayConfig {
  port: number;
  host: string;
  corsOrigins: string[];
  jwtSecret: string;
  enableMCP: boolean;
  enableREST: boolean;
  enableWS: boolean;
  rateLimitWindow: number;
  rateLimitMax: number;
}

const DEFAULT_CORS_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:5173").split(",").map((s) => s.trim());
const DEFAULT_PORT = parseInt(process.env.EvoClaw_PORT || "3000", 10);
const DEFAULT_HOST = process.env.EvoClaw_HOST || "0.0.0.0";

export class GatewayServer {
  private app: Express;
  private server: http.Server | null = null;
  private config: GatewayConfig;
  private authProvider: AuthProvider;
  private protocolAdapter: ProtocolAdapter;
  private mcpGateway: MCPGateway;
  private protocolHandler: ProtocolHandler;
  private wsTransport: WSServerTransport | null = null;
  private requestCounts: Map<string, { count: number; resetAt: number }> = new Map();
  private avatarConfig: { user: string; bot: string; userNickname: string; botNickname: string } = {
    user: "assets/images/user.png",
    bot: "assets/images/favicon-32x32.png",
    userNickname: "Me",
    botNickname: "EvoClaw",
  };

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.app = express();
    this.config = {
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      corsOrigins: DEFAULT_CORS_ORIGINS,
      jwtSecret: process.env.JWT_SECRET || "",
      enableMCP: true,
      enableREST: true,
      enableWS: true,
      rateLimitWindow: 60000,
      rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || "100", 10),
    };

    if (!this.config.jwtSecret || this.config.jwtSecret.length === 0) {
      console.warn("[Gateway] WARNING: JWT secret is not set. Authentication will not work properly. Please set JWT_SECRET environment variable.");
    }

    this.authProvider = new AuthProvider(this.config.jwtSecret, registry);
    this.registry.registerService("authProvider", this.authProvider);
    this.protocolAdapter = new ProtocolAdapter(registry, eventBus);
    this.mcpGateway = new MCPGateway(registry, eventBus);

    this.protocolHandler = new ProtocolHandler({
      serverVersion: "0.4.0",
      authToken: this.config.jwtSecret,
      autoApproveLoopback: true,
    });
    this.protocolHandler.setEventBus(eventBus);

    this.registerWSMethodHandlers();
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
      console.log(`[Gateway] EvoClaw Gateway listening on http://${host}:${port}`);

      if (this.server) {
        this.server.requestTimeout = 1_800_000;
        this.server.headersTimeout = 120_000;
        this.server.keepAliveTimeout = 30_000;
        console.log(`[Gateway] Server timeouts: request=${this.server.requestTimeout}ms, headers=${this.server.headersTimeout}ms`);
      }

      if (this.config.enableWS && this.server) {
        this.wsTransport = new WSServerTransport(this.protocolHandler, this.eventBus);
        this.wsTransport.attach(this.server);
        console.log(`[Gateway] WebSocket server listening at ws://${host}:${port}/ws`);
      }

      this.eventBus.publish("system.ready", { port, host }, "gateway").catch((err) => { console.debug("[Gateway] Event publish error:", err); });
    });
  }

  async stop(): Promise<void> {
    console.log("[Gateway] Shutting down...");

    if (this.wsTransport) {
      this.wsTransport.detach();
      this.wsTransport = null;
    }

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

    // Handle JSON parse errors gracefully
    this.app.use((err: any, _req: Request, res: Response, next: NextFunction): void => {
      if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
        res.status(400).json({ error: "Invalid JSON in request body" });
        return;
      }
      next(err);
    });

    this.app.get("/metrics", (_req: Request, res: Response) => {
      const observability = this.registry.resolveService<Observability>("observability");
      if (!observability) {
        res.status(503).set("Content-Type", "text/plain").send("observability service unavailable");
        return;
      }
      res.status(200).set("Content-Type", "text/plain; version=0.0.4; charset=utf-8").send(observability.exportPrometheus());
    });

    this.app.use(this.requestLogger.bind(this));
    this.app.use(this.rateLimiter.bind(this));
    this.app.use(this.authProvider.authenticate.bind(this.authProvider));
  }

  private rateLimiter(req: Request, res: Response, next: NextFunction): void {
    // Bypass rate limiting for health checks — they must always respond
    const healthPaths = ["/healthz", "/live", "/readyz", "/ready", "/health", "/api/health"];
    if (healthPaths.includes(req.path)) {
      next();
      return;
    }

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

  private registerWSMethodHandlers(): void {
    this.protocolHandler.registerMethod("health", async () => {
      return { status: "ok", timestamp: new Date().toISOString() };
    });

    this.protocolHandler.registerMethod("status", async () => {
      return {
        uptime: process.uptime(),
        wsConnections: this.wsTransport?.getConnectedCount() ?? 0,
        protocolConnections: this.protocolHandler.getConnectionCount(),
        memory: process.memoryUsage(),
      };
    });

    this.protocolHandler.registerMethod("channels.list", async () => {
      const channelManager = this.registry.resolveService<{
        getChannelStatuses(): Array<{ type: string; enabled: boolean; connected: boolean }>;
      }>("channelManager");
      if (!channelManager) return { channels: [] };
      return { channels: channelManager.getChannelStatuses() };
    });

    this.protocolHandler.registerMethod("channels.status", async () => {
      const channelManager = this.registry.resolveService<{
        getChannelStatuses(): Array<{ type: string; enabled: boolean; connected: boolean }>;
      }>("channelManager");
      if (!channelManager) return { channels: [] };
      return { channels: channelManager.getChannelStatuses() };
    });

    this.protocolHandler.registerMethod("config.get", async (params) => {
      const key = params.key as string | undefined;
      return { key: key ?? "*", value: "config retrieval via WebSocket" };
    });

    this.protocolHandler.registerMethod("sessions.list", async () => {
      const sessionManager = this.registry.resolveService<{
        listSessions(): Array<{ id: string; status: string; createdAt: Date }>;
      }>("sessionManager");
      if (!sessionManager) return { sessions: [] };
      return { sessions: sessionManager.listSessions() };
    });

    this.protocolHandler.registerMethod("plugins.list", async () => {
      const pluginSystem = this.registry.resolveService<{
        listPlugins(): Array<{ id: string; name: string; enabled: boolean }>;
      }>("pluginSystem");
      if (!pluginSystem) return { plugins: [] };
      return { plugins: pluginSystem.listPlugins() };
    });

    this.protocolHandler.registerMethod("cron.list", async () => {
      const scheduleManager = this.registry.resolveService<{
        listTasks(): Array<{ id: string; name: string; enabled: boolean; cronExpression: string }>;
      }>("scheduleManager");
      if (!scheduleManager) return { tasks: [] };
      return { tasks: scheduleManager.listTasks() };
    });

    this.protocolHandler.registerMethod("agent", async (params, client) => {
      const agentExecutor = this.registry.resolveService<{
        execute(message: string, sessionId?: string): Promise<string>;
      }>("agentModelExecutor");
      if (!agentExecutor) {
        throw new Error("Agent executor not available");
      }
      const message = params.message as string;
      if (!message || typeof message !== "string") {
        throw new Error("message parameter is required");
      }
      const result = await agentExecutor.execute(message, params.sessionId as string | undefined);
      return { response: result };
    });

    this.protocolHandler.registerMethod("message.send", async (params) => {
      const channelManager = this.registry.resolveService<{
        sendMessage(channelType: string, target: string, text: string): Promise<unknown>;
      }>("channelManager");
      if (!channelManager) {
        throw new Error("Channel manager not available");
      }
      const { channel, target, text } = params as { channel: string; target: string; text: string };
      if (!channel || !target || !text) {
        throw new Error("channel, target, and text are required");
      }
      const result = await channelManager.sendMessage(channel, target, text);
      return { delivered: true, result };
    });
  }

  private setupRoutes(): void {
    // ── Health Probes (K8s-compatible, public, no auth required) ──

    // Liveness: process is alive (minimal check)
    this.app.get("/healthz", (_req: Request, res: Response) => {
      res.status(200).set("Content-Type", "text/plain").send("ok");
    });

    this.app.get("/live", (_req: Request, res: Response) => {
      res.status(200).json({ status: "alive", uptime: process.uptime() });
    });

    // Readiness: all critical services are healthy
    this.app.get("/readyz", (_req: Request, res: Response) => {
      const serviceInfos = this.registry.getAllServiceInfos?.() || [];
      const unhealthy = serviceInfos.filter((info: { status: string }) => info.status === "error");
      if (unhealthy.length > 0) {
        res.status(503).json({
          status: "not_ready",
          unhealthy: unhealthy.map((s: { name: string }) => s.name),
        });
      } else {
        res.status(200).set("Content-Type", "text/plain").send("ready");
      }
    });

    this.app.get("/ready", (_req: Request, res: Response) => {
      const serviceInfos = this.registry.getAllServiceInfos?.() || [];
      const unhealthyServices = serviceInfos.filter(
        (info: { status: string }) => info.status === "error"
      );
      if (unhealthyServices.length > 0) {
        res.status(503).json({ status: "not ready", unhealthyServices: unhealthyServices.map((s: { name: string }) => s.name) });
      } else {
        res.json({ status: "ready", services: serviceInfos.length });
      }
    });

    // Detailed health with version + metrics
    this.app.get("/health", (_req: Request, res: Response) => {
      const serviceInfos = this.registry.getAllServiceInfos?.() || [];
      const unhealthy = serviceInfos.filter((info: { status: string }) => info.status === "error");
      const memUsage = process.memoryUsage();
      res.json({
        status: unhealthy.length > 0 ? "degraded" : "ok",
        version: "0.4.0",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        memory: {
          rss: Math.round(memUsage.rss / 1024 / 1024) + "MB",
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + "MB",
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + "MB",
        },
        services: {
          total: serviceInfos.length,
          healthy: serviceInfos.length - unhealthy.length,
          unhealthy: unhealthy.map((s: { name: string }) => s.name),
        },
      });
    });

    this.app.get("/api/health", (_req: Request, res: Response) => {
      const serviceInfos = this.registry.getAllServiceInfos?.() || [];
      res.json({
        status: "ok",
        version: "0.4.0",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        serviceCount: serviceInfos.length,
      });
    });

    this.app.get("/api/config/avatars", (_req: Request, res: Response) => {
      res.json({ avatars: this.avatarConfig });
    });

    this.app.put("/api/config/avatars", (req: Request, res: Response) => {
      const { avatars } = req.body as { avatars?: { user?: string; bot?: string; userNickname?: string; botNickname?: string } };
      if (avatars) {
        this.avatarConfig = { ...this.avatarConfig, ...avatars };
      }
      res.json({ avatars: this.avatarConfig });
    });

    if (this.config.enableREST) {
      this.protocolAdapter.mountREST(this.app);
    }

    this.setupApprovalRoutes();

    this.setupA2ARoutes();

    this.setupWebUI();

    this.app.use(this.errorHandler.bind(this));
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: "Not Found" });
    });
  }

  private setupApprovalRoutes(): void {
    // GET /api/approvals/pending — list all pending approvals
    this.app.get("/api/approvals/pending", (req: Request, res: Response) => {
      const agentExecutor = this.registry.resolveService<{
        getPendingApprovals(sessionId?: string): Array<{
          id: string; sessionId: string; toolName: string; toolArgs: Record<string, unknown>;
          riskLevel: string; reason: string; createdAt: number; requestedBy: string; status: string;
        }>;
        getHumanApprovalManager(): { getConfig(): { riskLevels: Record<string, string>; requireApproval: Record<string, boolean>; approvalTimeout: number; maxPendingPerSession: number }; getTrustRules(): Array<{ toolName: string; trustedBy: string; createdAt: number; expiresAt: number }> } | null;
      }>("agentModelExecutor");

      if (!agentExecutor) {
        res.status(503).json({ error: "Agent executor not available" });
        return;
      }

      const sessionId = req.query.sessionId as string | undefined;
      const pending = agentExecutor.getPendingApprovals(sessionId);
      res.json({ pending, count: pending.length });
    });

    // POST /api/approvals/:id/approve — approve an operation
    this.app.post("/api/approvals/:id/approve", (req: Request, res: Response) => {
      const agentExecutor = this.registry.resolveService<{
        approveOperation(approvalId: string, decidedBy: string, trustFuture?: boolean, modifiedArgs?: Record<string, unknown>): boolean;
      }>("agentModelExecutor");

      if (!agentExecutor) {
        res.status(503).json({ error: "Agent executor not available" });
        return;
      }

      const { id } = req.params as { id: string };
      const { decidedBy, trustFuture, modifiedArgs } = req.body as {
        decidedBy?: string;
        trustFuture?: boolean;
        modifiedArgs?: Record<string, unknown>;
      };

      const success = agentExecutor.approveOperation(
        id,
        decidedBy || "api-user",
        trustFuture,
        modifiedArgs,
      );

      if (success) {
        res.json({ success: true, approvalId: id, decision: "approved" });
      } else {
        res.status(404).json({ error: "Approval not found or already processed", approvalId: id });
      }
    });

    // POST /api/approvals/:id/reject — reject an operation
    this.app.post("/api/approvals/:id/reject", (req: Request, res: Response) => {
      const agentExecutor = this.registry.resolveService<{
        rejectOperation(approvalId: string, decidedBy: string, reason?: string): boolean;
      }>("agentModelExecutor");

      if (!agentExecutor) {
        res.status(503).json({ error: "Agent executor not available" });
        return;
      }

      const { id } = req.params as { id: string };
      const { decidedBy, reason } = req.body as {
        decidedBy?: string;
        reason?: string;
      };

      const success = agentExecutor.rejectOperation(
        id,
        decidedBy || "api-user",
        reason,
      );

      if (success) {
        res.json({ success: true, approvalId: id, decision: "rejected" });
      } else {
        res.status(404).json({ error: "Approval not found or already processed", approvalId: id });
      }
    });

    // GET /api/approvals/config — get approval configuration
    this.app.get("/api/approvals/config", (_req: Request, res: Response) => {
      const agentExecutor = this.registry.resolveService<{
        getHumanApprovalManager(): {
          getConfig(): {
            riskLevels: Record<string, string>;
            requireApproval: Record<string, boolean>;
            approvalTimeout: number;
            maxPendingPerSession: number;
          };
          getTrustRules(): Array<{
            toolName: string;
            trustedBy: string;
            createdAt: number;
            expiresAt: number;
          }>;
        } | null;
      }>("agentModelExecutor");

      if (!agentExecutor) {
        res.status(503).json({ error: "Agent executor not available" });
        return;
      }

      const manager = agentExecutor.getHumanApprovalManager();
      if (!manager) {
        res.json({ enabled: false, message: "Human approval system is not enabled" });
        return;
      }

      const config = manager.getConfig();
      const trustRules = manager.getTrustRules();
      res.json({ enabled: true, config, trustRules });
    });

    // PUT /api/approvals/config — update approval configuration
    this.app.put("/api/approvals/config", (req: Request, res: Response) => {
      const agentExecutor = this.registry.resolveService<{
        getHumanApprovalManager(): {
          updateConfig(config: Record<string, unknown>): void;
          addTrustRule(rule: { toolName: string; trustedBy: string; createdAt: number; expiresAt: number }): void;
          removeTrustRule(toolName: string): void;
        } | null;
      }>("agentModelExecutor");

      if (!agentExecutor) {
        res.status(503).json({ error: "Agent executor not available" });
        return;
      }

      const manager = agentExecutor.getHumanApprovalManager();
      if (!manager) {
        res.status(400).json({ error: "Human approval system is not enabled" });
        return;
      }

      const { config, addTrust, removeTrust } = req.body as {
        config?: Record<string, unknown>;
        addTrust?: { toolName: string; expiresAt?: number };
        removeTrust?: string;
      };

      if (config) {
        manager.updateConfig(config);
      }
      if (addTrust) {
        manager.addTrustRule({
          toolName: addTrust.toolName,
          trustedBy: "api-user",
          createdAt: Date.now(),
          expiresAt: addTrust.expiresAt ?? 0,
        });
      }
      if (removeTrust) {
        manager.removeTrustRule(removeTrust);
      }

      res.json({ success: true });
    });
  }

  private setupA2ARoutes(): void {
    // GET /a2a/card — return this agent's A2A agent card
    this.app.get("/a2a/card", (_req: Request, res: Response) => {
      const a2aServer = this.registry.resolveService<{
        getAgentCard(): { name: string; description: string; url: string; version: string; capabilities: Array<{ id: string; name: string; description: string; inputSchema: Record<string, unknown> }>; authentication?: { type: string } };
        isEnabled(): boolean;
      }>("a2aServer");

      if (!a2aServer || !a2aServer.isEnabled()) {
        res.status(503).json({ error: "A2A server not enabled" });
        return;
      }

      res.json(a2aServer.getAgentCard());
    });

    // POST /a2a/task — handle an incoming A2A task
    this.app.post("/a2a/task", async (req: Request, res: Response) => {
      const a2aServer = this.registry.resolveService<{
        isEnabled(): boolean;
        validateAuth(apiKey?: string): boolean;
        handleTask(task: { id: string; capabilityId: string; input: unknown; metadata?: Record<string, unknown> }): Promise<{ taskId: string; status: string; output?: unknown; error?: string; durationMs?: number }>;
      }>("a2aServer");

      if (!a2aServer || !a2aServer.isEnabled()) {
        res.status(503).json({ error: "A2A server not enabled" });
        return;
      }

      // Validate authentication
      const authHeader = req.headers["authorization"] as string | undefined;
      const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
      if (!a2aServer.validateAuth(apiKey)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const task = req.body as { id?: string; capabilityId?: string; input?: unknown };
      if (!task.id || !task.capabilityId) {
        res.status(400).json({ error: "Missing required fields: id, capabilityId" });
        return;
      }

      try {
        const result = await a2aServer.handleTask(task as { id: string; capabilityId: string; input: unknown; metadata?: Record<string, unknown> });
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /a2a/agents — list known remote agents (from the A2A client)
    this.app.get("/a2a/agents", (_req: Request, res: Response) => {
      const a2aClient = this.registry.resolveService<{
        listAgents(): Array<{ name: string; description: string; url: string; version: string }>;
      }>("a2aClient");

      if (!a2aClient) {
        res.json({ agents: [] });
        return;
      }

      res.json({ agents: a2aClient.listAgents() });
    });
  }

  private setupWebUI(): void {
    const webUiPath = path.resolve(__dirname, "..", "..", "..", "packages", "web-ui", "dist");
    const userAssetsPath = path.resolve(__dirname, "..", "..", "..", "assets", "images");

    this.app.use(this.authProvider.webUiAuthMiddleware.bind(this.authProvider));
    this.app.use(express.static(webUiPath));
    this.app.use("/assets/images", express.static(userAssetsPath));
    this.app.get(/^(?!\/api\/|\/health|\/live|\/ready).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(webUiPath, "index.html"));
    });
  }

  private requestLogger(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();

    // Create a tracing span for the incoming HTTP request
    const observability = this.registry.resolveService<Observability>("observability");
    const tracing = observability?.getTracingService?.();

    if (tracing?.isEnabled()) {
      tracing.withSpan("http.request", async (span) => {
        span.setAttribute("http.method", req.method);
        span.setAttribute("http.url", req.path);
        span.setAttribute("http.user_agent", req.get("user-agent") || "unknown");

        return new Promise<void>((resolve) => {
          res.on("finish", () => {
            const latencyMs = Date.now() - start;
            span.setAttribute("http.status_code", res.statusCode);
            span.setAttribute("http.response_time_ms", latencyMs);
            if (observability) {
              observability.recordRequestLatency(req.path, req.method, res.statusCode, latencyMs);
            }
            resolve();
          });
        });
      }).catch(() => { /* tracing errors are non-critical */ });
    } else {
      res.on("finish", () => {
        const latencyMs = Date.now() - start;
        if (observability) {
          observability.recordRequestLatency(req.path, req.method, res.statusCode, latencyMs);
        }
      });
    }

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