import { Express, Request, Response } from "express";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { taskStatusTracker, ModelFailoverManager } from "@evoclaw/agent";
import { IncomingWebhookManager } from "./webhook-manager";
import type { WebhookEndpoint } from "./webhook-manager";
import { spawn } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

const CLI_SCRIPT_PATH = path.resolve(__dirname, "..", "..", "..", "apps", "cli", "dist", "index.js");

const ALLOWED_CLI_COMMANDS = [
  "setup", "onboard", "configure", "config", "doctor", "dashboard", "completion",
  "health", "status", "sessions",
  "agent", "agents", "message", "acp",
  "skills", "memory", "models",
  "gateway", "logs", "system",
  "channels", "security", "secrets", "approvals", "pairing",
  "sandbox", "tasks", "hooks",
  "cron", "webhooks", "plugins", "mcp",
  "directory", "docs",
  "update", "backup", "uninstall", "reset",
] as const;

const FORBIDDEN_PATTERNS = [
  /rm\s+-rf/, /sudo\s/, /\|.*rm/, /;\s*rm/, /`.*`/,
  /delete\s+-\w*i\w*/, /DROP\s+TABLE/i, /TRUNCATE/i,
  /format\s+[A-Z]:/i, /del\s+\/f\s+\/s/i,
];

const CLI_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 1024 * 512;

const DATA_DIR = path.resolve("data", "config");
const LLM_CONFIG_FILE = path.join(DATA_DIR, "llm-providers.json");
const CHANNELS_CONFIG_FILE = path.join(DATA_DIR, "channels.json");

function validateCliCommand(input: string): { valid: boolean; reason?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, reason: "Empty command" };
  if (trimmed.length > 2048) return { valid: false, reason: "Command too long (max 2048 chars)" };

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, reason: "Command contains forbidden patterns" };
    }
  }

  if (!trimmed.toLowerCase().startsWith("evoclaw ")) return { valid: false, reason: 'Commands must start with "EvoClaw" (e.g. EvoClaw --help)' };

  return { valid: true };
}

function executeCliCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const args = command.replace(/^[Ee][Vv][Oo][Cc][Ll][Aa][Ww]\s*/, "").trim().split(/\s+/).filter(Boolean);

    const childProcess = spawn("node", [CLI_SCRIPT_PATH, ...args], {
      windowsHide: true,
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        timedOut = true;
        childProcess.kill("SIGKILL");
      }
    }, CLI_TIMEOUT_MS);

    childProcess.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n... (output truncated)";
        childProcess.kill("SIGTERM");
      }
    });

    childProcess.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
      if (stderr.length > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n... (output truncated)";
      }
    });

    childProcess.on("close", (code) => {
      clearTimeout(timeoutId);
      if (!resolved) {
        resolved = true;
        resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: code ?? 1, timedOut });
      }
    });

    childProcess.on("error", (err) => {
      clearTimeout(timeoutId);
      if (!resolved) {
        resolved = true;
        resolve({ stdout: "", stderr: err.message, exitCode: 1, timedOut: false });
      }
    });
  });
}

