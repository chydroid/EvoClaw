import { Express, Request, Response } from "express";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
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

  if (!trimmed.startsWith("ecoclaw ")) return { valid: false, reason: 'Commands must start with "ecoclaw" (e.g. ecoclaw --help)' };

  return { valid: true };
}

function executeCliCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const args = command.replace(/^ecoclaw\s*/, "").trim().split(/\s+/).filter(Boolean);

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

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

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

    app.get("/api/skills", async (_req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          listSkills(): Promise<unknown[]>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
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
        const result = await skillManager.scanAndInstall("skills");
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
        if (!message.trim()) {
          res.status(400).json({ error: "Message is required" });
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

        const result = await agentExecutor.chat(message, {
          sessionId: req.body.sessionId || "web-ui",
        });

        res.json({
          reply: result.reply,
          tokensUsed: result.tokensUsed,
          duration: result.duration,
          permissionRequests: result.permissionRequests || [],
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/system/services", (_req: Request, res: Response) => {
      const infos = this.registry.getAllServiceInfos?.() || [];
      res.json(infos);
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
            greeting: "您好主人！我是 EcoClaw小助手 您的专属EcoClaw智能助理 🦞\n\n很高兴为您服务！有什么需要，随时吩咐我！",
            name: "EcoClaw小助手",
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
  }
}