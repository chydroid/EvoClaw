import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import crypto from "crypto";
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
  private mcpProtocolHandler: import("./mcp-protocol-handler").MCPProtocolHandler | null = null;
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

    // ── Auth endpoints (public, no JWT required) ───────────────────
    // Simple username/password login. Credentials come from env (with safe
    // defaults so local dev works out of the box). In production, set
    // EVOCLAW_ADMIN_USER and EVOCLAW_ADMIN_PASSWORD.
    this.app.post("/api/auth/login", (req: Request, res: Response) => {
      const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
      if (!username || !password) {
        res.status(400).json({ error: "Username and password are required" });
        return;
      }
      const expectedUser = process.env.EVOCLAW_ADMIN_USER || "admin";
      const expectedPass = process.env.EVOCLAW_ADMIN_PASSWORD || "admin";
      const userMatch = username === expectedUser;
      const passBuf = Buffer.from(String(password));
      const expectedBuf = Buffer.from(String(expectedPass));
      const passMatch = passBuf.length === expectedBuf.length && crypto.timingSafeEqual(passBuf, expectedBuf);
      if (!userMatch || !passMatch) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }
      const token = this.authProvider.generateToken(username, ["admin", "user"]);
      res.json({ token, user: { id: username, roles: ["admin", "user"] } });
    });

    this.app.post("/api/auth/register", (_req: Request, res: Response) => {
      // EvoClaw runs in single-tenant mode by default. Registration is
      // disabled; point users to the admin user configured in .env.
      res.status(403).json({ error: "Registration is disabled; contact your admin" });
    });

    this.app.post("/api/auth/refresh", (req: Request, res: Response) => {
      const { token } = (req.body ?? {}) as { token?: string };
      if (!token) {
        res.status(400).json({ error: "token is required" });
        return;
      }
      try {
        const decoded = this.authProvider.verifyToken(token);
        const fresh = this.authProvider.generateToken(decoded.userId, decoded.roles);
        res.json({ token: fresh });
      } catch {
        res.status(401).json({ error: "Invalid or expired token" });
      }
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

    // GET /api/config — general configuration info
    this.app.get("/api/config", (_req: Request, res: Response) => {
      const persona = this.registry.resolveService<{ name?: string; masterTerm?: string }>("personaConfig");
      const featureFlags = this.registry.resolveService<{ getAll?(): Record<string, unknown> }>("featureFlagStore");
      res.json({
        version: (globalThis as Record<string, unknown>).__EVOCLAW_VERSION__ ?? "unknown",
        persona: persona ? { name: persona.name, masterTerm: persona.masterTerm } : null,
        features: featureFlags?.getAll?.() ?? {},
        avatars: this.avatarConfig,
      });
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

    // ── New feature endpoints registered before the 404 catch-all ─────
    this.setupTracingRoutes();
    this.setupEvalsRoutes();
    this.setupExecutionRoutes();
    this.setupMemoryRoutes();

    // ── Agent Capabilities API (v0.19.0+) ──

    // Guardrails stats
    this.app.get("/api/guardrails/stats", async (_req: any, res: any) => {
      try {
        const executor = this.registry.resolveService("agentModelExecutor") as any;
        if (!executor) { res.json({ enabled: false }); return; }
        const status = executor.getGuardrailsStatus?.();
        res.json(status || { enabled: false });
      } catch { res.json({ enabled: false }); }
    });

    // Prompt Cache stats
    this.app.get("/api/prompt-cache/stats", async (_req: any, res: any) => {
      try {
        const executor = this.registry.resolveService("agentModelExecutor") as any;
        if (!executor) { res.json({ enabled: false }); return; }
        const stats = executor.getPromptCacheStats?.();
        res.json(stats || { enabled: false });
      } catch { res.json({ enabled: false }); }
    });

    // ACP Agents
    this.app.get("/api/acp/agents", async (_req: any, res: any) => {
      try {
        const executor = this.registry.resolveService("agentModelExecutor") as any;
        if (!executor) { res.json([]); return; }
        const agents = executor.getACPAgents?.();
        res.json(agents || []);
      } catch { res.json([]); }
    });

    // Observability traces
    this.app.get("/api/observability/traces", async (_req: any, res: any) => {
      try {
        const executor = this.registry.resolveService("agentModelExecutor") as any;
        if (!executor) { res.json([]); return; }
        const traces = executor.getObservabilityTraces?.();
        res.json(traces || []);
      } catch { res.json([]); }
    });

    // Steer - inject real-time instruction
    this.app.post("/api/steer", async (req: any, res: any) => {
      try {
        const { sessionId, instruction, priority } = req.body || {};
        if (!sessionId || !instruction) {
          res.status(400).json({ error: "sessionId and instruction are required" });
          return;
        }
        const executor = this.registry.resolveService("agentModelExecutor") as any;
        if (!executor) { res.status(503).json({ error: "Agent not available" }); return; }
        const result = executor.steer?.(sessionId, instruction, priority);
        res.json(result || { accepted: false, message: "Steer not available" });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Workboard
    this.app.get("/api/workboard", async (_req: any, res: any) => {
      try {
        const executor = this.registry.resolveService("agentModelExecutor") as any;
        if (!executor) { res.json({ tasks: {}, stats: null }); return; }
        const board = executor.getWorkboard?.();
        if (!board) { res.json({ tasks: {}, stats: null }); return; }
        res.json({ tasks: board.getBoardView(), stats: board.getStats() });
      } catch { res.json({ tasks: {}, stats: null }); }
    });

    this.app.post("/api/workboard/tasks", async (req: any, res: any) => {
      try {
        const executor = this.registry.resolveService("agentModelExecutor") as any;
        if (!executor) { res.status(503).json({ error: "Agent not available" }); return; }
        const board = executor.getWorkboard?.();
        if (!board) { res.status(503).json({ error: "Workboard not available" }); return; }
        const task = board.createTask(req.body);
        res.json(task);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Memory Dreaming
    this.app.get("/api/memory/dreaming", async (_req: any, res: any) => {
      try {
        const memoryHub = this.registry.resolveService("memoryHub") as any;
        if (!memoryHub) { res.json({ enabled: false }); return; }
        const diary = memoryHub.getDreamDiary?.();
        const shouldDream = memoryHub.shouldDream?.();
        res.json({ enabled: true, diary, shouldDream });
      } catch { res.json({ enabled: false }); }
    });

    this.app.post("/api/memory/dreaming/trigger", async (req: any, res: any) => {
      try {
        const memoryHub = this.registry.resolveService("memoryHub") as any;
        if (!memoryHub) { res.status(503).json({ error: "Memory not available" }); return; }
        const { phase } = req.body || {};
        const session = await memoryHub.dream?.(phase);
        res.json(session);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Computed Status
    this.app.get("/api/computed-status", async (_req: any, res: any) => {
      try {
        const executor = this.registry.resolveService("agentModelExecutor") as any;
        if (!executor) { res.json({ sources: [] }); return; }
        const engine = executor.getComputedStatus?.();
        if (!engine) { res.json({ sources: [] }); return; }
        res.json({ sources: engine.getSources() });
      } catch { res.json({ sources: [] }); }
    });

    // MCP JSON-RPC endpoint
    try {
      const { MCPProtocolHandler } = require("./mcp-protocol-handler");
      // Create a toolRegistry that bridges to the agent's registered tools
      const toolRegistry = this.registry ? {
        listTools: () => {
          const tools: Array<{name: string; description: string; inputSchema: Record<string, unknown>}> = [];
          // Access registered tools from the agent executor
          const executor = this.registry.resolveService<any>("agentModelExecutor");
          if (executor?.registeredTools) {
            for (const [name, entry] of executor.registeredTools) {
              tools.push({
                name,
                description: entry.definition?.description || name,
                inputSchema: entry.definition?.parameters || { type: "object", properties: {} },
              });
            }
          }
          return tools;
        },
        executeTool: async (name: string, args: Record<string, unknown>) => {
          const executor = this.registry.resolveService<any>("agentModelExecutor");
          if (!executor?.registeredTools || !executor.registeredTools.has(name)) {
            return { error: `Tool "${name}" not found` };
          }
          try {
            const entry = executor.registeredTools.get(name);
            const result = await entry.handler(args);
            return { result: typeof result === "string" ? result : JSON.stringify(result) };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
      } : undefined;

      this.mcpProtocolHandler = new MCPProtocolHandler({
        serverName: "EvoClaw-Gateway",
        serverVersion: "1.0.0",
        toolRegistry,
        resources: [],
        prompts: [],
      });

      this.app.post("/api/mcp", async (req: Request, res: Response) => {
        if (!this.mcpProtocolHandler) return res.status(503).json({ error: "MCP not available" });
        const result = await this.mcpProtocolHandler.routeMessage(req.body);
        res.json(result);
      });
    } catch (err) {
      console.error("[Gateway] Failed to initialize MCP protocol handler:", err);
    }

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

  // ── Tracing endpoints (in-memory OTel span collector) ─────────────
  private setupTracingRoutes(): void {
    // GET /api/tracing/spans?sessionId=xxx&limit=50&nameContains=llm&traceId=...
    this.app.get("/api/tracing/spans", (req: Request, res: Response) => {
      const collector = this.registry.resolveService<{
        recent(filter?: { sessionId?: string; limit?: number; nameContains?: string; traceId?: string; sinceMs?: number }): unknown[];
        byTrace(traceId: string): unknown[];
        size(): number;
      }>("spanCollector");

      if (!collector) {
        res.status(503).json({ error: "Span collector not initialized" });
        return;
      }

      const { sessionId, limit, nameContains, traceId, sinceMs } = req.query as Record<string, string>;
      const filter: { sessionId?: string; limit?: number; nameContains?: string; traceId?: string; sinceMs?: number } = {};
      if (sessionId) filter.sessionId = sessionId;
      if (limit) filter.limit = Math.min(parseInt(limit, 10) || 50, 500);
      else filter.limit = 50;
      if (nameContains) filter.nameContains = nameContains;
      if (traceId) filter.traceId = traceId;
      if (sinceMs) filter.sinceMs = parseInt(sinceMs, 10);

      const spans = collector.recent(filter);
      res.json({ spans, count: spans.length, total: collector.size() });
    });

    // GET /api/tracing/traces/:traceId — get all spans for a trace
    this.app.get("/api/tracing/traces/:traceId", (req: Request, res: Response) => {
      const collector = this.registry.resolveService<{ byTrace(id: string): unknown[] }>("spanCollector");
      if (!collector) {
        res.status(503).json({ error: "Span collector not initialized" });
        return;
      }
      const spans = collector.byTrace(String(req.params.traceId));
      res.json({ traceId: String(req.params.traceId), spans, count: spans.length });
    });

    // GET /api/tracing/stats — diagnostic info
    this.app.get("/api/tracing/stats", (_req: Request, res: Response) => {
      const collector = this.registry.resolveService<{ size(): number; recent(filter?: { limit?: number }): unknown[] }>("spanCollector");
      if (!collector) {
        res.status(503).json({ error: "Span collector not initialized" });
        return;
      }
      res.json({ totalSpans: collector.size(), recentSpans: collector.recent({ limit: 10 }) });
    });

    // DELETE /api/tracing/spans — clear the buffer
    this.app.delete("/api/tracing/spans", (_req: Request, res: Response) => {
      const collector = this.registry.resolveService<{ clear(): void; size(): number }>("spanCollector");
      if (!collector) {
        res.status(503).json({ error: "Span collector not initialized" });
        return;
      }
      const before = collector.size();
      collector.clear();
      res.json({ cleared: before });
    });
  }

  // ── Evals endpoints (LLM evaluation framework) ────────────────────
  private setupEvalsRoutes(): void {
    // GET /api/evals/cases — list available eval cases
    this.app.get("/api/evals/cases", (_req: Request, res: Response) => {
      const runner = this.registry.resolveService<{ getAllCases(): unknown[] }>("evalRunner");
      if (!runner) {
        res.json({ cases: [], count: 0, note: "EvalRunner not registered" });
        return;
      }
      const cases = runner.getAllCases();
      res.json({ cases, count: cases.length });
    });

    // POST /api/evals/run — run the full eval suite (non-blocking: returns runId)
    this.app.post("/api/evals/run", (req: Request, res: Response) => {
      const runner = this.registry.resolveService<{ runAll(options?: unknown): Promise<{ runId: string; total: number; passed: number; failed: number; averageScore: number; durationMs: number }> }>("evalRunner");
      if (!runner) {
        res.status(503).json({ error: "EvalRunner not registered" });
        return;
      }
      runner.runAll(req.body ?? {}).then(
        (summary) => res.json(summary),
        (err) => res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
      );
    });

    // GET /api/evals/runs — list past runs
    this.app.get("/api/evals/runs", (_req: Request, res: Response) => {
      const runner = this.registry.resolveService<{ getRunHistory(): unknown[] }>("evalRunner");
      if (!runner) {
        res.json({ runs: [], count: 0 });
        return;
      }
      const runs = runner.getRunHistory();
      res.json({ runs, count: runs.length });
    });

    // GET /api/evals/runs/:id — get details of a single run
    this.app.get("/api/evals/runs/:id", (req: Request, res: Response) => {
      const runner = this.registry.resolveService<{ getRunById(id: string): unknown }>("evalRunner");
      if (!runner) {
        res.status(503).json({ error: "EvalRunner not registered" });
        return;
      }
      const run = runner.getRunById(String(req.params.id));
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      res.json(run);
    });
  }

  // ── Memory (semantic + full-text search) endpoints ──────────────────
  private setupMemoryRoutes(): void {
    // GET /api/memory/search?query=...&limit=10 — semantic search using the
    // local Transformers embeddings (all-MiniLM-L6-v2, 384-dim). Falls back
    // to FTS5 lexical search when the embedding provider is unavailable.
    this.app.get("/api/memory/search", async (req: Request, res: Response) => {
      const memoryHub = this.registry.resolveService<{
        semanticSearch(query: string, limit?: number): Promise<Array<{ id: string; score: number; text: string; metadata: Record<string, unknown> }>>;
        getEmbeddingProviderStatus(): "transformers" | "unavailable" | "disabled";
      }>("memoryHub");

      if (!memoryHub) {
        res.status(503).json({ error: "MemoryHub not initialized" });
        return;
      }

      const query = String(req.query.query ?? "").trim();
      if (!query) {
        res.status(400).json({ error: "query parameter is required" });
        return;
      }

      const limit = Math.min(parseInt(String(req.query.limit ?? "10"), 10) || 10, 50);

      try {
        const results = await memoryHub.semanticSearch(query, limit);
        const status = memoryHub.getEmbeddingProviderStatus();
        res.json({
          query,
          limit,
          count: results.length,
          embeddingBackend: status,
          results: results.map((r) => ({
            id: r.id,
            score: Number(r.score.toFixed(4)),
            text: r.text,
            metadata: r.metadata,
          })),
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/memory/status — describe which embedding backend is active
    this.app.get("/api/memory/status", (_req: Request, res: Response) => {
      const memoryHub = this.registry.resolveService<{
        getEmbeddingProviderStatus(): "transformers" | "local-tfidf" | "unavailable" | "disabled";
        getEmbeddingProvider(): { dimensions?: number } | null;
        getVectorStore(): { size(): number } | null;
        getEmbeddingLoadError(): string | null;
        isEmbeddingReady(): boolean;
        getVectorIndexSize(): number;
      }>("memoryHub");

      if (!memoryHub) {
        res.status(503).json({ error: "MemoryHub not initialized" });
        return;
      }

      const status = memoryHub.getEmbeddingProviderStatus();
      const provider = memoryHub.getEmbeddingProvider();
      const vectorStoreSize = memoryHub.getVectorIndexSize();
      const loadError = memoryHub.getEmbeddingLoadError();
      const ready = memoryHub.isEmbeddingReady();

      // Surface a human-readable model description based on the active backend
      const model = provider
        ? status === "transformers"
          ? { name: "all-MiniLM-L6-v2 (transformers.js)", dimension: provider.dimensions ?? 384 }
          : { name: "Local TF-IDF (offline fallback)", dimension: provider.dimensions ?? 256 }
        : null;

      res.json({
        embeddingBackend: status,
        ready,
        model,
        vectorIndexSize: vectorStoreSize,
        loadError: loadError ?? undefined,
      });
    });
  }

  // ── Execution Checkpoint endpoints ─────────────────────────────────
  private setupExecutionRoutes(): void {
    // GET /api/executions — list recent executions
    this.app.get("/api/executions", (_req: Request, res: Response) => {
      const store = this.registry.resolveService<{ getRecent(opts?: { limit?: number }): unknown[] }>("executionCheckpointStore");
      if (!store) {
        res.json({ executions: [], count: 0, note: "ExecutionCheckpointStore not registered" });
        return;
      }
      const limit = parseInt((_req.query.limit as string) || "50", 10);
      const executions = store.getRecent({ limit: Math.min(limit, 200) });
      res.json({ executions, count: executions.length });
    });

    // GET /api/executions/:id — get a single execution with all snapshots
    this.app.get("/api/executions/:id", (req: Request, res: Response) => {
      const store = this.registry.resolveService<{ getById(id: string): unknown }>("executionCheckpointStore");
      if (!store) {
        res.status(503).json({ error: "ExecutionCheckpointStore not registered" });
        return;
      }
      const execution = store.getById(String(req.params.id));
      if (!execution) {
        res.status(404).json({ error: "Execution not found" });
        return;
      }
      res.json(execution);
    });

    // POST /api/executions/:id/resume — resume an interrupted execution
    this.app.post("/api/executions/:id/resume", (req: Request, res: Response) => {
      const store = this.registry.resolveService<{ resume(id: string, fromSnapshotIndex?: number): unknown }>("executionCheckpointStore");
      if (!store) {
        res.status(503).json({ error: "ExecutionCheckpointStore not registered" });
        return;
      }
      const fromSnapshotIndex = typeof req.body?.fromSnapshotIndex === "number" ? req.body.fromSnapshotIndex : undefined;
      const result = store.resume(String(req.params.id), fromSnapshotIndex);
      res.json(result);
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