export class ProtocolAdapter {
  private savedLLMProviders: Record<string, unknown>[] | null = null;
  private savedChannels: Record<string, unknown>[] | null = null;
  private incomingWebhookManager: IncomingWebhookManager;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.incomingWebhookManager = new IncomingWebhookManager();
    this.incomingWebhookManager.setActionHandler(async (action, payload) => {
      this.eventBus.publish("webhook.triggered", {
        action,
        endpointId: payload.endpointId,
        path: payload.path,
        body: payload.body,
        headers: payload.headers,
        timestamp: new Date().toISOString(),
      }, "protocol-adapter");
      return { statusCode: 200, response: { received: true, action } };
    });
  }

  getIncomingWebhookManager(): IncomingWebhookManager {
    return this.incomingWebhookManager;
  }

  loadPersistedConfig(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch {}

    try {
      if (fs.existsSync(LLM_CONFIG_FILE)) {
        const raw = fs.readFileSync(LLM_CONFIG_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (data.providers && Array.isArray(data.providers)) {
          this.savedLLMProviders = data.providers;
          this.applyLLMProviders(data.providers);
          console.log(`[ProtocolAdapter] Loaded ${data.providers.length} LLM providers from disk`);
        }
      }
    } catch (err) {
      console.warn("[ProtocolAdapter] Failed to load LLM config:", err instanceof Error ? err.message : String(err));
    }

    try {
      if (fs.existsSync(CHANNELS_CONFIG_FILE)) {
        const raw = fs.readFileSync(CHANNELS_CONFIG_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (data.channels && Array.isArray(data.channels)) {
          this.savedChannels = data.channels;
          console.log(`[ProtocolAdapter] Loaded ${data.channels.length} channels from disk`);
        }
      }
    } catch (err) {
      console.warn("[ProtocolAdapter] Failed to load channels config:", err instanceof Error ? err.message : String(err));
    }
  }

  private persistLLMProviders(providers: Record<string, unknown>[]): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(LLM_CONFIG_FILE, JSON.stringify({ providers }, null, 2), "utf-8");
    } catch (err) {
      console.warn("[ProtocolAdapter] Failed to persist LLM config:", err instanceof Error ? err.message : String(err));
    }
  }

  private persistChannels(channels: Record<string, unknown>[]): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CHANNELS_CONFIG_FILE, JSON.stringify({ channels }, null, 2), "utf-8");
    } catch (err) {
      console.warn("[ProtocolAdapter] Failed to persist channels config:", err instanceof Error ? err.message : String(err));
    }
  }

  private applyLLMProviders(providers: Record<string, unknown>[]): void {
    const executor = this.registry.resolveService<{
      configureProviders(providers: Array<{
        id: string;
        name: string;
        enabled: boolean;
        order: number;
        provider: string;
        model: string;
        apiKey: string;
        baseURL: string;
        maxTokens: number;
        temperature: number;
        timeout: number;
        topP?: number;
      }>): void;
    }>("agentModelExecutor");

    if (!executor) return;

    const configs = providers
      .filter((p) => p.enabled)
      .map((p) => ({
        id: (p.id as string) || "",
        name: (p.name as string) || "",
        enabled: true,
        order: (p.order as number) ?? 1,
        provider: (p.id as string) || "custom",
        model: (p.selectedModel as string) || "",
        apiKey: (p.apiKey as string) || "",
        baseURL: (p.baseURL as string) || "",
        maxTokens: (p.config as Record<string, unknown>)?.maxTokens as number || 4096,
        temperature: (p.config as Record<string, unknown>)?.temperature as number || 0.3,
        timeout: (p.config as Record<string, unknown>)?.timeout as number || 60000,
        topP: (p.config as Record<string, unknown>)?.topP as number ?? 1,
      }));

    if (configs.length > 0) {
      executor.configureProviders(configs);
    }
  }

  private authProvider: {
    generateToken(userId: string, roles?: string[]): string;
    generateRefreshToken(userId: string): string;
    verifyToken(token: string): { userId: string; roles: string[] };
  } | null = null;

  private getAuthProvider(): typeof this.authProvider {
    if (!this.authProvider) {
      this.authProvider = this.registry.resolveService("authProvider") || null;
    }
    return this.authProvider;
  }

  private handleError(err: unknown, res: Response, defaultMsg: string): void {
    const isProduction = process.env.NODE_ENV === "production";
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ProtocolAdapter] ${defaultMsg}:`, message);
    res.status(500).json({
      error: defaultMsg,
      ...(isProduction ? {} : { message }),
    });
  }

  mountREST(app: Express): void {
    app.post("/api/auth/login", (req: Request, res: Response) => {
      try {
        const { username, password } = req.body || {};
        if (!username || !password) {
          res.status(400).json({ error: "Username and password are required" });
          return;
        }
        if (typeof username !== "string" || typeof password !== "string") {
          res.status(400).json({ error: "Username and password must be strings" });
          return;
        }
        if (username.length > 128 || password.length > 256) {
          res.status(400).json({ error: "Username or password too long" });
          return;
        }

        const auth = this.getAuthProvider();
        if (!auth) {
          res.status(503).json({ error: "Authentication service not available" });
          return;
        }

        const token = auth.generateToken(username);
        const refreshToken = auth.generateRefreshToken(username);
        res.json({ token, refreshToken, expiresIn: "24h" });
      } catch (err) {
        this.handleError(err, res, "Login failed");
      }
    });

    app.post("/api/auth/register", (req: Request, res: Response) => {
      try {
        const { username, password } = req.body || {};
        if (!username || !password) {
          res.status(400).json({ error: "Username and password are required" });
          return;
        }
        if (typeof username !== "string" || typeof password !== "string") {
          res.status(400).json({ error: "Username and password must be strings" });
          return;
        }
        if (username.length < 3 || username.length > 64) {
          res.status(400).json({ error: "Username must be 3-64 characters" });
          return;
        }
        if (password.length < 8 || password.length > 128) {
          res.status(400).json({ error: "Password must be 8-128 characters" });
          return;
        }

        const auth = this.getAuthProvider();
        if (!auth) {
          res.status(503).json({ error: "Authentication service not available" });
          return;
        }

        const token = auth.generateToken(username, ["user"]);
        res.status(201).json({ token, userId: username });
      } catch (err) {
        this.handleError(err, res, "Registration failed");
      }
    });

    app.get("/api/auth/check", (req: Request, res: Response) => {
      const auth = this.getAuthProvider();
      if (!auth) {
        res.json({ authenticated: true });
        return;
      }
      const webUiToken = process.env.WEB_UI_TOKEN || "";
      if (!webUiToken) {
        res.json({ authenticated: true });
        return;
      }
      const cookieHeader = req.headers.cookie || "";
      const cookies = cookieHeader.split(";").reduce<Record<string, string>>((acc, c) => {
        const [k, ...v] = c.trim().split("=");
        if (k) acc[k] = decodeURIComponent(v.join("="));
        return acc;
      }, {});
      const tokenFromCookie = cookies["web_ui_token"];
      if (tokenFromCookie && tokenFromCookie === webUiToken) {
        res.json({ authenticated: true });
      } else {
        res.status(401).json({ authenticated: false, error: "Invalid or missing token" });
      }
    });

    app.get("/api/skills", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          listSkills(): Promise<unknown[]>;
          searchLocalSkills(query: Record<string, unknown>): Promise<unknown>;
          searchRemoteSkills(query: Record<string, unknown>): Promise<unknown>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        
        // If keyword parameter is provided, perform search
        const keyword = req.query.keyword as string;
        if (keyword) {
          const query = { keyword, limit: parseInt(req.query.limit as string) || 20 };
          const localResults = await skillManager.searchLocalSkills(query);
          const remoteResults = await skillManager.searchRemoteSkills(query);
          res.json({ 
            success: true, 
            keyword,
            local: localResults,
            remote: remoteResults
          });
          return;
        }
        
        // Otherwise list all installed skills
        const skills = await skillManager.listSkills();
        res.json(skills);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/skills/:id", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          getSkill(id: string): Promise<unknown>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skill = await skillManager.getSkill(String(req.params.id));
        if (!skill) {
          res.status(404).json({ error: "Skill not found" });
          return;
        }
        res.json(skill);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/install", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          installSkill(path: string): Promise<unknown>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skillPath = (req.body.path as string) || "";
        if (!skillPath) {
          res.status(400).json({ error: "Skill path is required (body.path)" });
          return;
        }
        const installed = await skillManager.installSkill(skillPath);
        res.json({ success: true, skill: installed });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/refresh", async (_req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          scanAndInstall(dir: string): Promise<{ installed: unknown[]; skipped: string[] }>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skillsDir = path.resolve(process.cwd(), "..", "..", "data", "workspace", "skills");
        const result = await skillManager.scanAndInstall(skillsDir);
        res.json({
          installed: result.installed.length,
          skipped: result.skipped.length,
          details: result,
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.put("/api/skills/:id/config", (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          getSkill(id: string): Promise<{ id: string; config: Record<string, unknown>; name: string } | undefined>;
        }>("skillManager");
        const skillId = req.params.id as string;
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        skillManager.getSkill(skillId).then((skill) => {
          if (!skill) {
            res.status(404).json({ error: "Skill not found" });
            return;
          }
          skill.config = { ...skill.config, ...(req.body.config || {}) };
          res.json({ success: true, skill });
        }).catch(() => {
          res.status(500).json({ error: "Failed to update config" });
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/translate", async (_req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          checkAndTranslateInstalledSkills(): Promise<{ checked: number; translated: number }>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const result = await skillManager.checkAndTranslateInstalledSkills();
        res.json({ success: true, ...result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/skills/:id/evolution", async (req: Request, res: Response) => {
      try {
        const skillCurator = this.registry.resolveService<{
          getSkillEvolution(skillId: string): unknown;
          getAllEvolutions(): unknown[];
          getEvolutionStats(): Record<string, unknown>;
        }>("skillCurator");
        if (!skillCurator) {
          res.status(503).json({ error: "Skill curator not available" });
          return;
        }
        const skillId = String(req.params.id);
        const evolution = skillCurator.getSkillEvolution(skillId);
        if (!evolution) {
          res.status(404).json({ error: "Skill evolution not found" });
          return;
        }
        res.json({ success: true, evolution });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/curate", async (req: Request, res: Response) => {
      try {
        const skillCurator = this.registry.resolveService<{
          extractSkillFromSolution(task: string, solution: string, context: Record<string, unknown>): Promise<unknown>;
        }>("skillCurator");
        if (!skillCurator) {
          res.status(503).json({ error: "Skill curator not available" });
          return;
        }
        const { task, solution, context } = req.body || {};
        if (!task || !solution) {
          res.status(400).json({ error: "task and solution are required" });
          return;
        }
        const skill = await skillCurator.extractSkillFromSolution(
          task,
          solution,
          context || {}
        );
        res.json({ success: true, skill });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/:id/translate", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          getSkill(id: string): Promise<{ id: string; name: string; description: string; installPath: string; body: { instructions: string; examples: string[] }; i18n?: Record<string, unknown> } | undefined>;
          getLocalizationService(): { checkAndTranslateSkill(skill: { name: string; description: string; installPath: string; body: { instructions: string; examples: string[] }; i18n?: Record<string, unknown> }): Promise<Record<string, unknown> | undefined> };
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skill = await skillManager.getSkill(String(req.params.id));
        if (!skill) {
          res.status(404).json({ error: "Skill not found" });
          return;
        }
        const localization = skillManager.getLocalizationService();
        const i18n = await localization.checkAndTranslateSkill(skill);
        res.json({ success: true, i18n });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ============ Bootstrap File Routes ============
    app.get("/api/bootstrap", async (_req: Request, res: Response) => {
      try {
        const bm = this.registry.resolveService<{
          listFiles(): { name: string; description: string; content: string; exists: boolean }[];
          getContext(): { bootstrapPending: boolean; missingFiles: string[] };
          getWorkspacePath(): string;
        }>("bootstrapManager");
        if (!bm) return res.json({ files: [], pending: false, workspacePath: "" });
        const files = bm.listFiles();
        const ctx = bm.getContext();
        res.json({ files, pending: ctx.bootstrapPending, missingFiles: ctx.missingFiles, workspacePath: bm.getWorkspacePath() });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/bootstrap/:filename", (req: Request, res: Response) => {
      try {
        const bm = this.registry.resolveService<{
          readBootstrapFile(filename: string): string | null;
        }>("bootstrapManager");
        if (!bm) return res.status(404).json({ error: "Bootstrap manager not found" });
        const content = bm.readBootstrapFile(String(req.params.filename));
        if (content === null) return res.status(404).json({ error: "File not found" });
        res.json({ filename: req.params.filename, content });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.put("/api/bootstrap/:filename", (req: Request, res: Response) => {
      try {
        const filename = String(req.params.filename);
        if (!["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"].includes(filename)) {
          res.status(400).json({ error: "Invalid filename" });
          return;
        }
        const bm = this.registry.resolveService<{
          writeBootstrapFile(filename: string, content: string): void;
        }>("bootstrapManager");
        if (!bm) return res.status(404).json({ error: "Bootstrap manager not found" });
        const { content } = req.body || {};
        if (!content) return res.status(400).json({ error: "Content is required" });
        bm.writeBootstrapFile(filename, content);
        res.json({ success: true, filename });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.delete("/api/bootstrap/:filename", (req: Request, res: Response) => {
      try {
        const filename = String(req.params.filename);
        if (!["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"].includes(filename)) {
          res.status(400).json({ error: "Invalid filename" });
          return;
        }
        const bm = this.registry.resolveService<{
          deleteBootstrapFile(filename: string): void;
        }>("bootstrapManager");
        if (!bm) return res.status(404).json({ error: "Bootstrap manager not found" });
        bm.deleteBootstrapFile(filename);
        res.json({ success: true, filename });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/bootstrap/complete", (_req: Request, res: Response) => {
      try {
        const bm = this.registry.resolveService<{
          completeBootstrap(): void;
        }>("bootstrapManager");
        if (!bm) return res.json({ success: false, message: "Not available" });
        bm.completeBootstrap();
        res.json({ success: true, message: "Bootstrap completed" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ============ Status / Lifecycle Routes ============
    app.get("/api/status", (_req: Request, res: Response) => {
      try {
        const lm = this.registry.resolveService<{
          getAllStatuses(): Array<{ sessionId: string; state: string; currentAction: string; toolCalls: Array<{ name: string; status: string }>; lastActivity: string; tokensUsed: number; duration: number; runId: number; progress?: { current: number; total: number; label: string } }>;
          getStatus(sessionId: string): unknown;
        }>("lifecycleManager");
        const uptime = process.uptime();
        const memUsage = process.memoryUsage();
        res.json({
          online: true,
          uptime: Math.floor(uptime),
          uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
          memory: {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024),
          },
          platform: process.platform,
          nodeVersion: process.version,
          agentStatuses: lm?.getAllStatuses() || [],
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/status/:sessionId", (req: Request, res: Response) => {
      try {
        const lm = this.registry.resolveService<{
          getStatus(sessionId: string): unknown;
        }>("lifecycleManager");
        if (!lm) return res.json({ sessionId: req.params.sessionId, state: "unknown" });
        const status = lm.getStatus(String(req.params.sessionId));
        if (!status) return res.json({ sessionId: req.params.sessionId, state: "idle" });
        res.json(status);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ============ Queue Routes ============
    app.get("/api/queue", (_req: Request, res: Response) => {
      try {
        const qm = this.registry.resolveService<{
          getQueue(sessionId: string): unknown[];
          getStats(sessionId: string): { total: number; pending: number; processing: number; done: number; failed: number };
          hasPending(sessionId: string): boolean;
        }>("queueManager");
        if (!qm) return res.json({ queues: {}, stats: {} });
        const sessionId = "web-ui";
        res.json({
          queue: qm.getQueue(sessionId),
          stats: qm.getStats(sessionId),
          hasPending: qm.hasPending(sessionId),
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/queue/enqueue", (req: Request, res: Response) => {
      try {
        const qm = this.registry.resolveService<{
          enqueue(sessionId: string, message: string, mode: string, context?: Record<string, unknown>, priority?: number): unknown;
        }>("queueManager");
        if (!qm) return res.status(503).json({ error: "Queue manager not available" });
        const { sessionId, message, mode } = req.body || {};
        if (!message) return res.status(400).json({ error: "Message is required" });
        const item = qm.enqueue(sessionId || "web-ui", message, mode || "steer");
        res.json({ success: true, item });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/queue/clear", (req: Request, res: Response) => {
      try {
        const qm = this.registry.resolveService<{
          clearQueue(sessionId: string): void;
        }>("queueManager");
        if (!qm) return res.status(503).json({ error: "Queue manager not available" });
        qm.clearQueue((req.body?.sessionId as string) || "web-ui");
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ============ Compaction Routes ============
    app.get("/api/compactions/:sessionId", (req: Request, res: Response) => {
      try {
        const cm = this.registry.resolveService<{
          getCompactionChain(sessionId: string): unknown[];
          loadCompactionChain(sessionId: string): unknown[];
        }>("compactionManager");
        if (!cm) return res.json({ compactions: [] });
        const chain = cm.getCompactionChain(String(req.params.sessionId));
        res.json({ compactions: chain });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/tasks", async (req: Request, res: Response) => {
      try {
        const taskOrchestrator = this.registry.resolveService<{
          createTask(input: unknown): Promise<unknown>;
        }>("taskOrchestrator");
        if (!taskOrchestrator) {
          res.status(503).json({ error: "Task orchestrator not available" });
          return;
        }
        const task = await taskOrchestrator.createTask(req.body);
        res.status(201).json(task);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/tasks/:id", async (req: Request, res: Response) => {
      try {
        const taskOrchestrator = this.registry.resolveService<{
          getTaskStatus(id: string): Promise<unknown>;
        }>("taskOrchestrator");
        if (!taskOrchestrator) {
          res.status(503).json({ error: "Task orchestrator not available" });
          return;
        }
        const status = await taskOrchestrator.getTaskStatus(String(req.params.id));
        res.json(status);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/chat", async (req: Request, res: Response) => {
      try {
        const message = (req.body.message as string) || "";
        const attachments = req.body.attachments as Array<{ name: string; type: string; size: number; data: string | null }> | undefined;
        if (!message.trim() && (!attachments || attachments.length === 0)) {
          res.status(400).json({ error: "Message or attachment is required" });
          return;
        }

        const agentExecutor = this.registry.resolveService<{
          chat(prompt: string, context?: Record<string, unknown>): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests?: Array<{ id: string; operation: string; description: string; target: string }> }>;
          getGreeting(): string | null;
        }>("agentModelExecutor");

        if (!agentExecutor) {
          res.status(503).json({ error: "Agent model executor not available" });
          return;
        }

        const resolvedSessionId = (req.body.sessionId as string) || "web-ui";
        
        // ── Global timeout: always return a response within 5min ──
        const CHAT_TIMEOUT = 300000;
        const chatPromise = agentExecutor.chat(message, {
          sessionId: resolvedSessionId,
          attachments,
        });
        
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("CHAT_TIMEOUT")), CHAT_TIMEOUT)
        );
        
        let result;
        try {
          result = await Promise.race([chatPromise, timeoutPromise]);
        } catch (raceErr) {
          if (raceErr instanceof Error && raceErr.message === "CHAT_TIMEOUT") {
            console.warn(`[ProtocolAdapter] Chat request timed out after ${CHAT_TIMEOUT / 1000}s for session "${resolvedSessionId}"`);
            res.json({
              reply: "⏱️ 处理超时，请稍后重试。如问题持续，请检查模型配置或简化提问。",
              tokensUsed: 0,
              contextLimit: 60000,
              duration: CHAT_TIMEOUT,
              sessionId: resolvedSessionId,
              permissionRequests: [],
            });
            return;
          }
          throw raceErr;
        }

        // Resolve context limit from ContextEngine config
        let contextLimit = 60000;
        try {
          const contextEngine = this.registry.resolveService("contextEngine") as {
            getConfig(): Record<string, unknown>;
          } | undefined;
          if (contextEngine) {
            const cfg = contextEngine.getConfig();
            contextLimit = (cfg.maxContextTokens as number) || 60000;
          }
        } catch { /* use default */ }

        res.json({
          reply: result.reply,
          tokensUsed: result.tokensUsed,
          contextLimit,
          duration: result.duration,
          sessionId: resolvedSessionId,
          permissionRequests: result.permissionRequests || [],
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Task status polling: real-time progress for long-running chat tasks ──
    app.get("/api/chat/status", (req: Request, res: Response) => {
      const sessionId = (req.query.sessionId as string) || "";
      const status = taskStatusTracker.get(sessionId);
      if (!status) {
        res.json({ phase: "idle", detail: "no active task", progress: 0 });
        return;
      }
      res.json(status);
    });

    app.get("/api/system/services", (_req: Request, res: Response) => {
      const infos = this.registry.getAllServiceInfos?.() || [];
      res.json(infos);
    });

    // ─── System info endpoints for Dashboard ────────────────────────────

    app.get("/api/system/sessions", (_req: Request, res: Response) => {
      try {
        const sessionMgr = this.registry.resolveService<{
          listSessions(agentId: string): Array<{ sessionId: string; messageCount?: number; updatedAt?: string; status?: string }>;
        }>("sessionManager");
        const lm = this.registry.resolveService<{
          getAllStatuses(): Array<{ sessionId: string; tokensUsed?: number; compactionCount?: number }>;
        }>("lifecycleManager");

        const sessions = sessionMgr?.listSessions("default") || [];
        const statuses = lm?.getAllStatuses() || [];

        const result = sessions.map((s) => {
          const status = statuses.find((st) => st.sessionId === s.sessionId);
          return {
            id: s.sessionId,
            messageCount: s.messageCount || 0,
            lastActive: s.updatedAt || new Date().toISOString(),
            compactionCount: status?.compactionCount || 0,
            tokensUsed: status?.tokensUsed || 0,
          };
        });

        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/system/providers", (_req: Request, res: Response) => {
      try {
        const executor = this.registry.resolveService<{
          getProviders(): Array<{ id: string; name: string; provider?: string; model?: string; enabled: boolean; order: number; lastError?: string; lastErrorType?: string; successCount?: number; failureCount?: number }>;
        }>("agentModelExecutor");

        const providers = executor?.getProviders() || this.savedLLMProviders || [];
        const result = providers.map((p: any) => ({
          name: p.name || p.id,
          provider: p.provider || p.id,
          model: p.model || "default",
          status: p.enabled !== false ? "active" as const : "inactive" as const,
          lastError: p.lastError || undefined,
          lastErrorType: p.lastErrorType || undefined,
          successCount: p.successCount || 0,
          failureCount: p.failureCount || 0,
        }));

        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/system/bootstrap-files", (_req: Request, res: Response) => {
      try {
        // Bootstrap files are loaded from the workspace directory (same as agent-model-executor)
        const workspacePath = path.resolve("data", "workspace");
        const files = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"];
        const result = files.map((f) => {
          const filePath = path.join(workspacePath, f);
          const exists = fs.existsSync(filePath);
          return {
            path: f,
            exists,
            size: exists ? fs.statSync(filePath).size : 0,
          };
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/system/bootstrap-file/:file", (req: Request, res: Response) => {
      try {
        const filename = String(req.params.file);
        if (!["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"].includes(filename)) {
          res.status(404).json({ error: "Unknown bootstrap file" });
          return;
        }
        const workspacePath = path.resolve("data", "workspace");
        const filePath = path.join(workspacePath, filename);
        if (!fs.existsSync(filePath)) {
          res.json({ path: filename, content: "", editable: true, exists: false });
          return;
        }
        const content = fs.readFileSync(filePath, "utf8");
        res.json({ path: filename, content, editable: true, exists: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.put("/api/system/bootstrap-file/:file", (req: Request, res: Response) => {
      try {
        const filename = String(req.params.file);
        if (!["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"].includes(filename)) {
          res.status(404).json({ error: "Unknown bootstrap file" });
          return;
        }
        const { content } = req.body || {};
        if (typeof content !== "string") {
          res.status(400).json({ error: "content field (string) is required" });
          return;
        }
        const workspacePath = path.resolve("data", "workspace");
        const filePath = path.join(workspacePath, filename);
        if (!fs.existsSync(path.dirname(filePath))) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
        }
        fs.writeFileSync(filePath, content, "utf8");
        res.json({ success: true, path: filename, bytes: Buffer.byteLength(content, "utf8") });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/config/llm", (_req: Request, res: Response) => {
      try {
        const executor = this.registry.resolveService<{
          getRegisteredTools(): unknown[];
          getProviders(): { id: string; name: string; enabled: boolean; order: number }[];
        }>("agentModelExecutor");
        res.json({
          executorTools: executor?.getRegisteredTools() || [],
          providers: this.savedLLMProviders || [],
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.put("/api/config/llm", (req: Request, res: Response) => {
      try {
        const { providers } = req.body || {};
        if (Array.isArray(providers)) {
          this.savedLLMProviders = providers;
          this.persistLLMProviders(providers);

          this.applyLLMProviders(providers);
        }
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/config/channels", (_req: Request, res: Response) => {
      res.json({ channels: this.savedChannels || [] });
    });

    app.put("/api/config/channels", (req: Request, res: Response) => {
      const { channels } = req.body || {};
      if (Array.isArray(channels)) {
        this.savedChannels = channels;
        this.persistChannels(channels);
      }
      res.json({ success: true });
    });

    app.post("/api/channels/:id/test", (req: Request, res: Response) => {
      try {
        const channelId = String(req.params.id);
        this.eventBus.publish("channel.test", { channelId }, "gateway");
        res.json({ status: "ok", message: `Test initiated for channel ${channelId}` });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/evolution/dashboard", async (_req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getCycleHistory(): Promise<unknown[]>;
          getFeedbackHistory(): unknown[];
          getLearningStats(): unknown;
          getLearningEntries(filter?: Record<string, unknown>): unknown[];
          getLearningSessions(): unknown[];
          getActiveProgressReports(): unknown[];
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.json({ cycles: [], feedback: [], patterns: [], learning: null, summary: { totalCycles: 0, successRate: 0, avgEvaluationScore: 0, totalCandidates: 0 } });
          return;
        }
        const cycles = await evolutionEngine.getCycleHistory();
        const feedback = evolutionEngine.getFeedbackHistory();
        const learning = evolutionEngine.getLearningStats();
        const cycleList = cycles as Array<Record<string, unknown>>;
        res.json({
          cycles,
          feedback,
          patterns: [],
          learning,
          summary: {
            totalCycles: cycleList.length,
            successRate: cycleList.length > 0
              ? cycleList.filter((c) => c.status === "completed").length / cycleList.length
              : 0,
            avgEvaluationScore: 0,
            totalCandidates: cycleList.reduce((sum, c) => sum + ((c.candidates as unknown[])?.length || 0), 0),
          },
        });
      } catch (err) {
        res.status(500).json({ cycles: [], feedback: [], patterns: [], learning: null, summary: { totalCycles: 0, successRate: 0, avgEvaluationScore: 0, totalCandidates: 0 } });
      }
    });

    app.get("/api/evolution/learning/stats", async (_req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getLearningStats(): unknown;
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.json({ totalEntries: 0, resolvedEntries: 0, unresolvedEntries: 0, resolutionRate: 0 });
          return;
        }
        res.json(evolutionEngine.getLearningStats());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/evolution/learning/entries", async (req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getLearningEntries(filter?: Record<string, unknown>): unknown[];
        }>("evolutionEngine");
        if (!evolutionEngine) { res.json([]); return; }
        const filter: Record<string, unknown> = {};
        if (req.query.trigger) filter.trigger = String(req.query.trigger);
        if (req.query.category) filter.category = String(req.query.category);
        if (req.query.resolved !== undefined) filter.resolved = req.query.resolved === "true";
        if (req.query.severity) filter.severity = String(req.query.severity);
        if (req.query.source) filter.source = String(req.query.source);
        if (req.query.tags) filter.tags = String(req.query.tags).split(",");
        if (req.query.limit) filter.limit = parseInt(String(req.query.limit), 10);
        if (req.query.offset) filter.offset = parseInt(String(req.query.offset), 10);
        res.json(evolutionEngine.getLearningEntries(filter));
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/evolution/learning/sessions", async (_req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getLearningSessions(): unknown[];
        }>("evolutionEngine");
        if (!evolutionEngine) { res.json([]); return; }
        res.json(evolutionEngine.getLearningSessions());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/evolution/progress/active", async (_req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getActiveProgressReports(): unknown[];
        }>("evolutionEngine");
        if (!evolutionEngine) { res.json([]); return; }
        res.json(evolutionEngine.getActiveProgressReports());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/learning/correction", async (req: Request, res: Response) => {
      try {
        const { title, context, originalError, correction, preferredApproach, source, tags, triggerEvolution } = req.body || {};
        this.eventBus.publish("user.correction_received", {
          title, context, originalError, correction, preferredApproach,
          source: source || "api", tags, triggerEvolution,
          taskId: `correction-${Date.now()}`,
          description: title || context,
        }, "protocol-adapter");
        res.status(202).json({ status: "recorded", message: "Correction learning entry created" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/learning/gap", async (req: Request, res: Response) => {
      try {
        const { capability, title, context, suggestedSolution, source, tags, triggerEvolution } = req.body || {};
        this.eventBus.publish("capability.gap_detected", {
          capability, title: title || capability, context, suggestedSolution,
          source: source || "api", tags, triggerEvolution,
          taskId: `gap-${Date.now()}`,
          description: context || `缺少能力: ${capability || ""}`,
        }, "protocol-adapter");
        res.status(202).json({ status: "recorded", message: "Capability gap recorded" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/learning/failure", async (req: Request, res: Response) => {
      try {
        const { service, endpoint, error: errorMsg, context, rootCause, fallback, fallbackCode, source, severity, tags, triggerEvolution } = req.body || {};
        this.eventBus.publish("external.failure_detected", {
          service, endpoint, error: errorMsg, context, rootCause, fallback, fallbackCode,
          source: source || "api", severity, tags, triggerEvolution,
          taskId: `failure-${Date.now()}`,
          description: context || `外部依赖失败: ${service || endpoint || ""}`,
        }, "protocol-adapter");
        res.status(202).json({ status: "recorded", message: "External failure recorded" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/learning/improvement", async (req: Request, res: Response) => {
      try {
        const { title, description, context, isOutdated, newApproach, recommendedAction, improvedCode, source, tags, triggerEvolution } = req.body || {};
        this.eventBus.publish("knowledge.improvement_found", {
          title, description, context, isOutdated, newApproach, recommendedAction, improvedCode,
          source: source || "api", tags, triggerEvolution,
          taskId: `improvement-${Date.now()}`,
        }, "protocol-adapter");
        res.status(202).json({ status: "recorded", message: "Knowledge improvement recorded" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/trigger", async (req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          triggerManualEvolution(targetSkill: string | null, description: string, source?: string): Promise<{ id: string; status: string; source: string; startedAt: Date }>;
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.status(503).json({ error: "Evolution engine not available" });
          return;
        }
        const { targetSkill, description, source } = req.body || {};
        if (!description) {
          res.status(400).json({ error: "Description is required" });
          return;
        }
        const cycle = await evolutionEngine.triggerManualEvolution(
          targetSkill || null,
          description,
          source
        );
        res.json({ success: true, cycle: { id: cycle.id, status: cycle.status, source: cycle.source, startedAt: cycle.startedAt } });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/trigger-skill", async (req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          triggerSkillEvolution(skillId: string, skillName: string, errorInfo?: string): Promise<{ id: string; status: string; source: string; startedAt: Date }>;
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.status(503).json({ error: "Evolution engine not available" });
          return;
        }
        const { skillId, skillName, errorInfo } = req.body || {};
        if (!skillId || !skillName) {
          res.status(400).json({ error: "skillId and skillName are required" });
          return;
        }
        const cycle = await evolutionEngine.triggerSkillEvolution(skillId, skillName, errorInfo);
        res.json({ success: true, cycle: { id: cycle.id, status: cycle.status, source: cycle.source, startedAt: cycle.startedAt } });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/feedback", async (req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          submitUserFeedback(cycleId: string, adopted: boolean, comment?: string): Promise<void>;
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.status(503).json({ error: "Evolution engine not available" });
          return;
        }
        const { cycleId, adopted, comment } = req.body || {};
        if (!cycleId || adopted === undefined) {
          res.status(400).json({ error: "cycleId and adopted are required" });
          return;
        }
        await evolutionEngine.submitUserFeedback(cycleId, adopted, comment);
        res.json({ success: true, message: "Feedback recorded" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/evolution/stats", async (_req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getEvolutionStats(): Record<string, unknown>;
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.status(503).json({ error: "Evolution engine not available" });
          return;
        }
        res.json(evolutionEngine.getEvolutionStats());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/system/audit", async (req: Request, res: Response) => {
      try {
        const auditCenter = this.registry.resolveService<{
          query(query: Record<string, unknown>): { records: unknown[]; total: number };
          getStatistics(): unknown;
          getAlerts(acknowledged?: boolean): unknown[];
        }>("auditCenter");
        if (!auditCenter) {
          res.status(503).json({ error: "Audit center not available" });
          return;
        }
        const stats = auditCenter.getStatistics();
        const alerts = auditCenter.getAlerts(false);
        res.json({ stats, alerts });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/persona/greeting", (_req: Request, res: Response) => {
      try {
        const executor = this.registry.resolveService<{
          getGreeting(): string | null;
          getPersona(): { name: string; title: string; masterTerm: string; tone: string };
          hasBeenGreeted(): boolean;
        }>("agentModelExecutor");
        if (!executor) {
          res.json({
            greeting: "您好主人！我是 EvoClaw小助手 您的专属EvoClaw智能助理 🦞\n\n很高兴为您服务！有什么需要，随时吩咐我！",
            name: "EvoClaw小助手",
            masterTerm: "主人",
            isFirstSession: true,
          });
          return;
        }
        const greeting = executor.getGreeting();
        const persona = executor.getPersona();
        res.json({
          greeting: greeting || "",
          name: persona.name,
          masterTerm: persona.masterTerm,
          isFirstSession: greeting !== null,
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/permission/approve", async (req: Request, res: Response) => {
      try {
        const { requestId, whitelist } = req.body || {};
        if (!requestId) {
          res.status(400).json({ error: "requestId is required" });
          return;
        }

        const permMgr = this.registry.resolveService<{
          approveRequest(id: string, addToWhitelist?: boolean): { id: string; operation: string; target: string; status: string } | undefined;
          denyRequest(id: string): { id: string; operation: string; target: string; status: string } | undefined;
          getPendingRequests(): Array<{ id: string; operation: string; target: string; description: string; status: string }>;
          addToWhitelist(operation: string, target: string): unknown;
          removeFromWhitelist(operation: string, target: string): boolean;
          getWhitelist(): Array<{ operation: string; targetPattern: string; createdAt: Date }>;
        }>("permissionManager");

        if (!permMgr) {
          res.status(503).json({ error: "Permission manager not available" });
          return;
        }

        const result = permMgr.approveRequest(String(requestId), whitelist === true);
        if (!result) {
          res.status(404).json({ error: "Request not found or already processed" });
          return;
        }

        res.json({ success: true, request: result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/permission/deny", async (req: Request, res: Response) => {
      try {
        const { requestId } = req.body || {};
        if (!requestId) {
          res.status(400).json({ error: "requestId is required" });
          return;
        }

        const permMgr = this.registry.resolveService<{
          denyRequest(id: string): { id: string; operation: string; target: string; status: string } | undefined;
          getPendingRequests(): Array<{ id: string; operation: string; target: string; description: string; status: string }>;
        }>("permissionManager");

        if (!permMgr) {
          res.status(503).json({ error: "Permission manager not available" });
          return;
        }

        const result = permMgr.denyRequest(String(requestId));
        if (!result) {
          res.status(404).json({ error: "Request not found or already processed" });
          return;
        }

        res.json({ success: true, request: result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/permission/requests", async (_req: Request, res: Response) => {
      try {
        const permMgr = this.registry.resolveService<{
          getPendingRequests(): Array<{ id: string; operation: string; target: string; description: string; status: string }>;
        }>("permissionManager");

        if (!permMgr) {
          res.json({ requests: [] });
          return;
        }

        res.json({ requests: permMgr.getPendingRequests() });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/permission/whitelist", async (_req: Request, res: Response) => {
      try {
        const permMgr = this.registry.resolveService<{
          getWhitelist(): Array<{ operation: string; targetPattern: string; createdAt: Date }>;
        }>("permissionManager");

        if (!permMgr) {
          res.json({ whitelist: [] });
          return;
        }

        res.json({ whitelist: permMgr.getWhitelist() });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.delete("/api/permission/whitelist", async (req: Request, res: Response) => {
      try {
        const { operation, target } = req.body || {};
        if (!operation || !target) {
          res.status(400).json({ error: "operation and target are required" });
          return;
        }

        const permMgr = this.registry.resolveService<{
          removeFromWhitelist(operation: string, target: string): boolean;
        }>("permissionManager");

        if (!permMgr) {
          res.status(503).json({ error: "Permission manager not available" });
          return;
        }

        const removed = permMgr.removeFromWhitelist(String(operation), String(target));
        res.json({ success: removed });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/cli/execute", async (req: Request, res: Response) => {
      try {
        const { command } = req.body || {};
        if (!command || typeof command !== "string") {
          res.status(400).json({ error: "Command is required" });
          return;
        }

        const validation = validateCliCommand(command);
        if (!validation.valid) {
          res.status(400).json({ error: validation.reason || "Invalid command" });
          return;
        }

        const startTime = Date.now();
        const result = await executeCliCommand(command);
        const duration = Date.now() - startTime;

        if (result.timedOut) {
          res.json({
            success: false,
            output: result.stdout || result.stderr || "",
            error: result.stderr || "Command timed out after 30 seconds",
            exitCode: -1,
            duration,
            timedOut: true,
          });
          return;
        }

        res.json({
          success: result.exitCode === 0,
          output: result.stdout || result.stderr || "",
          error: result.exitCode !== 0 ? (result.stderr || `Command exited with code ${result.exitCode}`) : null,
          exitCode: result.exitCode,
          duration,
          timedOut: false,
        });
      } catch (err) {
        this.handleError(err, res, "CLI execution failed");
      }
    });

    // ─── Plugin API routes ──────────────────────────────────────────────────

    app.get("/api/plugins", async (_req: Request, res: Response) => {
      try {
        const pluginManager = this.registry.resolveService("pluginManager") as { getPlugins(): Array<{ manifest: { name: string; version: string; description: string; author?: string }; status: string; error?: string }> } | undefined;
        const localizationService = this.registry.resolveService<{
          needsChineseTranslation(text: string): boolean;
          translateToChinese(text: string, context?: string): Promise<string>;
        }>("localizationService");

        const plugins = pluginManager?.getPlugins() ?? [];

        const enrichedPlugins = await Promise.all(plugins.map(async (p) => {
          const result: Record<string, unknown> = {
            manifest: p.manifest,
            status: p.status,
            error: p.error,
          };

          if (localizationService && p.manifest.description && localizationService.needsChineseTranslation(p.manifest.description)) {
            try {
              const description_zh = await localizationService.translateToChinese(p.manifest.description, `插件"${p.manifest.name}"的描述`);
              if (description_zh && description_zh !== p.manifest.description) {
                result.i18n = { description_zh, translatedAt: new Date().toISOString() };
              }
            } catch { /* non-critical */ }
          }

          return result;
        }));

        res.json({
          success: true,
          plugins: enrichedPlugins,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to list plugins");
      }
    });

    app.post("/api/plugins/install", async (req: Request, res: Response) => {
      try {
        let { name, version, source } = req.body;
        if (!name) {
          res.status(400).json({ success: false, error: "Plugin name is required" });
          return;
        }

        // Strip @tag suffix from name if present (e.g. "@scope/pkg@latest" → "@scope/pkg")
        const lastAt = name.lastIndexOf("@");
        if (lastAt > 0 && !name.slice(0, lastAt).endsWith("/")) {
          const possibleTag = name.slice(lastAt + 1);
          if (/^[a-zA-Z0-9._-]+$/.test(possibleTag)) {
            name = name.slice(0, lastAt);
          }
        }

        const pluginManager = this.registry.resolveService("pluginManager") as {
          registerPlugin(plugin: unknown): Promise<void>;
          getPlugins(): Array<{ manifest: { name: string; version: string; description: string }; status: string; error?: string }>;
        } | undefined;

        if (!pluginManager) {
          res.status(503).json({ error: "Plugin manager not available" });
          return;
        }

        // Try to dynamically import built-in plugin
        try {
          const { BUILTIN_PLUGIN_FACTORIES } = await import("@evoclaw/agent/plugins");
          const factory = BUILTIN_PLUGIN_FACTORIES.find((f: () => { manifest: { name: string } }) => {
            try { return f().manifest.name.toLowerCase() === name.toLowerCase(); } catch { return false; }
          });
          if (factory) {
            const plugin = factory();
            await pluginManager.registerPlugin(plugin);
            res.json({ success: true, message: `Plugin "${plugin.manifest.name}" installed`, plugin: { name: plugin.manifest.name, version: plugin.manifest.version } });
            return;
          }
        } catch {
          // Dynamic import may fail if @evoclaw/agent is not built
        }

        // Fallback: create a minimal stub plugin for community/third-party plugins
        // This allows any plugin name to be installed as a lightweight passthrough
        const existing = pluginManager.getPlugins().find((p) => p.manifest.name.toLowerCase() === name.toLowerCase());
        if (existing) {
          res.json({ success: true, message: `Plugin "${name}" is already installed`, plugin: { name: existing.manifest.name, version: existing.manifest.version } });
          return;
        }

        const stubPlugin = {
          manifest: {
            name,
            version: version || "0.1.0",
            description: `${name} — community plugin`,
            author: source || "community",
          },
          hooks: [],
          async init() {
            console.log(`[PluginManager] Community plugin "${name}" initialized (stub)`);
          },
          async shutdown() {},
          async healthCheck() {
            return { healthy: true, message: "Active (community stub)" };
          },
        };
        await pluginManager.registerPlugin(stubPlugin);
        res.json({ success: true, message: `Plugin "${name}" installed (community)`, plugin: { name, version: version || "0.1.0" } });
      } catch (err) {
        this.handleError(err, res, "Failed to install plugin");
      }
    });

    app.delete("/api/plugins/:name", async (req: Request, res: Response) => {
      try {
        const name = String(req.params.name);
        const pluginManager = this.registry.resolveService("pluginManager") as { unregisterPlugin(name: string): Promise<void> } | undefined;
        if (pluginManager) {
          await pluginManager.unregisterPlugin(name);
        }
        res.json({ success: true, message: `Plugin "${name}" removed` });
      } catch (err) {
        this.handleError(err, res, "Failed to remove plugin");
      }
    });

    app.post("/api/plugins/:name/toggle", (req: Request, res: Response) => {
      try {
        const name = String(req.params.name);
        const { status } = req.body;
        if (status !== "enabled" && status !== "disabled") {
          res.status(400).json({ error: "Invalid status, must be 'enabled' or 'disabled'" });
          return;
        }
        const pluginManager = this.registry.resolveService("pluginManager") as { setPluginStatus(name: string, status: "active" | "disabled"): void } | undefined;
        if (pluginManager) {
          pluginManager.setPluginStatus(name, status === "enabled" ? "active" : "disabled");
        }
        res.json({ success: true, name, status });
      } catch (err) {
        this.handleError(err, res, "Failed to toggle plugin");
      }
    });

    // ─── Scheduler / Cron API routes ────────────────────────────────────────

    app.get("/api/scheduler/tasks", (_req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          listTasks(): Array<Record<string, unknown>>;
          getStats(): Record<string, unknown>;
        } | undefined;
        if (!scheduleManager) {
          res.json({ tasks: [], stats: { totalTasks: 0, activeTasks: 0, totalRuns: 0, totalErrors: 0 } });
          return;
        }
        const tasks = scheduleManager.listTasks();
        const stats = scheduleManager.getStats();
        res.json({ success: true, tasks, stats });
      } catch (err) {
        this.handleError(err, res, "Failed to list scheduler tasks");
      }
    });

    app.post("/api/scheduler/tasks", (req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          createTask(opts: {
            name: string;
            cronExpression: string;
            description?: string;
            handlerType: string;
            handlerConfig?: Record<string, unknown>;
            enabled?: boolean;
          }): Record<string, unknown>;
        } | undefined;
        if (!scheduleManager) {
          res.status(503).json({ error: "Scheduler not available" });
          return;
        }

        const { name, cronExpression, description, handlerType, enabled } = req.body || {};
        if (!name || !cronExpression) {
          res.status(400).json({ error: "name and cronExpression are required" });
          return;
        }
        if (/[;|$`&\n\r]/.test(cronExpression)) {
          res.status(400).json({ error: "cronExpression contains invalid characters" });
          return;
        }

        // Map Web UI handler types to ScheduleManager handler types
        const handlerTypeMap: Record<string, string> = {
          system: "system_cleanup",
          skills: "custom",
          memory: "custom",
          chat: "custom",
          email_check: "email_check",
          report_generate: "report_generate",
          browser_action: "browser_action",
          system_cleanup: "system_cleanup",
          custom: "custom",
        };
        const mappedHandlerType = handlerTypeMap[handlerType] || "custom";

        const task = scheduleManager.createTask({
          name,
          cronExpression,
          description: description || "",
          handlerType: mappedHandlerType as "email_check" | "report_generate" | "browser_action" | "system_cleanup" | "custom",
          enabled: enabled !== false,
        });

        res.status(201).json({ success: true, task });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    });

    app.put("/api/scheduler/tasks/:taskId", (req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          updateTask(taskId: string, updates: Record<string, unknown>): Record<string, unknown> | null;
        } | undefined;
        if (!scheduleManager) {
          res.status(503).json({ error: "Scheduler not available" });
          return;
        }

        const taskId = String(req.params.taskId);
        const updates: Record<string, unknown> = {};
        if (req.body.name !== undefined) updates.name = req.body.name;
        if (req.body.cronExpression !== undefined) updates.cronExpression = req.body.cronExpression;
        if (req.body.description !== undefined) updates.description = req.body.description;
        if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;

        const result = scheduleManager.updateTask(taskId, updates);
        if (!result) {
          res.status(404).json({ error: "Task not found" });
          return;
        }
        res.json({ success: true, task: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    });

    app.delete("/api/scheduler/tasks/:taskId", (req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          deleteTask(taskId: string): boolean;
        } | undefined;
        if (!scheduleManager) {
          res.status(503).json({ error: "Scheduler not available" });
          return;
        }

        const taskId = String(req.params.taskId);
        const removed = scheduleManager.deleteTask(taskId);
        if (!removed) {
          res.status(404).json({ error: "Task not found" });
          return;
        }
        res.json({ success: true });
      } catch (err) {
        this.handleError(err, res, "Failed to delete task");
      }
    });

    app.post("/api/scheduler/tasks/:taskId/run", async (req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          executeTask(taskId: string): Promise<Record<string, unknown>>;
        } | undefined;
        if (!scheduleManager) {
          res.status(503).json({ error: "Scheduler not available" });
          return;
        }

        const taskId = String(req.params.taskId);
        const result = await scheduleManager.executeTask(taskId);
        res.json({ success: result.success, result });
      } catch (err) {
        this.handleError(err, res, "Failed to execute task");
      }
    });

    app.get("/api/scheduler/history", (req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          getRunHistory(taskId?: string, limit?: number): Array<Record<string, unknown>>;
        } | undefined;
        if (!scheduleManager) {
          res.json({ history: [] });
          return;
        }
        const taskId = req.query.taskId as string | undefined;
        const limit = parseInt(String(req.query.limit || "20"), 10) || 20;
        const history = scheduleManager.getRunHistory(taskId, limit);
        res.json({ success: true, history });
      } catch (err) {
        this.handleError(err, res, "Failed to get scheduler history");
      }
    });

    // ─── Session API routes ─────────────────────────────────────────────────

    app.get("/api/sessions", (_req: Request, res: Response) => {
      try {
        const sessionManager = this.registry.resolveService("sessionManager") as {
          listAgents(): string[];
          listSessions(agentId: string): Array<{ sessionId: string; agentId: string; status: string; turnCount: number; createdAt: string; updatedAt: string }>;
        } | undefined;

        if (!sessionManager) {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.json({ success: true, sessions: [] });
          return;
        }

        const agents = sessionManager.listAgents();
        const allSessions: unknown[] = [];
        for (const agentId of agents) {
          const sessions = sessionManager.listSessions(agentId);
          for (const s of sessions) {
            allSessions.push(s);
          }
        }

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.json({ success: true, sessions: allSessions });
      } catch (err) {
        this.handleError(err, res, "Failed to list sessions");
      }
    });

    app.get("/api/sessions/:agentId/:sessionId", (req: Request, res: Response) => {
      try {
        const agentId = String(req.params.agentId);
        const sessionId = String(req.params.sessionId);
        const sessionManager = this.registry.resolveService("sessionManager") as {
          loadSession(agentId: string, sessionId: string): { session: Record<string, unknown>; turns: Array<Record<string, unknown>>; predecessorId?: string; successorId?: string } | null;
        } | undefined;

        if (!sessionManager) {
          res.status(404).json({ success: false, error: "Session manager not available" });
          return;
        }

        const result = sessionManager.loadSession(agentId, sessionId);
        if (!result) {
          res.status(404).json({ success: false, error: "Session not found" });
          return;
        }

        res.json({ success: true, ...result });
      } catch (err) {
        this.handleError(err, res, "Failed to load session");
      }
    });

    app.post("/api/sessions", (req: Request, res: Response) => {
      try {
        const { agentId, sessionId } = req.body;
        const sessionManager = this.registry.resolveService("sessionManager") as {
          createSession(agentId: string, options?: { sessionId?: string }): Record<string, unknown>;
        } | undefined;

        if (!sessionManager) {
          res.status(500).json({ success: false, error: "Session manager not available" });
          return;
        }

        const session = sessionManager.createSession(agentId ?? "default", { sessionId });
        res.json({ success: true, session });
      } catch (err) {
        this.handleError(err, res, "Failed to create session");
      }
    });

    app.delete("/api/sessions/:agentId/:sessionId", (req: Request, res: Response) => {
      try {
        const agentId = String(req.params.agentId);
        const sessionId = String(req.params.sessionId);
        const sessionManager = this.registry.resolveService("sessionManager") as {
          deleteSession(agentId: string, sessionId: string): boolean;
        } | undefined;

        if (!sessionManager) {
          res.status(500).json({ success: false, error: "Session manager not available" });
          return;
        }

        const success = sessionManager.deleteSession(agentId, sessionId);
        if (success) {
          res.json({ success: true, message: "Session deleted successfully" });
        } else {
          res.status(404).json({ success: false, error: "Session not found" });
        }
      } catch (err) {
        this.handleError(err, res, "Failed to delete session");
      }
    });

    // ─── Channel API routes ──────────────────────────────────────────────────

    app.get("/api/channels/status", (_req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getAllStatuses(): Array<{ type: string; label: string; enabled: boolean; connected: boolean; messageCount: number }>;
        } | undefined;

        res.json({
          success: true,
          channels: channelManager?.getAllStatuses() ?? [],
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get channel status");
      }
    });

    app.get("/api/channels/active", (_req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getActiveChannels(): string[];
        } | undefined;

        res.json({
          success: true,
          activeChannels: channelManager?.getActiveChannels() ?? [],
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get active channels");
      }
    });

    app.get("/api/channels/approved", (req: Request, res: Response) => {
      try {
        const channel = req.query.channel as string;
        const channelManager = this.registry.resolveService("channelManager") as {
          getDMPolicy(channel: string): string;
          isPeerApproved?: (channel: string, peerId: string) => boolean;
        } | undefined;

        res.json({
          success: true,
          channel,
          dmPolicy: channelManager?.getDMPolicy(channel ?? "webchat"),
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get approved peers");
      }
    });

    app.post("/api/channels/pairing/approve", (req: Request, res: Response) => {
      try {
        const { code } = req.body;
        const channelManager = this.registry.resolveService("channelManager") as {
          approvePairing(code: string): boolean;
        } | undefined;

        const result = channelManager?.approvePairing(code ?? "") ?? false;
        res.json({ success: result, message: result ? "Pairing approved" : "Invalid pairing code" });
      } catch (err) {
        this.handleError(err, res, "Failed to approve pairing");
      }
    });

    // ─── WeChat iLink API Proxy ──────────────────────────────────────────

    const WEIXIN_API_BASE = "https://ilinkai.weixin.qq.com";
    const DEFAULT_BOT_TYPE = "3";

    // Request a QR code from WeChat iLink server
    app.post("/api/channels/wechat/pair-request", async (_req: Request, res: Response) => {
      try {
        const url = `${WEIXIN_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_BOT_TYPE)}`;
        const apiRes = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "iLink-App-Id": "bot",
            "iLink-App-ClientVersion": "0",
          },
          body: JSON.stringify({ local_token_list: [] }),
        });
        if (!apiRes.ok) {
          res.status(502).json({ success: false, error: `WeChat API returned ${apiRes.status}` });
          return;
        }
        const data = await apiRes.json() as { qrcode?: string; qrcode_img_content?: string };
        if (!data.qrcode || !data.qrcode_img_content) {
          res.status(502).json({ success: false, error: "WeChat API did not return QR code" });
          return;
        }
        // Return the QR code URL and the internal qrcode key for polling
        res.json({
          success: true,
          qrcodeKey: data.qrcode,
          pairUrl: data.qrcode_img_content,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to request WeChat QR code");
      }
    });

    // Poll WeChat iLink server for QR scan status
    app.get("/api/channels/wechat/pair-status", async (req: Request, res: Response) => {
      const qrcode = req.query.qrcode as string;
      if (!qrcode) {
        res.status(400).json({ error: "Missing qrcode parameter" });
        return;
      }
      try {
        const url = `${WEIXIN_API_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
        const apiRes = await fetch(url, {
          method: "GET",
          headers: {
            "iLink-App-Id": "bot",
            "iLink-App-ClientVersion": "0",
          },
        });
        if (!apiRes.ok) {
          res.status(502).json({ error: `WeChat API returned ${apiRes.status}` });
          return;
        }
        const data = await apiRes.json() as {
          status?: string;
          bot_token?: string;
          ilink_bot_id?: string;
          baseurl?: string;
          ilink_user_id?: string;
        };

        // If confirmed, save credentials
        if (data.status === "confirmed" && data.bot_token && data.ilink_bot_id) {
          try {
            const fs = await import("fs");
            const path = await import("path");
            const os = await import("os");
            const normalizedId = data.ilink_bot_id.replace(/@/g, "-");
            if (normalizedId.includes("..")) {
              throw new Error("Invalid bot ID: path traversal detected");
            }
            const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
            const accountsDir = path.join(stateDir, "openclaw-weixin", "accounts");
            fs.mkdirSync(accountsDir, { recursive: true });
            const accountFile = path.join(accountsDir, `${normalizedId}.json`);
            fs.writeFileSync(accountFile, JSON.stringify({
              token: data.bot_token,
              baseUrl: data.baseurl || WEIXIN_API_BASE,
              savedAt: new Date().toISOString(),
              ...(data.ilink_user_id ? { userId: data.ilink_user_id } : {}),
            }, null, 2), "utf-8");
            // Update accounts index
            const indexPath = path.join(stateDir, "openclaw-weixin", "accounts.json");
            let index: string[] = [];
            try { if (fs.existsSync(indexPath)) index = JSON.parse(fs.readFileSync(indexPath, "utf-8")); } catch { /* */ }
            if (!index.includes(normalizedId)) {
              index.push(normalizedId);
              fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
            }
            // Emit event to start Weixin monitor
            this.eventBus?.publish("weixin:start-monitor", {}, "protocol-adapter");
          } catch (saveErr) {
            console.error("[WeChat] Failed to save credentials:", saveErr);
          }
        }

        res.json(data);
      } catch (err) {
        this.handleError(err, res, "Failed to poll WeChat QR status");
      }
    });

    // Manually start Weixin monitor for configured accounts
    app.post("/api/channels/weixin/start-monitor", async (_req: Request, res: Response) => {
      try {
        // We'll emit an event to notify the server to start the Weixin monitor
        // The actual monitor is managed in the main server class
        this.eventBus?.publish("weixin:start-monitor", {}, "protocol-adapter");
        res.json({ success: true, message: "Weixin monitor start requested" });
      } catch (err) {
        this.handleError(err, res, "Failed to start Weixin monitor");
      }
    });

    // Check Weixin connection status
    app.get("/api/channels/weixin/status", async (_req: Request, res: Response) => {
      try {
        const fs = await import("fs");
        const path = await import("path");
        const os = await import("os");
        const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
        const indexPath = path.join(stateDir, "openclaw-weixin", "accounts.json");

        let connected = false;
        let accountCount = 0;
        try {
          if (fs.existsSync(indexPath)) {
            const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
            accountCount = Array.isArray(index) ? index.length : 0;
            connected = accountCount > 0;
          }
        } catch { /* */ }

        res.json({ success: true, connected, accountCount });
      } catch (err) {
        this.handleError(err, res, "Failed to check Weixin status");
      }
    });

    // ─── WebSocket / Streaming status ────────────────────────────────────────

    app.get("/api/ws/connections", (_req: Request, res: Response) => {
      try {
        const protocolHandler = this.registry.resolveService("protocolHandler") as {
          getConnectionCount(): number;
          getConnectedClients(): Array<{ id: string; role: string; connectedAt: Date; remoteAddress: string }>;
        } | undefined;

        res.json({
          success: true,
          connectionCount: protocolHandler?.getConnectionCount() ?? 0,
          clients: protocolHandler?.getConnectedClients() ?? [],
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get WS connections");
      }
    });

    // ─── Context Engine ─────────────────────────────────────────────────────

    app.get("/api/context/status", (_req: Request, res: Response) => {
      try {
        const contextEngine = this.registry.resolveService("contextEngine") as {
          getConfig(): Record<string, unknown>;
        } | undefined;

        res.json({
          success: true,
          config: contextEngine?.getConfig() ?? {},
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get context config");
      }
    });

    // ─── Event Ledger (ACP event sourcing) ──────────────────────────────────

    app.get("/api/events", (req: Request, res: Response) => {
      try {
        const eventLedger = this.registry.resolveService("eventLedger") as {
          query(query: { sessionId?: string; agentId?: string; type?: string; fromTime?: number; toTime?: number; limit?: number }): Array<Record<string, unknown>>;
          snapshot(): Record<string, unknown>;
        } | undefined;

        if (!eventLedger) {
          res.json({ events: [], total: 0 });
          return;
        }

        const query: Record<string, unknown> = {};
        if (req.query.sessionId) query.sessionId = String(req.query.sessionId);
        if (req.query.agentId) query.agentId = String(req.query.agentId);
        if (req.query.type) query.type = String(req.query.type);
        if (req.query.fromTime) query.fromTime = parseInt(String(req.query.fromTime), 10);
        if (req.query.toTime) query.toTime = parseInt(String(req.query.toTime), 10);
        if (req.query.limit) query.limit = parseInt(String(req.query.limit), 10);

        const events = eventLedger.query(query as any);
        res.json({ events, total: events.length });
      } catch (err) {
        this.handleError(err, res, "Failed to query events");
      }
    });

    app.get("/api/events/snapshot", (_req: Request, res: Response) => {
      try {
        const eventLedger = this.registry.resolveService("eventLedger") as {
          snapshot(): Record<string, unknown>;
        } | undefined;

        if (!eventLedger) {
          res.json({ entries: 0, firstSeq: 0, lastSeq: 0 });
          return;
        }

        res.json(eventLedger.snapshot());
      } catch (err) {
        this.handleError(err, res, "Failed to get event snapshot");
      }
    });

    // ─── Permission Relay ──────────────────────────────────────────────────

    app.get("/api/permission-relay/pending", (_req: Request, res: Response) => {
      try {
        const permissionRelay = this.registry.resolveService("permissionRelay") as {
          getPending(): Array<Record<string, unknown>>;
          getHistory(limit?: number): Array<Record<string, unknown>>;
        } | undefined;

        if (!permissionRelay) {
          res.json({ requests: [] });
          return;
        }

        res.json({ requests: permissionRelay.getPending() });
      } catch (err) {
        this.handleError(err, res, "Failed to get pending permissions");
      }
    });

    app.get("/api/permission-relay/history", (req: Request, res: Response) => {
      try {
        const permissionRelay = this.registry.resolveService("permissionRelay") as {
          getHistory(limit?: number): Array<Record<string, unknown>>;
        } | undefined;

        if (!permissionRelay) {
          res.json({ history: [] });
          return;
        }

        const limit = parseInt(String(req.query.limit || "50"), 10);
        res.json({ history: permissionRelay.getHistory(limit) });
      } catch (err) {
        this.handleError(err, res, "Failed to get permission history");
      }
    });

    app.post("/api/permission-relay/:id/approve", (req: Request, res: Response) => {
      try {
        const permissionRelay = this.registry.resolveService("permissionRelay") as {
          approve(id: string, by?: string): Record<string, unknown> | null;
        } | undefined;

        if (!permissionRelay) {
          res.status(503).json({ error: "Permission relay not available" });
          return;
        }

        const result = permissionRelay.approve(String(req.params.id), "webui");
        if (!result) {
          res.status(404).json({ error: "Request not found" });
          return;
        }
        res.json({ success: true, request: result });
      } catch (err) {
        this.handleError(err, res, "Failed to approve permission");
      }
    });

    app.post("/api/permission-relay/:id/deny", (req: Request, res: Response) => {
      try {
        const permissionRelay = this.registry.resolveService("permissionRelay") as {
          deny(id: string, reason?: string, by?: string): Record<string, unknown> | null;
        } | undefined;

        if (!permissionRelay) {
          res.status(503).json({ error: "Permission relay not available" });
          return;
        }

        const { reason } = req.body || {};
        const result = permissionRelay.deny(String(req.params.id), reason || "Denied by user", "webui");
        if (!result) {
          res.status(404).json({ error: "Request not found" });
          return;
        }
        res.json({ success: true, request: result });
      } catch (err) {
        this.handleError(err, res, "Failed to deny permission");
      }
    });

    // ─── Crestodian (Operations Manager) ───────────────────────────────────

    app.get("/api/crestodian/health", (_req: Request, res: Response) => {
      try {
        const crestodian = this.registry.resolveService("crestodian") as {
          getHealth(): Record<string, unknown>;
          getOverview(): Record<string, unknown>;
          collectDiagnostics(): Record<string, unknown>;
          isAlive(): boolean;
          isReady(): boolean;
        } | undefined;

        if (!crestodian) {
          res.json({ status: "unavailable" });
          return;
        }

        res.json(crestodian.getHealth());
      } catch (err) {
        this.handleError(err, res, "Failed to get health probe");
      }
    });

    app.get("/api/crestodian/overview", (_req: Request, res: Response) => {
      try {
        const crestodian = this.registry.resolveService("crestodian") as {
          getOverview(): Record<string, unknown>;
          renderOverview(): string;
        } | undefined;

        if (!crestodian) {
          res.json({ status: "unavailable", services: [] });
          return;
        }

        res.json(crestodian.getOverview());
      } catch (err) {
        this.handleError(err, res, "Failed to get overview");
      }
    });

    app.get("/api/crestodian/diagnostics", (_req: Request, res: Response) => {
      try {
        const crestodian = this.registry.resolveService("crestodian") as {
          collectDiagnostics(): Record<string, unknown>;
        } | undefined;

        if (!crestodian) {
          res.json({ status: "unavailable" });
          return;
        }

        res.json(crestodian.collectDiagnostics());
      } catch (err) {
        this.handleError(err, res, "Failed to collect diagnostics");
      }
    });

    // ─── Incoming Webhook API routes ────────────────────────────────────────

    app.post("/api/webhooks", (req: Request, res: Response) => {
      try {
        const { id, path: hookPath, method, authToken, action, description, enabled } = req.body || {};
        if (!id || !hookPath || !method || !action) {
          res.status(400).json({ error: "id, path, method, and action are required" });
          return;
        }
        if (method !== "POST" && method !== "GET") {
          res.status(400).json({ error: "method must be POST or GET" });
          return;
        }

        const endpoint = this.incomingWebhookManager.register({
          id,
          path: hookPath,
          method,
          authToken,
          action,
          description,
          enabled: enabled !== false,
        });

        res.status(201).json({ success: true, endpoint });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("already exists")) {
          res.status(409).json({ error: message });
          return;
        }
        this.handleError(err, res, "Failed to create webhook");
      }
    });

    app.get("/api/webhooks", (_req: Request, res: Response) => {
      try {
        const endpoints = this.incomingWebhookManager.list();
        res.json({ success: true, endpoints });
      } catch (err) {
        this.handleError(err, res, "Failed to list webhooks");
      }
    });

    app.get("/api/webhooks/:id", (req: Request, res: Response) => {
      try {
        const endpoint = this.incomingWebhookManager.get(String(req.params.id));
        if (!endpoint) {
          res.status(404).json({ error: "Webhook not found" });
          return;
        }
        res.json({ success: true, endpoint });
      } catch (err) {
        this.handleError(err, res, "Failed to get webhook");
      }
    });

    app.delete("/api/webhooks/:id", (req: Request, res: Response) => {
      try {
        const removed = this.incomingWebhookManager.delete(String(req.params.id));
        if (!removed) {
          res.status(404).json({ error: "Webhook not found" });
          return;
        }
        res.json({ success: true });
      } catch (err) {
        this.handleError(err, res, "Failed to delete webhook");
      }
    });

    app.put("/api/webhooks/:id", (req: Request, res: Response) => {
      try {
        const { path: hookPath, method, authToken, action, description, enabled } = req.body || {};
        const updates: Partial<Omit<WebhookEndpoint, "id" | "createdAt">> = {};
        if (hookPath !== undefined) updates.path = hookPath;
        if (method !== undefined) {
          if (method !== "POST" && method !== "GET") {
            res.status(400).json({ error: "method must be POST or GET" });
            return;
          }
          updates.method = method;
        }
        if (authToken !== undefined) updates.authToken = authToken;
        if (action !== undefined) updates.action = action;
        if (description !== undefined) updates.description = description;
        if (enabled !== undefined) updates.enabled = enabled;

        const endpoint = this.incomingWebhookManager.update(String(req.params.id), updates);
        if (!endpoint) {
          res.status(404).json({ error: "Webhook not found" });
          return;
        }
        res.json({ success: true, endpoint });
      } catch (err) {
        this.handleError(err, res, "Failed to update webhook");
      }
    });

    app.post("/api/webhooks/:id/test", async (req: Request, res: Response) => {
      try {
        const endpoint = this.incomingWebhookManager.get(String(req.params.id));
        if (!endpoint) {
          res.status(404).json({ error: "Webhook not found" });
          return;
        }

        const testHeaders: Record<string, string> = { "content-type": "application/json" };
        if (endpoint.authToken) {
          testHeaders["x-webhook-token"] = endpoint.authToken;
        }

        const testBody = req.body?.testPayload ?? { test: true, timestamp: new Date().toISOString() };
        const result = await this.incomingWebhookManager.trigger(
          endpoint.id,
          endpoint.path,
          endpoint.method,
          testHeaders,
          testBody
        );

        res.json({
          success: result.statusCode >= 200 && result.statusCode < 300,
          statusCode: result.statusCode,
          response: result.response,
          eventLog: result.eventLog,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to test webhook");
      }
    });

    app.all("/hooks/*", async (req: Request, res: Response) => {
      try {
        const requestPath = "/" + req.params[0];
        const requestMethod = req.method.toUpperCase();

        const endpoint = this.incomingWebhookManager.matchEndpoint(requestPath, requestMethod);
        if (!endpoint) {
          res.status(404).json({ error: "No matching webhook endpoint found" });
          return;
        }

        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") {
            headers[key] = value;
          } else if (Array.isArray(value)) {
            headers[key] = value.join(", ");
          }
        }

        const body = req.body ?? {};
        const result = await this.incomingWebhookManager.trigger(
          endpoint.id,
          requestPath,
          requestMethod,
          headers,
          body
        );

        res.status(result.statusCode).json(result.response ?? { received: true });
      } catch (err) {
        this.handleError(err, res, "Webhook processing failed");
      }
    });

    // ─── Device Pairing API routes ──────────────────────────────────────────

    app.post("/api/pairing/init", (req: Request, res: Response) => {
      try {
        const { deviceType, deviceName } = req.body || {};
        if (!deviceType || !["web", "mobile", "desktop", "cli"].includes(deviceType)) {
          res.status(400).json({ error: "deviceType must be one of: web, mobile, desktop, cli" });
          return;
        }

        const devicePairingManager = this.registry.resolveService<{
          initiatePairing(deviceType: string, deviceName: string): { pairingCode: string; challenge: string; expiresAt: Date };
        }>("devicePairingManager");

        if (!devicePairingManager) {
          res.status(503).json({ error: "Device pairing service not available" });
          return;
        }

        const result = devicePairingManager.initiatePairing(deviceType, deviceName || "Unknown");
        res.json({ success: true, ...result });
      } catch (err) {
        this.handleError(err, res, "Failed to initiate pairing");
      }
    });

    app.post("/api/pairing/verify", async (req: Request, res: Response) => {
      try {
        const { pairingCode, publicKey, signature, deviceName } = req.body || {};
        if (!pairingCode || !publicKey || !signature) {
          res.status(400).json({ error: "pairingCode, publicKey, and signature are required" });
          return;
        }

        const devicePairingManager = this.registry.resolveService<{
          completePairing(params: { pairingCode: string; publicKey: string; signature: string; deviceName?: string }): unknown;
        }>("devicePairingManager");

        if (!devicePairingManager) {
          res.status(503).json({ error: "Device pairing service not available" });
          return;
        }

        const device = await devicePairingManager.completePairing({
          pairingCode,
          publicKey,
          signature,
          deviceName,
        });

        if (!device) {
          res.status(401).json({ error: "Pairing verification failed" });
          return;
        }

        res.json({ success: true, device });
      } catch (err) {
        this.handleError(err, res, "Failed to verify pairing");
      }
    });

    app.get("/api/pairing/devices", (_req: Request, res: Response) => {
      try {
        const devicePairingManager = this.registry.resolveService<{
          listTrustedDevices(): unknown[];
        }>("devicePairingManager");

        if (!devicePairingManager) {
          res.json({ devices: [] });
          return;
        }

        res.json({ devices: devicePairingManager.listTrustedDevices() });
      } catch (err) {
        this.handleError(err, res, "Failed to list devices");
      }
    });

    app.delete("/api/pairing/devices/:id", (req: Request, res: Response) => {
      try {
        const devicePairingManager = this.registry.resolveService<{
          removeDevice(deviceId: string): boolean;
          revokeDevice(deviceId: string): boolean;
        }>("devicePairingManager");

        if (!devicePairingManager) {
          res.status(503).json({ error: "Device pairing service not available" });
          return;
        }

        const deviceId = String(req.params.id);
        devicePairingManager.revokeDevice(deviceId);
        const removed = devicePairingManager.removeDevice(deviceId);

        res.json({ success: removed });
      } catch (err) {
        this.handleError(err, res, "Failed to remove device");
      }
    });

    app.post("/api/pairing/challenge", (_req: Request, res: Response) => {
      try {
        const devicePairingManager = this.registry.resolveService<{
          generateChallenge(): string;
        }>("devicePairingManager");

        if (!devicePairingManager) {
          res.status(503).json({ error: "Device pairing service not available" });
          return;
        }

        const challenge = devicePairingManager.generateChallenge();
        res.json({ challenge });
      } catch (err) {
        this.handleError(err, res, "Failed to generate challenge");
      }
    });

    // ─── Failover API routes ──────────────────────────────────────────────

    app.get("/api/system/failover/status", (_req: Request, res: Response) => {
      try {
        const failoverManager = this.registry.resolveService("failoverManager") as ModelFailoverManager | undefined;

        if (!failoverManager) {
          res.json({ status: "unavailable", message: "Failover manager not registered" });
          return;
        }

        res.json({
          status: "active",
          summary: failoverManager.getSummary(),
          providers: failoverManager.getAllHealth(),
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get failover status");
      }
    });

    app.post("/api/system/failover/reset", (req: Request, res: Response) => {
      try {
        const failoverManager = this.registry.resolveService("failoverManager") as ModelFailoverManager | undefined;

        if (!failoverManager) {
          res.json({ status: "unavailable", message: "Failover manager not registered" });
          return;
        }

        const { providerId } = req.body as { providerId?: string };

        if (providerId) {
          failoverManager.resetCircuit(providerId);
          res.json({ status: "ok", message: `Circuit reset for provider "${providerId}"` });
        } else {
          failoverManager.resetAllCircuits();
          res.json({ status: "ok", message: "All circuits reset" });
        }
      } catch (err) {
        this.handleError(err, res, "Failed to reset circuit breaker");
      }
    });
  }
}