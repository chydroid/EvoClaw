import dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

function getServerVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../../../../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.version) return pkg.version;
    }
  } catch {}
  return "0.9.5";
}
const SERVER_VERSION = getServerVersion();

import { ServiceRegistry, EventBus, SystemEvents, ConfigManager, type PersonaConfig, PluginManager, ConfigValidator, ConfigWatcher, CONFIG_SCHEMA, printMigrationHints, FeatureFlagStore } from "@evoclaw/core";
import { GatewayServer, ChannelManager, ProtocolHandler, WeixinPluginAdapter } from "@evoclaw/gateway";
import { TaskOrchestrator, AgentPoolManager, ActorSystem, AgentModelExecutor, TaskPlanner, BootstrapManager, CompactionManager, AgentLifecycleManager, QueueManager, SessionManager, ContextEngine, AgentRouter, SubagentRegistry, AutoReplyEngine, CommitmentManager, EventLedger, handleChatCommand, dispatchCommand } from "@evoclaw/agent";
import type { AgentConfig, AgentBinding } from "@evoclaw/agent";
import { SkillManager, AutoSkillManager, SkillDispatcher } from "@evoclaw/skills";
import { EvolutionEngine } from "@evoclaw/evolution";
import { MemoryHub, SemanticMemoryStore, MemoryHost } from "@evoclaw/memory";
import { SecurityGovernor, AuditCenter, TenantManager, SelfHealingManager, PermissionManager, ErrorRecoveryManager, ToolPolicyManager, DMPairingManager, PermissionRelay } from "@evoclaw/security";
import { MessageQueue, ProcessManager, FileSystemManager, BrowserController, PlaywrightBrowser, Logger, Crestodian, Observability } from "@evoclaw/infrastructure";
import { EmailClient } from "@evoclaw/email";
import type { EmailAccount, ParsedEmail } from "@evoclaw/email";
import { ScheduleManager, CronScheduler } from "@evoclaw/scheduler";
import type { ScheduledTask } from "@evoclaw/scheduler";
import { ReportGenerator } from "@evoclaw/reporting";
import type { ReportData, ReportSection } from "@evoclaw/reporting";
import { TaskClassifier, SkillOrchestrator } from "@evoclaw/intelligence";
import type { ClassificationResult, OrchestrationPlan } from "@evoclaw/intelligence";
import { SecurityMiddleware } from "@evoclaw/security";
import { CopilotRouter, CredentialPool } from "@evoclaw/agent";
import { SkillIndex } from "@evoclaw/skills";

export class EvoClawServer {
  private registry: ServiceRegistry;
  private eventBus: EventBus;
  private configManager: ConfigManager;
  private logger: Logger;

  private gateway: GatewayServer;
  private taskOrchestrator: TaskOrchestrator;
  private agentPool: AgentPoolManager;
  private actorSystem: ActorSystem;
  private agentModelExecutor: AgentModelExecutor;
  private skillManager: SkillManager;
  private evolutionEngine: EvolutionEngine;
  private memoryHub: MemoryHub;
  private securityGovernor: SecurityGovernor;
  private auditCenter: AuditCenter;
  private tenantManager: TenantManager;
  private selfHealing: SelfHealingManager;
  private messageQueue: MessageQueue;
  private processManager: ProcessManager;
  private fileSystemManager: FileSystemManager;
  private autoSkillManager: AutoSkillManager;
  private skillDispatcher: SkillDispatcher;
  private taskPlanner: TaskPlanner;
  private permissionManager: PermissionManager;
  private errorRecoveryManager: ErrorRecoveryManager;
  private browserController: BrowserController;
  private playwrightBrowser: PlaywrightBrowser;
  private emailClient: EmailClient;
  private scheduleManager: ScheduleManager;
  private bootstrapManager: BootstrapManager;
  private compactionManager: CompactionManager;
  private lifecycleManager: AgentLifecycleManager;
  private queueManager: QueueManager;
  private pluginManager: PluginManager;
  private sessionManager: SessionManager;
  private contextEngine: ContextEngine;
  private channelManager: ChannelManager;
  private protocolHandler: ProtocolHandler;
  private reportGenerator: ReportGenerator;
  private taskClassifier: TaskClassifier;
  private skillOrchestrator: SkillOrchestrator;

  // Weixin plugin adapter
  private weixinPluginAdapter: WeixinPluginAdapter;

  // ── New modules (OpenClaw parity) ──
  private agentRouter: AgentRouter;
  private toolPolicyManager: ToolPolicyManager;
  private dmPairingManager: DMPairingManager;
  private semanticMemory: SemanticMemoryStore;
  private subagentRegistry: SubagentRegistry;
  private cronScheduler: CronScheduler;
  private configValidator: ConfigValidator;
  private configWatcher: ConfigWatcher;

  // ── New P0/P1 modules ──
  private autoReplyEngine: AutoReplyEngine;
  private commitmentManager: CommitmentManager;
  private memoryHost: MemoryHost;

  // ── ACP + Operations modules (Round 4) ──
  private eventLedger: EventLedger;
  private permissionRelay: PermissionRelay;
  private crestodian: Crestodian;
  private observability: Observability;
  private securityMiddleware: SecurityMiddleware;
  private copilotRouter: CopilotRouter;
  private credentialPool: CredentialPool;
  private skillIndex: SkillIndex;
  private featureFlagStore: FeatureFlagStore;

  constructor() {
    this.registry = new ServiceRegistry();
    this.eventBus = new EventBus();
    this.configManager = new ConfigManager();
    this.configManager.loadFromEnv();

    // ── Initialize structured logger (OpenClaw parity) ──
    this.logger = Logger.getInstance({
      minLevel: (process.env.LOG_LEVEL as any) || "info",
      prettyPrint: process.env.NODE_ENV !== "production",
    });
    this.registry.registerService("logger", this.logger);

    this.observability = new Observability({ metricsPrefix: "evoclaw" });
    this.observability.registerMetric({ name: "evoclaw_llm_calls_total", type: "counter", help: "Total LLM API calls", labels: ["provider", "model", "status"] });
    this.observability.registerMetric({ name: "evoclaw_llm_latency_ms", type: "histogram", help: "LLM call latency in milliseconds", labels: ["provider", "model", "status"] });
    this.observability.registerMetric({ name: "evoclaw_tool_calls_total", type: "counter", help: "Total tool invocations", labels: ["tool", "status"] });
    this.observability.registerMetric({ name: "evoclaw_tool_latency_ms", type: "histogram", help: "Tool invocation latency in milliseconds", labels: ["tool", "status"] });
    this.observability.registerMetric({ name: "evoclaw_active_sessions", type: "gauge", help: "Currently active sessions" });
    this.observability.registerMetric({ name: "evoclaw_evolution_cycles_total", type: "counter", help: "Total evolution engine cycles" });
    this.registry.registerService("observability", this.observability);
    this.observability.registerHealthComponent("gateway");
    this.observability.registerHealthComponent("taskOrchestrator");
    this.observability.registerHealthComponent("agentPool");
    this.observability.registerHealthComponent("skillManager");
    this.observability.registerHealthComponent("evolutionEngine");
    this.observability.registerHealthComponent("memoryHub");
    this.observability.registerHealthComponent("securityGovernor");
    this.observability.registerHealthComponent("messageQueue");

    this.securityMiddleware = new SecurityMiddleware(this.registry, this.eventBus);

    this.copilotRouter = new CopilotRouter();
    this.registry.registerService("copilotRouter", this.copilotRouter);

    this.credentialPool = new CredentialPool();
    this.registry.registerService("credentialPool", this.credentialPool);

    this.skillIndex = new SkillIndex();
    this.registry.registerService("skillIndex", this.skillIndex);

    // ── Feature Flag Store (runtime feature toggles) ──
    this.featureFlagStore = new FeatureFlagStore({
      environment: process.env.NODE_ENV || "development",
      auditEvaluations: true,
      defaultEnabled: false,
    });
    this.featureFlagStore.registerAll([
      { key: "evolution", description: "自进化引擎 — 自动优化Agent行为和配置", enabled: true, owner: "core", updatedAt: Date.now() },
      { key: "compaction", description: "上下文压缩 — 长对话自动摘要以节省Token", enabled: true, owner: "core", updatedAt: Date.now() },
      { key: "sandbox", description: "技能沙箱 — 在隔离环境中执行用户自定义技能", enabled: true, owner: "security", updatedAt: Date.now() },
      { key: "mcp", description: "MCP协议支持 — Model Context Protocol工具集成", enabled: true, owner: "integration", updatedAt: Date.now() },
      { key: "a2ui", description: "A2UI协议 — Agent驱动的Canvas可视化界面", enabled: true, owner: "canvas", updatedAt: Date.now() },
      { key: "autoSkill", description: "自动技能发现与安装 — 根据任务自动匹配技能", enabled: true, owner: "skills", updatedAt: Date.now() },
      { key: "permissionFastTrack", description: "权限快速通道 — 白名单目录操作自动审批", enabled: true, owner: "security", updatedAt: Date.now() },
      { key: "copilotRouter", description: "Copilot路由 — 低价值任务自动降级到廉价模型", enabled: true, owner: "optimization", updatedAt: Date.now() },
      { key: "hotReload", description: "热重载 — 配置文件变更自动生效无需重启", enabled: true, owner: "devops", updatedAt: Date.now() },
      { key: "semanticMemory", description: "语义记忆 — 基于TF-IDF的语义搜索记忆存储", enabled: true, owner: "memory", updatedAt: Date.now() },
      { key: "selfHealing", description: "自愈管理 — 自动检测和恢复服务异常", enabled: true, owner: "devops", updatedAt: Date.now() },
      { key: "weixinIntegration", description: "微信集成 — 微信公众号/企业微信消息通道", enabled: false, owner: "integration", updatedAt: Date.now() },
      { key: "playwrightBrowser", description: "Playwright浏览器 — 高级网页自动化操作", enabled: true, owner: "browser", updatedAt: Date.now() },
      { key: "emailIntegration", description: "邮件集成 — 邮件收发与分析功能", enabled: false, owner: "integration", updatedAt: Date.now() },
      { key: "scheduledTasks", description: "定时任务 — Cron定时执行预设操作", enabled: true, owner: "scheduler", updatedAt: Date.now() },
      { key: "rolloutCanary", description: "金丝雀发布 — 百分比灰度发布新功能（仅对10%请求启用）", enabled: false, rolloutPercent: 10, owner: "devops", updatedAt: Date.now() },
    ]);
    this.registry.registerService("featureFlagStore", this.featureFlagStore);

    // ── Config validation (OpenClaw parity) ──
    this.configValidator = new ConfigValidator(CONFIG_SCHEMA);
    this.registry.registerService("configValidator", this.configValidator);
    this.registry.registerService("config", this.configManager);

    this.configWatcher = new ConfigWatcher();
    this.configWatcher.onChange((filePath) => {
      this.logger.info("config", `Config file changed: ${filePath}, reloading...`);
      // Re-load configuration from env (hot-reload support)
      this.configManager.loadFromEnv();
    });
    this.registry.registerService("configWatcher", this.configWatcher);

    // ── Agent Router (OpenClaw parity) ──
    this.agentRouter = new AgentRouter({
      defaultAgentId: "default",
      baseWorkspaceDir: path.resolve(__dirname, "..", "..", "..", "data", "workspace"),
      baseSessionsDir: path.resolve(__dirname, "..", "..", "..", "data", "sessions"),
    });
    // Register the default agent
    this.agentRouter.registerAgent({
      id: "default",
      name: "EvoClaw",
      persona: this.configManager.get("persona") || {},
      workspace: path.resolve(__dirname, "..", "..", "..", "data", "workspace"),
      sessionsDir: path.resolve(__dirname, "..", "..", "..", "data", "sessions"),
      enabled: true,
      dmPolicy: "open",
      sandbox: "off",
    });
    this.registry.registerService("agentRouter", this.agentRouter);

    // ── Tool Policy Manager (OpenClaw parity) ──
    this.toolPolicyManager = new ToolPolicyManager();
    this.toolPolicyManager.assignPolicy("default", "main-agent-full-access");
    this.registry.registerService("toolPolicyManager", this.toolPolicyManager);

    // ── DM Pairing Manager (OpenClaw parity) ──
    this.dmPairingManager = new DMPairingManager(this.eventBus, {
      pairingStorePath: path.resolve(__dirname, "..", "..", "..", "data", "pairing-store.json"),
    });
    this.dmPairingManager.setChannelPolicy({
      channel: "webchat",
      policy: (process.env.DM_POLICY as any) || "open",
    });
    this.registry.registerService("dmPairingManager", this.dmPairingManager);

    // ── Semantic Memory (OpenClaw parity, TF-IDF based) ──
    this.semanticMemory = new SemanticMemoryStore({
      threshold: 0.05,
      defaultLimit: 10,
    });
    this.registry.registerService("semanticMemory", this.semanticMemory);

    // ── Subagent Registry (OpenClaw parity) ──
    this.subagentRegistry = new SubagentRegistry(this.eventBus, 10);
    this.registry.registerService("subagentRegistry", this.subagentRegistry);

    // ── Enhanced Cron Scheduler (OpenClaw parity) ──
    this.cronScheduler = new CronScheduler({ maxConcurrentJobs: 5 });
    this.cronScheduler.on("job:start", (record) => {
      this.logger.info("cron", `Job "${record.jobName}" started`, { jobId: record.jobId });
    });
    this.cronScheduler.on("job:complete", (record) => {
      this.logger.info("cron", `Job "${record.jobName}" completed`, { jobId: record.jobId, duration: record.duration });
    });
    this.cronScheduler.on("job:error", (record) => {
      this.logger.error("cron", `Job "${record.jobName}" failed`, record.error);
    });
    this.registry.registerService("cronScheduler", this.cronScheduler);

    // ── Auto-Reply Engine (OpenClaw parity) ──
    this.autoReplyEngine = new AutoReplyEngine(this.eventBus);
    this.autoReplyEngine.configure({
      enabled: true,
      globalCooldownMs: 10_000,
      rules: [
        {
          id: "dm-welcome",
          label: "DM Welcome",
          trigger: "dm",
          template: "你好 {{sender}}！我是 EvoClaw 助手。请问有什么可以帮你的？",
          priority: 10,
          cooldownMs: 60_000,
        },
      ],
    });
    this.registry.registerService("autoReplyEngine", this.autoReplyEngine);

    // ── Commitment Manager (OpenClaw parity) ──
    this.commitmentManager = new CommitmentManager(this.eventBus, {
      storePath: path.resolve(__dirname, "..", "..", "..", "data", "commitments.json"),
    });
    this.registry.registerService("commitmentManager", this.commitmentManager);

    // ── Memory Host SDK (OpenClaw parity) ──
    this.memoryHost = new MemoryHost(
      {
        maxEntries: 10_000,
        defaultTtlMs: 86_400_000, // 24 hours
        storePath: path.resolve(__dirname, "..", "..", "..", "data", "memory-host.json"),
      },
      this.eventBus,
    );
    this.registry.registerService("memoryHost", this.memoryHost);

    // ── Event Ledger (ACP: event sourcing) ──
    this.eventLedger = new EventLedger({
      storeDir: path.resolve(__dirname, "..", "..", "..", "data", "ledger"),
      maxEntriesPerFile: 10_000,
      autoFlushMs: 5_000,
    });
    this.registry.registerService("eventLedger", this.eventLedger);

    // ── Permission Relay (ACP: centralized permission control) ──
    this.permissionRelay = new PermissionRelay(
      {
        autoApprovePatterns: ["file_read", "file_list", "task_status", "skill_search", "error_stats", "permission_status"],
        autoDenyPatterns: [],
        defaultTimeoutMs: 30_000,
        maxPending: 50,
      },
      this.eventBus,
    );
    this.registry.registerService("permissionRelay", this.permissionRelay);

    // ── Crestodian (Daemon Operations Manager) ──
    this.crestodian = new Crestodian(
      {
        checkIntervalMs: 60_000,
        maxOperationHistory: 500,
      },
      this.eventBus,
    );
    // Register all key services with Crestodian for Ops tab health monitoring
    this.crestodian.setServiceHealth("agentModelExecutor", "ok", { version: "1.0" });
    this.crestodian.setServiceHealth("gatewayServer", "ok", { port: process.env.EvoClaw_PORT || "17788" });
    this.crestodian.setServiceHealth("autoSkillManager", "ok");
    this.crestodian.setServiceHealth("skillDispatcher", "ok");
    this.crestodian.setServiceHealth("eventLedger", "ok");
    this.crestodian.setServiceHealth("permissionManager", "ok");
    this.crestodian.setServiceHealth("taskOrchestrator", "ok");
    this.crestodian.setServiceHealth("featureFlagStore", "ok");
    this.registry.registerService("crestodian", this.crestodian);

    this.registry.registerService("registry", this.registry);
    this.registry.registerService("eventBus", this.eventBus);

    this.gateway = new GatewayServer(this.registry, this.eventBus);
    this.taskOrchestrator = new TaskOrchestrator(this.registry, this.eventBus);
    this.registry.registerService("taskOrchestrator", this.taskOrchestrator);
    this.agentPool = new AgentPoolManager(this.registry, this.eventBus);
    this.registry.registerService("agentPool", this.agentPool);
    this.actorSystem = new ActorSystem();
    this.registry.registerService("actorSystem", this.actorSystem);
    this.agentModelExecutor = new AgentModelExecutor(this.registry, this.eventBus, undefined, this.configManager.get("persona"));
    this.skillManager = new SkillManager(this.registry, this.eventBus);
    this.evolutionEngine = new EvolutionEngine(this.registry, this.eventBus);
    // EvolutionEngine self-registers in its constructor — no manual registerService needed
    this.crestodian.setServiceHealth("evolutionEngine", "ok");
    this.memoryHub = new MemoryHub(this.registry, this.eventBus);
    this.agentModelExecutor.setMemoryHub(this.memoryHub);
    this.bootstrapManager = new BootstrapManager(this.configManager);
    this.agentModelExecutor.setBootstrapManager(this.bootstrapManager);
    this.registry.registerService("bootstrapManager", this.bootstrapManager);
    this.bootstrapManager.initialize().then((ctx) => {
      this.logger.info("server", `Bootstrap initialized: bootstrapPending=${ctx.bootstrapPending}, missingFiles=${ctx.missingFiles.join(",") || "none"}`);
    });
    this.compactionManager = new CompactionManager();
    this.agentModelExecutor.setCompactionManager(this.compactionManager);
    this.registry.registerService("compactionManager", this.compactionManager);
    this.lifecycleManager = new AgentLifecycleManager(this.eventBus);
    this.agentModelExecutor.setLifecycleManager(this.lifecycleManager);
    this.registry.registerService("lifecycleManager", this.lifecycleManager);
    this.queueManager = new QueueManager(this.eventBus);
    this.agentModelExecutor.setQueueManager(this.queueManager);
    this.registry.registerService("queueManager", this.queueManager);
    this.queueManager.loadPersistedQueues();
    this.pluginManager = new PluginManager(path.resolve(__dirname, "..", "..", "..", "data", "plugins"));
    this.pluginManager.setEventBus(this.eventBus);
    this.pluginManager.setRegistry(this.registry);
    this.agentModelExecutor.setPluginManager(this.pluginManager);
    this.registry.registerService("pluginManager", this.pluginManager);
    this.sessionManager = new SessionManager({
      sessionsDir: path.resolve(__dirname, "..", "..", "..", "data", "sessions"),
      writeLockTimeoutMs: 60000,
      truncateAfterCompaction: true,
    });
    this.agentModelExecutor.setSessionManager(this.sessionManager);
    this.registry.registerService("sessionManager", this.sessionManager);
    this.contextEngine = new ContextEngine({
      workspacePath: path.resolve(__dirname, "..", "..", "..", "data", "workspace"),
      maxContextTokens: 60000,
      reserveTokens: 4000,
    });
    this.agentModelExecutor.setContextEngine(this.contextEngine);
    this.registry.registerService("contextEngine", this.contextEngine);
    this.channelManager = new ChannelManager(this.eventBus);
    this.agentModelExecutor.setChannelManager(this.channelManager as any);
    this.registry.registerService("channelManager", this.channelManager);
    this.protocolHandler = new ProtocolHandler({
      serverVersion: SERVER_VERSION,
      autoApproveLoopback: true,
    });
    this.protocolHandler.setEventBus(this.eventBus);
    this.registry.registerService("protocolHandler", this.protocolHandler);
    this.securityGovernor = new SecurityGovernor(this.registry, this.eventBus);
    this.auditCenter = new AuditCenter(this.registry, this.eventBus);
    this.tenantManager = new TenantManager(this.registry, this.eventBus);
    this.selfHealing = new SelfHealingManager(this.registry, this.eventBus);
    this.messageQueue = new MessageQueue(this.registry, this.eventBus);
    this.processManager = new ProcessManager(this.registry, this.eventBus);
    this.fileSystemManager = new FileSystemManager(this.registry, this.eventBus);
    this.autoSkillManager = new AutoSkillManager(this.registry, this.eventBus, path.resolve(__dirname, "..", "..", "..", "data", "workspace", "skills"));
    this.skillDispatcher = new SkillDispatcher(this.registry, this.eventBus);
    this.skillDispatcher.initialize();
    this.taskPlanner = new TaskPlanner(this.registry, this.eventBus);
    this.permissionManager = new PermissionManager(this.registry, this.eventBus);
    this.registry.registerService("permissionManager", this.permissionManager);
    this.errorRecoveryManager = new ErrorRecoveryManager(this.registry, this.eventBus);
    this.browserController = new BrowserController(this.registry, this.eventBus);
    this.playwrightBrowser = new PlaywrightBrowser(this.registry, this.eventBus, {
      headless: true,
      cookieStorageDir: path.resolve(__dirname, "..", "..", ".."),
    });
    this.registry.registerService("playwrightBrowser", this.playwrightBrowser);
    this.emailClient = new EmailClient(this.registry, this.eventBus);
    this.registry.registerService("emailClient", this.emailClient);
    this.scheduleManager = new ScheduleManager(this.registry, this.eventBus, {
      dataDir: path.resolve(__dirname, "..", "..", "..", "data", "scheduler"),
    });
    this.registry.registerService("scheduleManager", this.scheduleManager);
    this.reportGenerator = new ReportGenerator(this.registry, this.eventBus, {
      templateDir: path.resolve(__dirname, "..", "..", "..", "packages", "reporting", "src", "templates"),
    });
    this.registry.registerService("reportGenerator", this.reportGenerator);
    this.taskClassifier = new TaskClassifier(this.registry, this.eventBus);
    this.registry.registerService("taskClassifier", this.taskClassifier);
    this.skillOrchestrator = new SkillOrchestrator(this.registry, this.eventBus);
    this.registry.registerService("skillOrchestrator", this.skillOrchestrator);

    // Initialize Weixin plugin adapter
    this.weixinPluginAdapter = new WeixinPluginAdapter(this.eventBus, this.agentModelExecutor);
  }

  async start(): Promise<void> {
    this.logger.info("server", "============================================");
    this.logger.info("server", `  EvoClaw v${SERVER_VERSION} - Self-Evolving Agent OS`);
    this.logger.info("server", "============================================");

    await this.eventBus.publish(SystemEvents.SYSTEM_STARTING, null, "server");

    // ── Compat layer: check for legacy env vars ──
    printMigrationHints();

    const jwtSecret = process.env.JWT_SECRET || "";
    const jwtValidation = this.securityMiddleware.validateJWTSecret(jwtSecret);
    if (!jwtValidation.valid) {
      this.logger.warn("security", `JWT secret validation failed: ${jwtValidation.reason}. Please set a strong JWT_SECRET environment variable.`);
      if (process.env.NODE_ENV === "production") {
        this.logger.fatal("security", "Refusing to start in production with weak JWT secret");
        process.exit(1);
      }
    }

    this.logger.info("server", "Starting all services...");

    this.logger.info("server", "Gateway server starting...");
    await this.gateway.start();

    this.logger.info("server", "Starting Weixin plugin adapter...");
    this.weixinPluginAdapter.startAllConfiguredMonitors();

    // Listen for Weixin monitor start events
    this.eventBus.subscribe("weixin:start-monitor", async (_event) => {
      this.logger.info("server", "Received Weixin monitor start request");
      this.weixinPluginAdapter.startAllConfiguredMonitors();
    });

    this.logger.info("server", "Loading persisted configuration...");
    this.gateway.loadPersistedConfig();

    this.logger.info("server", "Agent pool starting...");
    this.logger.info("server", "Agent pool initialized");

    this.logger.info("server", "Skill manager starting...");
    this.logger.info("server", "Skill manager ready");

    const workspaceDir = path.resolve(__dirname, "..", "..", "..", "data", "workspace");
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }
    const skillsDir = path.join(workspaceDir, "skills");
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
    this.skillManager.startAutoScan(skillsDir, 30000);

    this.eventBus.subscribe(SystemEvents.SKILL_INSTALLED, async (event: any) => {
      try {
        const skill = event?.data;
        if (skill) this.skillIndex.indexSkill(skill);
      } catch { /* non-critical */ }
    });

    this.eventBus.subscribe(SystemEvents.SKILL_UNINSTALLED, async (event: any) => {
      try {
        const skill = event?.data;
        if (skill?.id) this.skillIndex.removeSkill(skill.id);
      } catch { /* non-critical */ }
    });

    this.eventBus.subscribe(SystemEvents.SKILL_EXECUTED, async (event: any) => {
      try {
        const data = event?.data;
        if (data?.skillId) this.skillIndex.updateStats(data.skillId, true);
      } catch { /* non-critical */ }
    });

    this.eventBus.subscribe(SystemEvents.SKILL_FAILED, async (event: any) => {
      try {
        const data = event?.data;
        if (data?.skillId) this.skillIndex.updateStats(data.skillId, false);
      } catch { /* non-critical */ }
    });

    setTimeout(async () => {
      try {
        await this.skillManager.checkAndTranslateInstalledSkills();
      } catch { /* non-critical */ }
    }, 10000);

    const bootstrapFiles = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"];
    for (const fileName of bootstrapFiles) {
      const fpath = path.join(workspaceDir, fileName);
      if (!fs.existsSync(fpath)) {
        fs.writeFileSync(fpath, `# ${fileName.replace(".md", "")}\n\nSee ${workspaceDir}/${fileName} for documentation.\n`, "utf-8");
      }
    }
    this.agentModelExecutor.setWorkspacePath(workspaceDir);
    this.logger.info("server", `Workspace initialized at ${workspaceDir}`);

    // Whitelist workspace and skills directories — file operations within
    // these paths are auto-approved without user confirmation.
    this.permissionManager.addDirectoryWhitelist(workspaceDir, ["file_create", "file_modify", "file_delete"]);
    this.permissionManager.addDirectoryWhitelist(skillsDir, ["file_create", "file_modify", "file_delete"]);
    // Also whitelist project root — bare filenames (like "notes.txt") resolve here
    // because FileSystemManager.setBasePath restricts everything to the project root.
    const projectRoot = path.resolve(__dirname, "..", "..", "..");
    this.permissionManager.addDirectoryWhitelist(projectRoot, ["file_create", "file_modify", "file_delete"]);
    this.logger.info("server", `File operations whitelisted for workspace, skills & project root directories`);

    const fsBase = path.resolve(__dirname, "..", "..", "..");
    this.fileSystemManager.setBasePath(fsBase);
    this.registerFileTools(fsBase);
    this.registerAutoSkillTool();
    this.registerSkillIndexTools();
    this.registerTaskPlannerTool();
    this.registerBootstrapTool();
    this.registerPermissionTools();
    this.registerBrowserTools();

    await this.emailClient.initialize();
    await this.scheduleManager.initialize();
    await this.reportGenerator.initialize();
    this.registerSchedulerTools();
    this.registerReportingTools();
    this.registerIntelligenceTools();
    this.registerMarkItDownTools();

    this.scheduleManager.start();

    // Register all built-in plugins
    try {
      const { BUILTIN_PLUGIN_FACTORIES } = await import("@evoclaw/agent/plugins");
      for (const factory of BUILTIN_PLUGIN_FACTORIES) {
        try {
          const plugin = factory();
          await this.pluginManager.registerPlugin(plugin);
        } catch (err) {
          this.logger.error("server", `Failed to register built-in plugin: ${err}`);
        }
      }
    } catch (err) {
      this.logger.error("server", `Failed to load built-in plugins: ${err}`);
    }

    this.securityMiddleware.registerHooks(this.pluginManager);

    await this.pluginManager.registerPlugin({
      manifest: { name: "copilot-router", version: "1.0.0", description: "Routes low-value tasks to cheaper models" },
      hooks: [
        {
          hookType: "before_model_resolve",
          priority: "normal" as const,
          handler: async (hook: any) => {
            const taskDesc = hook?.context?.text || hook?.context?.message || "";
            if (!taskDesc || !this.copilotRouter) return;
            const currentModel = hook?.model || "unknown";
            const currentProvider = hook?.provider || "unknown";
            const decision = this.copilotRouter.route(taskDesc, currentModel, currentProvider);
            if (decision.shouldDowngrade) {
              hook.model = decision.routedModel;
              hook.provider = decision.routedProvider;
              this.logger.info("copilot", `Routed to ${decision.routedModel} (${decision.routedProvider}): ${decision.reason}`);
              return { model: decision.routedModel, provider: decision.routedProvider };
            }
            return;
          },
        },
      ],
    });

    this.eventBus.subscribe("agent_end", async (event: any) => {
      try {
        const data = event?.data;
        if (!data?.userMessage || !data?.agentResponse) return;
        await this.memoryHub.curateFromTurn(
          data.userMessage,
          data.agentResponse,
          data.context || {},
        );
      } catch { /* non-critical */ }
    });

    this.eventBus.subscribe("memory_stored", async () => {
      try {
        this.memoryHub.freezeMemorySnapshot();
        if (this.contextEngine) {
          this.contextEngine.invalidateFrozen();
        }
      } catch { /* non-critical */ }
    });

    this.logger.info("server", "Evolution engine starting...");
    this.logger.info("server", "Evolution engine online");

    this.logger.info("server", "Memory hub starting...");
    this.logger.info("server", "Memory hub active");

    this.logger.info("server", "Security governor engaged");
    this.logger.info("server", "Audit center online");

    this.logger.info("server", "Tenant manager starting...");
    this.logger.info("server", "Tenant manager ready");

    this.logger.info("server", "Self-healing monitor starting...");
    this.selfHealing.start();

    this.tenantManager.createTenant("default", {
      defaultLanguage: "zh-CN",
      timezone: "Asia/Shanghai",
    });

    await this.eventBus.publish(SystemEvents.SYSTEM_READY, {
      version: SERVER_VERSION,
      serviceCount: this.registry.getRegisteredServices().length,
    }, "server");

    this.logger.info("server", "All systems ready!");
    this.logger.info("server", `Registered services: ${this.registry.getRegisteredServices().join(", ")}`);

    this.eventBus.subscribe("system.shutdown", async () => {
      await this.shutdown();
    });

    process.on("SIGINT", async () => {
      this.logger.info("server", "Received SIGINT");
      await this.shutdown();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      this.logger.info("server", "Received SIGTERM");
      await this.shutdown();
      process.exit(0);
    });

    process.on("uncaughtException", (err) => {
      this.logger.fatal("server", "Uncaught exception", err);
      process.exit(1);
    });

    process.on("unhandledRejection", (reason) => {
      this.logger.error("server", "Unhandled rejection", reason instanceof Error ? reason : new Error(String(reason)));
    });
  }

  async shutdown(): Promise<void> {
    this.logger.info("server", "Shutting down...");
    this.selfHealing.stop();
    this.scheduleManager.stop();
    this.configWatcher.stopAll();
    // Stop Weixin plugin adapter
    this.weixinPluginAdapter.stopAllMonitors();
    this.logger.info("server", "Stopping subsystems...");
    await this.eventBus.publish(SystemEvents.SYSTEM_SHUTTING_DOWN, null, "server");
    await this.processManager.killAll();
    await this.gateway.stop();
    await this.registry.stopAll();
    this.logger.info("server", "Goodbye!");
  }

  private registerFileTools(fsBase: string): void {
    const fsMgr = this.fileSystemManager;
    const errRecovery = this.errorRecoveryManager;
    const permMgr = this.permissionManager;
    const permRelay = this.permissionRelay;

    this.agentModelExecutor.registerTool(
      "file_create",
      {
        name: "file_create",
        description: "Create a new file at the specified path with the given content. If the file already exists and overwrite is true, the file will be replaced. After creating a file, always inform the user of the file path and that they can download it via /api/files/download/{path}.",
        parameters: {
          path: { type: "string", description: "Relative file path to create" },
          content: { type: "string", description: "Content to write to the file" },
          overwrite: { type: "boolean", description: "Whether to overwrite if file already exists (default: false)" },
        },
      },
      async (params: Record<string, unknown>) => {
        const filePath = String(params.path || "");
        const content = String(params.content || "");
        const overwrite = params.overwrite === true;
        const resolvedPath = path.resolve(fsBase, filePath);
        if (permMgr.isPathAutoApproved(resolvedPath, "file_create")) {
          permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_create", description: `创建文件: ${filePath}`, params, category: "file" });
          return await errRecovery.executeWithRetry("file_create", filePath, () => fsMgr.createFile(filePath, content, overwrite));
        }
        const permRequest = permMgr.requestPermission("file_create", filePath, { size: content.length }, "tool");
        if (permRequest.status === "denied") {
          return { success: false, error: `Permission denied for file_create on ${filePath}. Request ID: ${permRequest.id}` };
        }
        if (permRequest.status === "pending") {
          permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_create", description: `创建文件: ${filePath}`, params, category: "file" });
          return { success: false, requiresPermission: true, requestId: permRequest.id, operation: "file_create", description: permRequest.description, target: filePath, error: `Awaiting user approval to create: ${filePath}` };
        }
        return await errRecovery.executeWithRetry("file_create", filePath, () => fsMgr.createFile(filePath, content, overwrite));
      }
    );

    this.agentModelExecutor.registerTool(
      "file_modify",
      {
        name: "file_modify",
        description: "Modify an existing file's content",
        parameters: {
          path: { type: "string", description: "Relative file path to modify" },
          content: { type: "string", description: "New content for the file" },
        },
      },
      async (params: Record<string, unknown>) => {
        const filePath = String(params.path || "");
        const content = String(params.content || "");
        const resolvedPath = path.resolve(fsBase, filePath);
        if (permMgr.isPathAutoApproved(resolvedPath, "file_modify")) {
          permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_modify", description: `修改文件: ${filePath}`, params, category: "file" });
          return await errRecovery.executeWithRetry("file_modify", filePath, () => fsMgr.modifyFile(filePath, content));
        }
        const permRequest = permMgr.requestPermission("file_modify", filePath, { size: content.length }, "tool");
        if (permRequest.status === "denied") {
          return { success: false, error: `Permission denied for file_modify on ${filePath}. Request ID: ${permRequest.id}` };
        }
        if (permRequest.status === "pending") {
          permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_modify", description: `修改文件: ${filePath}`, params, category: "file" });
          return { success: false, requiresPermission: true, requestId: permRequest.id, operation: "file_modify", description: permRequest.description, target: filePath, error: `Awaiting user approval to modify: ${filePath}` };
        }
        return await errRecovery.executeWithRetry("file_modify", filePath, () => fsMgr.modifyFile(filePath, content));
      }
    );

    this.agentModelExecutor.registerTool(
      "file_delete",
      {
        name: "file_delete",
        description: "Delete a file at the specified path",
        parameters: {
          path: { type: "string", description: "Relative file path to delete" },
        },
      },
      async (params: Record<string, unknown>) => {
        const filePath = String(params.path || "");
        const resolvedPath = path.resolve(fsBase, filePath);
        if (permMgr.isPathAutoApproved(resolvedPath, "file_delete")) {
          permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_delete", description: `删除文件: ${filePath}`, params, category: "file" });
          return await errRecovery.executeWithRetry("file_delete", filePath, async () => {
            await fsMgr.deleteFile(filePath);
            return { success: true, path: filePath };
          });
        }
        const permRequest = permMgr.requestPermission("file_delete", filePath, {}, "tool");
        if (permRequest.status === "denied") {
          return { success: false, error: `Permission denied for file_delete on ${filePath}. Request ID: ${permRequest.id}` };
        }
        if (permRequest.status === "pending") {
          permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_delete", description: `删除文件: ${filePath}`, params, category: "file" });
          return { success: false, requiresPermission: true, requestId: permRequest.id, operation: "file_delete", description: permRequest.description, target: filePath, error: `Awaiting user approval to delete: ${filePath}` };
        }
        return await errRecovery.executeWithRetry("file_delete", filePath, async () => {
          await fsMgr.deleteFile(filePath);
          return { success: true, path: filePath };
        });
      }
    );

    this.agentModelExecutor.registerTool(
      "file_read",
      {
        name: "file_read",
        description: "Read the contents of a file",
        parameters: {
          path: { type: "string", description: "Relative file path to read" },
        },
      },
      async (params: Record<string, unknown>) => {
        const filePath = String(params.path || "");
        return await errRecovery.executeWithRetry("file_read", filePath, async () => {
          const content = await fsMgr.readFile(filePath);
          return { path: filePath, content };
        });
      }
    );

    this.agentModelExecutor.registerTool(
      "file_list",
      {
        name: "file_list",
        description: "List files and directories in a folder",
        parameters: {
          path: { type: "string", description: "Relative directory path to list" },
        },
      },
      async (params: Record<string, unknown>) => {
        const dirPath = String(params.path || ".");
        return await errRecovery.executeWithRetry("file_list", dirPath, () => fsMgr.listAll(dirPath));
      }
    );
  }

  private registerAutoSkillTool(): void {
    const autoSkill = this.autoSkillManager;

    this.agentModelExecutor.registerTool(
      "skill_find_and_install",
      {
        name: "skill_find_and_install",
        description: "Automatically find a suitable skill for a task and install it",
        parameters: {
          task: { type: "string", description: "Description of the task to find a skill for" },
        },
      },
      async (params: Record<string, unknown>) => {
        const task = String(params.task || "");
        return await autoSkill.autoInstallForTask(task);
      }
    );

    // ---- Skill lifecycle tools ----

    this.agentModelExecutor.registerTool(
      "skill_install",
      {
        name: "skill_install",
        description: "Install a skill from its SKILL.md file path or skills directory. Use after skill_search finds a match.",
        parameters: {
          path: { type: "string", description: "Path to the SKILL.md file or skill folder" },
        },
      },
      async (params: Record<string, unknown>) => {
        const skillPath = String(params.path || "");
        try {
          const installed = await this.skillManager.installSkill(skillPath);
          return { success: true, skillId: installed.id, skillName: installed.name, description: installed.description };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    );

    this.agentModelExecutor.registerTool(
      "skill_execute",
      {
        name: "skill_execute",
        description: "Execute an installed skill by name or ID with parameters",
        parameters: {
          skill: { type: "string", description: "Skill name or ID to execute" },
          params: { type: "string", description: "JSON string of parameters to pass to the skill" },
        },
      },
      async (params: Record<string, unknown>) => {
        const skillName = String(params.skill || "");
        const execParams = JSON.parse(String(params.params || "{}"));
        try {
          const result = await this.skillManager.executeSkill(skillName, execParams);
          return { success: true, result };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    );

    this.agentModelExecutor.registerTool(
      "skill_create",
      {
        name: "skill_create",
        description: "Auto-create a new Skill file when no existing skill matches the task. Generates a SKILL.md and installs it.",
        parameters: {
          name: { type: "string", description: "Name for the new skill (e.g. 'news-search')" },
          description: { type: "string", description: "What this skill does" },
          instructions: { type: "string", description: "Step-by-step instructions for the skill to execute" },
        },
      },
      async (params: Record<string, unknown>) => {
        const name = String(params.name || "custom-skill");
        const desc = String(params.description || "Auto-generated skill");
        const instructions = String(params.instructions || "Execute the task as described.");
        try {
          const fsMgr = this.registry.resolveService<{ createFile(path: string, content: string): Promise<{ path: string; size: number }> }>("fileSystemManager");
          const skillDir = `skills/${name}`;
          const skillContent = `# ${name}\n\n> ${desc}\n\n## Instructions\n\n${instructions}\n\n## Config\n\n\`\`\`yaml\nname: ${name}\ndescription: "${desc.replace(/"/g, '\\"')}"\nversion: 1.0.0\ncategory: custom\ninputs:\n  query:\n    type: string\n    required: true\n\`\`\`\n`;
          if (fsMgr) {
            await fsMgr.createFile(`${skillDir}/SKILL.md`, skillContent);
          } else {
            const fsPath = require("path");
            const skillFullPath = fsPath.resolve(__dirname, "..", "..", "..", skillDir);
            require("fs").mkdirSync(skillFullPath, { recursive: true });
            require("fs").writeFileSync(fsPath.join(skillFullPath, "SKILL.md"), skillContent, "utf-8");
          }
          const installed = await this.skillManager.installSkill(skillDir);
          return { success: true, skillId: installed.id, skillName: installed.name, message: `Skill "${name}" has been created, installed, and is ready to use!` };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    );

    this.agentModelExecutor.registerTool(
      "skill_search",
      {
        name: "skill_search",
        description: "Search for available skills matching a task description",
        parameters: {
          task: { type: "string", description: "Description of the task to search skills for" },
        },
      },
      async (params: Record<string, unknown>) => {
        const task = String(params.task || "");
        const match = await autoSkill.findSkillForTask(task);
        if (!match) return { found: false, reason: "No matching skill found" };
        return {
          found: true,
          skillName: match.skillName,
          skillPath: match.skillPath,
          relevance: match.relevance,
          reason: match.reason,
        };
      }
    );
  }

  private registerTaskPlannerTool(): void {
    const planner = this.taskPlanner;

    this.agentModelExecutor.registerTool(
      "task_decompose",
      {
        name: "task_decompose",
        description: "Decompose a complex task into executable subtasks with dependency ordering",
        parameters: {
          task: { type: "string", description: "The task description to decompose" },
        },
      },
      async (params: Record<string, unknown>) => {
        const task = String(params.task || "");
        const plan = planner.decompose(task);
        return {
          planId: plan.id,
          task: plan.task,
          subtaskCount: plan.subtasks.length,
          subtasks: plan.subtasks.map((s) => ({
            id: s.id,
            description: s.description,
            tool: s.tool,
            dependencies: s.dependencies,
            status: s.status,
          })),
        };
      }
    );

    this.agentModelExecutor.registerTool(
      "task_status",
      {
        name: "task_status",
        description: "Get the status of a task plan",
        parameters: {
          planId: { type: "string", description: "The plan ID to check" },
        },
      },
      async (params: Record<string, unknown>) => {
        const planId = String(params.planId || "");
        const plan = planner.getPlan(planId);
        if (!plan) return { error: "Plan not found" };
        return {
          planId: plan.id,
          status: plan.status,
          progress: plan.progress,
          subtasks: plan.subtasks.map((s) => ({
            id: s.id,
            description: s.description,
            status: s.status,
            result: s.result,
            error: s.error,
            retryCount: s.retryCount,
          })),
        };
      }
    );
  }

  private registerBootstrapTool(): void {
    const bm = this.bootstrapManager;
    const mh = this.memoryHub;
    this.agentModelExecutor.registerTool(
      "complete_bootstrap",
      {
        name: "complete_bootstrap",
        description: "Complete the initial bootstrap ritual. Call after finishing the first-run setup in BOOTSTRAP.md. Deletes BOOTSTRAP.md permanently.",
        parameters: {
          summary: { type: "string", description: "Brief summary of what was accomplished" },
        },
      },
      async (params: Record<string, unknown>) => {
        if (!bm) return { error: "Bootstrap manager not initialized" };
        const ctx = bm.getContext();
        if (!ctx.bootstrapPending) return { completed: false, message: "Bootstrap not pending." };
        bm.completeBootstrap();
        const summary = String(params.summary || "Bootstrap completed");
        if (mh) {
          try {
            await mh.getLongTerm().store({
              content: `Bootstrap: ${summary}`, type: "system",
              metadata: { source: "bootstrap", sessionId: "bootstrap", userId: "default", tags: ["bootstrap"], importance: 0.9, associations: [], entities: [] },
              ttl: 365 * 24 * 3600 * 1000, embedding: null, id: "", createdAt: new Date(), accessedAt: new Date(),
            });
          } catch { /* silent */ }
        }
        return { completed: true, message: "Bootstrap ritual completed. Workspace initialized.", summary };
      }
    );
  }

  private registerPermissionTools(): void {
    const permMgr = this.permissionManager;

    this.agentModelExecutor.registerTool(
      "permission_status",
      {
        name: "permission_status",
        description: "Check the status of pending permission requests",
        parameters: {},
      },
      async () => {
        const pending = permMgr.getPendingRequests();
        return {
          pendingCount: pending.length,
          requests: pending.map((r) => ({
            id: r.id,
            operation: r.operation,
            target: r.target,
            description: r.description,
            status: r.status,
            requestedAt: r.requestedAt,
          })),
        };
      }
    );

    this.agentModelExecutor.registerTool(
      "error_stats",
      {
        name: "error_stats",
        description: "Get error statistics and recovery status",
        parameters: {},
      },
      async () => {
        return this.errorRecoveryManager.getErrorStats();
      }
    );
  }

  private registerBrowserTools(): void {
    const browser = this.browserController;

    this.agentModelExecutor.registerTool(
      "browser_navigate",
      {
        name: "browser_navigate",
        description: "Navigate to a URL and retrieve page content, links, and forms",
        parameters: {
          url: { type: "string", description: "The URL to navigate to" },
        },
      },
      async (params: Record<string, unknown>) => {
        const url = String(params.url || "");
        return await browser.navigate(url);
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_get_text",
      {
        name: "browser_get_text",
        description: "Get text content from elements matching a CSS selector on the current page",
        parameters: {
          selector: { type: "string", description: "CSS selector (e.g. 'h1', '.class-name', '#id')" },
        },
      },
      async (params: Record<string, unknown>) => {
        const selector = String(params.selector || "body");
        if (!browser.getCurrentPage()) {
          return { error: "No page loaded. Use browser_navigate first." };
        }
        const text = await browser.getText(selector);
        return { selector, text, length: text.length };
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_find_elements",
      {
        name: "browser_find_elements",
        description: "Find elements on the current page by CSS selector",
        parameters: {
          selector: { type: "string", description: "CSS selector to find elements" },
        },
      },
      async (params: Record<string, unknown>) => {
        const selector = String(params.selector || "");
        if (!browser.getCurrentPage()) {
          return { error: "No page loaded. Use browser_navigate first." };
        }
        const elements = await browser.findElements(selector);
        return { selector, count: elements.length, elements };
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_submit_form",
      {
        name: "browser_submit_form",
        description: "Submit a form on the current page with field values",
        parameters: {
          action: { type: "string", description: "Form action URL" },
          method: { type: "string", description: "HTTP method (get or post)" },
          fields: { type: "string", description: "JSON string of field name-value pairs" },
        },
      },
      async (params: Record<string, unknown>) => {
        const action = String(params.action || "");
        const method = String(params.method || "get");
        let fields: Record<string, string> = {};
        try {
          fields = JSON.parse(String(params.fields || "{}"));
        } catch {
          return { error: "Invalid fields JSON" };
        }
        return await browser.submitForm({ action, method, fields });
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_search",
      {
        name: "browser_search",
        description: "Search the web for a query across multiple search engines",
        parameters: {
          query: { type: "string", description: "Search query" },
          sites: { type: "string", description: "Comma-separated search engines (google,bing,duckduckgo)" },
        },
      },
      async (params: Record<string, unknown>) => {
        const query = String(params.query || "");
        const sitesStr = String(params.sites || "duckduckgo");
        const sites = sitesStr.split(",").map((s) => s.trim()).filter(Boolean);
        return await browser.searchAndScrape(query, sites);
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_fetch_json",
      {
        name: "browser_fetch_json",
        description: "Fetch JSON data from an API endpoint",
        parameters: {
          url: { type: "string", description: "The API URL to fetch JSON from" },
        },
      },
      async (params: Record<string, unknown>) => {
        const url = String(params.url || "");
        return await browser.fetchJSON(url);
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_tabs",
      {
        name: "browser_tabs",
        description: "Manage browser tabs (list, new, switch, close)",
        parameters: {
          action: { type: "string", description: "Action: list, new, switch, or close" },
          tabId: { type: "string", description: "Tab ID for switch/close actions" },
        },
      },
      async (params: Record<string, unknown>) => {
        const action = String(params.action || "list");
        const tabId = String(params.tabId || "");

        if (action === "list") {
          return { tabs: browser.listTabs(), activeTab: (browser.getCurrentPage()?.url || "") };
        }
        if (action === "new") {
          browser.newTab(tabId || `tab-${Date.now()}`);
          return { success: true, action: "new", tabId };
        }
        if (action === "switch") {
          const ok = browser.switchTab(tabId);
          return { success: ok, action: "switch", tabId };
        }
        if (action === "close") {
          const ok = browser.closeTab(tabId);
          return { success: ok, action: "close", tabId };
        }
        return { error: `Unknown action: ${action}` };
      }
    );

    const pwBrowser = this.playwrightBrowser;

    this.agentModelExecutor.registerTool(
      "browser_launch",
      {
        name: "browser_launch",
        description: "Launch a real Chromium browser via Playwright for advanced web automation",
        parameters: {
          headless: { type: "string", description: "Run headless (true/false, default true)" },
        },
      },
      async (params: Record<string, unknown>) => {
        const headless = String(params.headless || "true") !== "false";
        await pwBrowser.shutdown();
        const newBrowser = new PlaywrightBrowser(this.registry, this.eventBus, {
          headless,
          cookieStorageDir: path.resolve(__dirname, "..", "..", ".."),
        });
        await newBrowser.launch();
        this.playwrightBrowser = newBrowser;
        this.registry.registerService("playwrightBrowser", this.playwrightBrowser);
        return { success: true, headless, message: "Playwright browser launched" };
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_screenshot",
      {
        name: "browser_screenshot",
        description: "Take a screenshot of the current page or specific element",
        parameters: {
          selector: { type: "string", description: "CSS selector for element screenshot (optional)" },
          fullPage: { type: "string", description: "Capture full page (true/false, default true)" },
          filename: { type: "string", description: "File path to save screenshot (optional, saves as .png)" },
        },
      },
      async (params: Record<string, unknown>) => {
        const selector = String(params.selector || "");
        const fullPage = String(params.fullPage || "true") !== "false";
        const filename = String(params.filename || "");
        const buf = await pwBrowser.screenshot({
          fullPage,
          selector: selector || undefined,
          type: "png",
        });
        if (filename) {
          const base64 = buf.toString("base64");
          await this.fileSystemManager.writeFile(filename, base64);
          return { success: true, file: filename, size: buf.length, format: "base64-encoded", base64Preview: `data:image/png;base64,${base64.substring(0, 200)}...` };
        }
        const base64 = buf.toString("base64");
        return {
          success: true,
          size: buf.length,
          mimeType: "image/png",
          base64: base64.substring(0, 500) + `... [truncated, ${buf.length} bytes total]`,
        };
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_login",
      {
        name: "browser_login",
        description: "Automatically log into a website with credentials",
        parameters: {
          url: { type: "string", description: "Login page URL" },
          usernameSelector: { type: "string", description: "CSS selector for username input" },
          passwordSelector: { type: "string", description: "CSS selector for password input" },
          username: { type: "string", description: "Username/email to login with" },
          password: { type: "string", description: "Password to login with" },
          submitSelector: { type: "string", description: "CSS selector for submit button" },
          successUrl: { type: "string", description: "URL fragment that indicates successful login" },
        },
      },
      async (params: Record<string, unknown>) => {
        const url = String(params.url || "");
        const usernameSelector = String(params.usernameSelector || "");
        const passwordSelector = String(params.passwordSelector || "");
        const username = String(params.username || "");
        const password = String(params.password || "");
        const submitSelector = String(params.submitSelector || "");
        const successUrl = String(params.successUrl || "");
        const result = await pwBrowser.login(
          url, usernameSelector, passwordSelector, username, password, submitSelector,
          successUrl ? { urlContains: successUrl } : undefined
        );
        if (!result.success) {
          return { success: false, error: result.error || "Login failed", currentUrl: result.currentUrl };
        }
        return { success: true, currentUrl: result.currentUrl, title: result.pageTitle, cookieCount: result.cookies.length };
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_js_eval",
      {
        name: "browser_js_eval",
        description: "Execute JavaScript on the current page and return the result",
        parameters: {
          expression: { type: "string", description: "JavaScript expression to evaluate" },
        },
      },
      async (params: Record<string, unknown>) => {
        const expression = String(params.expression || "");
        const result = await pwBrowser.evaluateJS(expression);
        return { success: true, result };
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_click",
      {
        name: "browser_click",
        description: "Click an element on the page",
        parameters: {
          selector: { type: "string", description: "CSS selector of element to click" },
        },
      },
      async (params: Record<string, unknown>) => {
        const selector = String(params.selector || "");
        await pwBrowser.click(selector);
        return { success: true, selector };
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_fill_form",
      {
        name: "browser_fill_form",
        description: "Fill form fields on the current page with realistic typing",
        parameters: {
          fields: { type: "string", description: "JSON array of {selector, value, delay, submitAfter} objects" },
        },
      },
      async (params: Record<string, unknown>) => {
        let fields: Array<{ selector: string; value: string; delay?: number; submitAfter?: boolean }> = [];
        try {
          fields = JSON.parse(String(params.fields || "[]"));
        } catch {
          return { error: "Invalid fields JSON array" };
        }
        await pwBrowser.fillForm(fields);
        return { success: true, fieldCount: fields.length };
      }
    );

    this.agentModelExecutor.registerTool(
      "browser_get_html",
      {
        name: "browser_get_html",
        description: "Get the full HTML source of the current page",
        parameters: {},
      },
      async () => {
        const html = await pwBrowser.getHTML();
        return { success: true, length: html.length, html: html.substring(0, 10000) + (html.length > 10000 ? "... [truncated]" : "") };
      }
    );

    // ============ Web Search & Fetch Tools ============
    // Standalone web tools not requiring browser controller

    this.agentModelExecutor.registerTool(
      "web_fetch",
      {
        name: "web_fetch",
        description: "Fetch content from a web URL and extract readable text. Use for getting page content, RSS feeds, or API data.",
        parameters: {
          url: { type: "string", description: "The URL to fetch content from" },
          format: { type: "string", description: "Response format: 'text' (plain), 'html' (raw), or 'json' (parsed JSON). Default: 'text'" },
        },
      },
      async (params: Record<string, unknown>) => {
        const url = String(params.url || "");
        const format = String(params.format || "text");
        if (!url || !url.startsWith("http")) {
          return { error: "Valid HTTP/HTTPS URL is required" };
        }
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          const response = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; EvoClaw/1.0)",
              "Accept": format === "json" ? "application/json" : "text/html,text/plain,*/*",
            },
            signal: controller.signal,
            redirect: "follow",
          });
          clearTimeout(timeout);
          if (!response.ok) {
            return { error: `HTTP ${response.status}`, url };
          }

          if (format === "json") {
            const data = await response.json();
            return { url, status: response.status, data };
          }

          const text = await response.text();
          if (format === "html") {
            return { url, status: response.status, html: text.slice(0, 8000), length: text.length };
          }

          // Extract readable text from HTML with full entity decoding
          const plainText = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
            .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&ensp;/g, " ")
            .replace(/&emsp;/g, "  ")
            .replace(/&nbsp;/g, " ")
            .replace(/&thinsp;/g, " ")
            .replace(/&mdash;/g, "—")
            .replace(/&ndash;/g, "–")
            .replace(/&lsquo;/g, "'")
            .replace(/&rsquo;/g, "'")
            .replace(/&ldquo;/g, '"')
            .replace(/&rdquo;/g, '"')
            .replace(/\s+/g, " ")
            .trim();

          const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
          return {
            url,
            title: titleMatch ? titleMatch[1].trim() : url,
            status: response.status,
            text: plainText.slice(0, 5000),
            length: plainText.length,
          };
        } catch (err: any) {
          return { error: err.name === "AbortError" ? "Request timed out" : (err.message || String(err)), url };
        }
      }
    );

    // ── fetch_node_page: internal tool for news pre-processing (fetches page content) ──
    this.agentModelExecutor.registerTool(
      "fetch_node_page",
      {
        name: "fetch_node_page",
        description: "Fetch a web page URL and extract its text content. Used internally for news/article content extraction.",
        parameters: {
          url: { type: "string", description: "The URL to fetch content from" },
          maxLength: { type: "number", description: "Maximum characters to return (default 5000)" },
        },
      },
      async (params: Record<string, unknown>) => {
        const url = String(params.url || "");
        const maxLength = Number(params.maxLength || 5000);
        if (!url || !url.startsWith("http")) {
          return { error: "Valid HTTP/HTTPS URL is required", url };
        }
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          const response = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; EvoClaw/1.0)",
              "Accept": "text/html,text/plain,*/*",
            },
            signal: controller.signal,
            redirect: "follow",
          });
          clearTimeout(timeout);
          if (!response.ok) {
            return { error: `HTTP ${response.status}`, url };
          }
          const text = await response.text();
          // Full entity decode + strip tags
          const content = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
            .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&ensp;/g, " ")
            .replace(/&emsp;/g, "  ")
            .replace(/&nbsp;/g, " ")
            .replace(/&thinsp;/g, " ")
            .replace(/&mdash;/g, "—")
            .replace(/&ndash;/g, "–")
            .replace(/&lsquo;/g, "'")
            .replace(/&rsquo;/g, "'")
            .replace(/&ldquo;/g, '"')
            .replace(/&rdquo;/g, '"')
            .replace(/\s+/g, " ")
            .trim();
          const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
          return {
            url,
            title: titleMatch ? titleMatch[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"') : url,
            content: content.slice(0, maxLength),
            length: content.length,
          };
        } catch (err: any) {
          return { error: err.name === "AbortError" ? "Request timed out" : (err.message || String(err)), url };
        }
      }
    );

    this.agentModelExecutor.registerTool(
      "web_search",
      {
        name: "web_search",
        description: "Search the web. Tries Tavily/Baidu skills first (higher quality), then falls back to Bing (cn.bing.com for Chinese queries), Google, DuckDuckGo. Returns titles, URLs, and snippets. Supports freshness parameter for time-filtered results.",
        parameters: {
          query: { type: "string", description: "Search query string" },
          limit: { type: "string", description: "Max results (default 10)" },
          freshness: { type: "string", description: "Time filter: pd (24h), pw (7d), pm (31d), py (365d), or YYYY-MM-DDtoYYYY-MM-DD" },
        },
      },
      async (params: Record<string, unknown>) => {
        const query = String(params.query || "");
        const limit = parseInt(String(params.limit || "10"), 10) || 10;
        const freshness = String(params.freshness || "");
        if (!query) return { error: "Search query is required" };

        const optimizeChineseQuery = (q: string): string[] => {
          const queries = [q];
          const techTerms = ["大模型", "LLM", "AI", "人工智能", "深度学习", "机器学习", "神经网络", "GPT", "Claude", "Gemini", "开源模型"];
          const hasTechTerm = techTerms.some(t => q.includes(t));
          if (hasTechTerm) {
            const cleaned = q.replace(/国产/g, "").replace(/中国/g, "").replace(/国内/g, "").trim();
            if (cleaned.length > 2) queries.push(cleaned);
            const withEnglish = q.replace(/大模型/g, "LLM大模型").replace(/性价比/g, "价格 性能 对比").replace(/横评/g, "对比 评测").replace(/评测/g, "评测 对比");
            queries.push(withEnglish);
          }
          return [...new Set(queries)];
        };

        const isChineseQuery = /[\u4e00-\u9fff]/.test(query);
        const searchSkills = isChineseQuery
          ? ["baidu-search", "tavily-search"]
          : ["tavily-search", "baidu-search"];
        for (const skillName of searchSkills) {
          try {
            const skills = await this.skillManager.listSkills();
            const skill = skills.find((s: { name: string }) => s.name === skillName);
            if (!skill) continue;
            const skillParams: Record<string, unknown> = { query, prompt: query, limit };
            if (freshness) skillParams.freshness = freshness;
            const result = await this.skillManager.executeSkill(skill.id || skillName, skillParams);
            if (result && result.success && result.output) {
              const outputStr = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
              if (outputStr.length > 50) {
                console.log(`[web_search] Used ${skillName} skill successfully`);
                return { query, source: skillName, count: 1, results: [{ title: `${skillName} result`, url: "", snippet: outputStr.slice(0, 8000) }], rawOutput: result.output };
              }
            }
          } catch (err) {
            console.debug(`[web_search] ${skillName} skill failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

        const allQueries = isChineseQuery ? optimizeChineseQuery(query) : [query];
        let allResults: Array<{ title: string; url: string; snippet: string }> = [];
        let usedSource = "";

        const trySearchTavilyAPI = async (searchQuery: string, maxResults: number): Promise<{ results: Array<{ title: string; url: string; snippet: string }> }> => {
          const tavilyKey = process.env.TAVILY_API_KEY;
          if (!tavilyKey || tavilyKey === "your_api_key") return { results: [] };
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000);
            const resp = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                api_key: tavilyKey,
                query: searchQuery,
                max_results: maxResults,
                include_answer: false,
                search_depth: "basic",
              }),
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!resp.ok) return { results: [] };
            const data = await resp.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
            if (!data.results || !Array.isArray(data.results)) return { results: [] };
            return {
              results: data.results
                .filter((r) => r.url)
                .map((r) => ({ title: r.title || "", url: r.url!, snippet: (r.content || "").slice(0, 300) })),
            };
          } catch {
            return { results: [] };
          }
        };

        for (const q of allQueries) {
          if (allResults.length >= limit) break;

          const addResults = (newResults: Array<{ title: string; url: string; snippet: string }>, source: string) => {
            const seen = new Set(allResults.map(r => r.url));
            for (const r of newResults) {
              if (!seen.has(r.url) && allResults.length < limit) {
                allResults.push(r);
                seen.add(r.url);
              }
            }
            if (!usedSource) usedSource = source;
          };

          if (isChineseQuery) {
            const baiduResult = await trySearchBaiduHTML(q, limit, userAgent, freshness);
            if (baiduResult.results && baiduResult.results.length > 0) {
              addResults(baiduResult.results, "Baidu");
              continue;
            }
          }

          const tavilyResult = await trySearchTavilyAPI(q, limit);
          if (tavilyResult.results && tavilyResult.results.length > 0) {
            addResults(tavilyResult.results, "Tavily");
            continue;
          }

          const bingResult = await trySearchBing(q, limit, userAgent, isChineseQuery, freshness);
          if (bingResult.results && bingResult.results.length > 0) {
            addResults(bingResult.results, bingResult.source || "Bing");
            continue;
          }

          if (!isChineseQuery) {
            const baiduResult = await trySearchBaiduHTML(q, limit, userAgent, freshness);
            if (baiduResult.results && baiduResult.results.length > 0) {
              addResults(baiduResult.results, "Baidu");
              continue;
            }
          }

          const googleResult = await trySearchGoogle(q, limit, userAgent, freshness);
          if (googleResult.results && googleResult.results.length > 0) {
            addResults(googleResult.results, "Google");
            continue;
          }

          const ddgResult = await trySearchDDG(q, limit, userAgent);
          if (ddgResult.results && ddgResult.results.length > 0) {
            addResults(ddgResult.results, "DuckDuckGo");
            continue;
          }
        }

        if (allResults.length > 0) {
          console.log(`[WebSearch] Success: ${allResults.length} results from ${usedSource} for query variants: ${allQueries.join(", ")}`);
          return { query, source: usedSource, count: allResults.length, results: allResults.slice(0, limit) };
        }

        console.warn(`[WebSearch] All search providers failed for query variants: ${allQueries.join(", ")}`);
        const errorMsg = "All search providers failed for all query variants";
        return { error: errorMsg, query, source: "none", results: [] };
      }
    );

    // ── HTML entity decoder ──
    function decodeHtmlEntities(text: string): string {
      return text
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&ensp;/g, " ")
        .replace(/&emsp;/g, "  ")
        .replace(/&nbsp;/g, " ")
        .replace(/&thinsp;/g, " ")
        .replace(/&mdash;/g, "—")
        .replace(/&ndash;/g, "–")
        .replace(/&lsquo;/g, "'")
        .replace(/&rsquo;/g, "'")
        .replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"');
    }

    // ── Clean snippet/title text ──
    function cleanText(text: string): string {
      return decodeHtmlEntities(text.replace(/<\/?[^>]+>/g, "").trim().slice(0, 500));
    }

    async function trySearchBing(q: string, limit: number, ua: string, isChinese: boolean = false, freshness?: string): Promise<{ results?: Array<{ title: string; url: string; snippet: string }>; error?: string; source?: string }> {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const bingHost = isChinese ? "https://cn.bing.com" : "https://www.bing.com";
        let url = `${bingHost}/search?q=${encodeURIComponent(q)}&count=${limit}`;
        if (isChinese) {
          url += "&setlang=zh-CN&cc=cn&qs=n&form=QBRE";
        }
        if (freshness) {
          const bingFreshness = freshness === "pd" ? "day" : freshness === "pw" ? "week" : freshness === "pm" ? "month" : "";
          if (bingFreshness) url += `&filters=ex1:"ez${bingFreshness}"`;
        }
        const response = await fetch(url, {
          headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml", "Accept-Language": isChinese ? "zh-CN,zh;q=0.9,en;q=0.8" : "en-US,en;q=0.9" },
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timeout);

        if (!response.ok) {
          return { error: `Bing HTTP ${response.status}` };
        }

        const html = await response.text();
        const results: Array<{ title: string; url: string; snippet: string }> = [];

        const algoRegex = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
        let match;
        while ((match = algoRegex.exec(html)) !== null && results.length < limit) {
          const block = match[1];
          const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
          const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) 
            || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
          if (titleMatch) {
            results.push({
              title: cleanText(titleMatch[2]),
              url: titleMatch[1],
              snippet: snippetMatch ? cleanText(snippetMatch[1]) : "",
            });
          }
        }

        if (results.length > 0) return { results, source: isChinese ? "Bing CN" : "Bing" };

        const captionRegex = /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
        while ((match = captionRegex.exec(html)) !== null && results.length < limit) {
          const block = match[1];
          const titleMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
          const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
          if (titleMatch) {
            results.push({
              title: cleanText(titleMatch[2]),
              url: titleMatch[1],
              snippet: snippetMatch ? cleanText(snippetMatch[1]) : "",
            });
          }
        }

        if (results.length > 0) return { results, source: isChinese ? "Bing CN" : "Bing" };
        return { error: "No results found in Bing" };
      } catch (err: any) {
        return { error: err.name === "AbortError" ? "Bing search timed out" : `Bing error: ${err.message || String(err)}` };
      }
    }

    async function trySearchGoogle(q: string, limit: number, ua: string, freshness?: string): Promise<{ results?: Array<{ title: string; url: string; snippet: string }>; error?: string }> {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let url = `https://www.google.com/search?q=${encodeURIComponent(q)}&num=${limit}&hl=zh-CN`;
        if (freshness) {
          const tbs = freshness === "pd" ? "qdr:d" : freshness === "pw" ? "qdr:w" : freshness === "pm" ? "qdr:m" : freshness === "py" ? "qdr:y" : "";
          if (tbs) url += `&tbs=${tbs}`;
        }
        const response = await fetch(url, {
          headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timeout);

        if (!response.ok) {
          return { error: `Google HTTP ${response.status}` };
        }

        const html = await response.text();
        const results: Array<{ title: string; url: string; snippet: string }> = [];

        const resultRegex = /<div[^>]*class="[^"]*g[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
        let match;
        while ((match = resultRegex.exec(html)) !== null && results.length < limit) {
          const block = match[1];
          const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
          const linkMatch = block.match(/<a[^>]*href="\/url\?q=(https?:\/\/[^&"]+)[^"]*"[^>]*>/i) 
            || block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i);
          const snippetMatch = block.match(/<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
            || block.match(/<span[^>]*class="[^"]*aCOpRe[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
          if (titleMatch && linkMatch && linkMatch[1] && !linkMatch[1].includes("google.com")) {
            results.push({
              title: cleanText(titleMatch[1]),
              url: linkMatch[1],
              snippet: snippetMatch ? cleanText(snippetMatch[1]) : "",
            });
          }
        }

        if (results.length > 0) return { results };
        return { error: "No results found in Google" };
      } catch (err: any) {
        return { error: err.name === "AbortError" ? "Google search timed out" : `Google error: ${err.message || String(err)}` };
      }
    }

    async function trySearchBaiduHTML(q: string, limit: number, ua: string, freshness?: string): Promise<{ results?: Array<{ title: string; url: string; snippet: string }>; error?: string }> {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let baiduUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=${limit}`;
        if (freshness) {
          const baiduFreshness: Record<string, string> = { pd: "1", pw: "2", pm: "3", py: "4" };
          const gpc = baiduFreshness[freshness];
          if (gpc) baiduUrl += `&gpc=stf=${gpc}`;
        }
        const response = await fetch(baiduUrl, {
          headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9", "Accept-Encoding": "gzip, deflate" },
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timeout);

        if (!response.ok) {
          return { error: `Baidu HTML HTTP ${response.status}` };
        }

        const html = await response.text();
        if (html.length < 5000) {
          return { error: "Baidu returned minimal content (possible anti-bot block)" };
        }

        const results: Array<{ title: string; url: string; snippet: string }> = [];
        const seenUrls = new Set<string>();

        const titleRegex = /<h3[^>]*class="[^"]*(?:t|c-title)[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = titleRegex.exec(html)) !== null && results.length < limit) {
          const url = match[1];
          const title = cleanText(match[2]);
          if (title && url && !url.includes("baidu.com/baidu.php") && !seenUrls.has(url)) {
            seenUrls.add(url);
            results.push({ title, url, snippet: "" });
          }
        }

        if (results.length === 0) {
          const altTitleRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
          while ((match = altTitleRegex.exec(html)) !== null && results.length < limit) {
            const url = match[1];
            const title = cleanText(match[2]);
            if (title && url && !url.includes("baidu.com/baidu.php") && !seenUrls.has(url)) {
              seenUrls.add(url);
              results.push({ title, url, snippet: "" });
            }
          }
        }

        const snippetRegex = /<div[^>]*class="[^"]*(?:c-abstract|content-right_[^"]*|c-span-last)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
        let snippetIdx = 0;
        while ((match = snippetRegex.exec(html)) !== null && snippetIdx < results.length) {
          if (results[snippetIdx].snippet === "") {
            results[snippetIdx].snippet = cleanText(match[1]);
          }
          snippetIdx++;
        }

        if (results.length > 0) return { results };
        return { error: "No results found in Baidu HTML" };
      } catch (err: any) {
        return { error: err.name === "AbortError" ? "Baidu HTML search timed out" : `Baidu HTML error: ${err.message || String(err)}` };
      }
    }

    async function trySearchDDG(q: string, limit: number, ua: string): Promise<{ results?: Array<{ title: string; url: string; snippet: string }>; error?: string }> {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        // Use DuckDuckGo Lite for simpler HTML structure
        const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, {
          headers: { "User-Agent": ua, "Accept": "text/html", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timeout);

        if (!response.ok) {
          return { error: `DuckDuckGo HTTP ${response.status}` };
        }

        const html = await response.text();
        const results: Array<{ title: string; url: string; snippet: string }> = [];

        // DuckDuckGo Lite results are in <tr class="result-snippet"> blocks
        // containing <a rel="nofollow" href="URL">Title</a> and <td class="result-snippet">snippet</td>
        const rowRegex = /<tr[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
        let match;
        while ((match = rowRegex.exec(html)) !== null && results.length < limit) {
          const row = match[1];
          const linkMatch = row.match(/<a[^>]*rel="nofollow"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
            || row.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
          const snippetMatch = row.match(/<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
          if (linkMatch && linkMatch[1] && !linkMatch[1].includes("duckduckgo.com")) {
            results.push({
              title: cleanText(linkMatch[2]),
              url: linkMatch[1],
              snippet: snippetMatch ? cleanText(snippetMatch[1]) : "",
            });
          }
        }

        if (results.length > 0) return { results };
        return { error: "No results found in DuckDuckGo" };
      } catch (err: any) {
        return { error: err.name === "AbortError" ? "DuckDuckGo search timed out" : `DuckDuckGo error: ${err.message || String(err)}` };
      }
    }

    this.agentModelExecutor.registerTool(
      "email_add_account",
      {
        name: "email_add_account",
        description: "Add an email account for sending/receiving emails",
        parameters: {
          email: { type: "string", description: "Email address" },
          password: { type: "string", description: "Email password or app-specific password" },
          provider: { type: "string", description: "Email provider: gmail, qq, 163, outlook, or custom" },
          displayName: { type: "string", description: "Display name for outgoing emails" },
        },
      },
      async (params: Record<string, unknown>) => {
        const email = String(params.email || "");
        const password = String(params.password || "");
        const provider = String(params.provider || "custom") as EmailAccount["provider"];
        const displayName = String(params.displayName || "");
        if (!email || !password) {
          return { error: "email and password are required" };
        }
        const permMgr = this.permissionManager;
        const perm = permMgr.requestPermission("email_add_account", email, { provider }, "tool");
        if (perm.status === "denied") {
          return { success: false, error: "Permission denied to add email account" };
        }
        if (perm.status === "pending") {
          return {
            success: false,
            requiresPermission: true,
            requestId: perm.id,
            operation: "email_add_account",
            description: "添加邮箱账户",
            target: email,
            error: "Awaiting approval to add email account",
          };
        }
        const account = this.emailClient.addAccount(email, password, provider, displayName);
        return { success: true, accountId: account.id, email, provider };
      }
    );

    this.agentModelExecutor.registerTool(
      "email_send",
      {
        name: "email_send",
        description: "Send an email via configured account",
        parameters: {
          accountId: { type: "string", description: "Email account ID" },
          to: { type: "string", description: "Recipient email(s), comma-separated" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Plain text email body" },
          html: { type: "string", description: "HTML email body (optional)" },
        },
      },
      async (params: Record<string, unknown>) => {
        const accountId = String(params.accountId || "");
        const to = String(params.to || "");
        const subject = String(params.subject || "");
        const body = String(params.body || "");
        const html = String(params.html || "");
        try {
          const result = await this.emailClient.sendEmail({
            accountId,
            to: to.split(",").map((s) => s.trim()).filter(Boolean),
            subject,
            body,
            html: html || undefined,
          });
          return { success: true, messageId: result.messageId, accepted: result.accepted };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    );

    this.agentModelExecutor.registerTool(
      "email_analyze",
      {
        name: "email_analyze",
        description: "Analyze a batch of raw emails and produce analysis report",
        parameters: {
          rawEmails: { type: "string", description: "JSON array of raw email content strings" },
        },
      },
      async (params: Record<string, unknown>) => {
        let rawEmails: string[] = [];
        try {
          rawEmails = JSON.parse(String(params.rawEmails || "[]"));
        } catch {
          return { error: "rawEmails must be a valid JSON array of email strings" };
        }
        const parsed: ParsedEmail[] = [];
        for (const raw of rawEmails) {
          try {
            parsed.push(await this.emailClient.parseRawEmail(raw));
          } catch {}
        }
        const analysis = this.emailClient.analyzeEmails(parsed);
        return {
          success: true,
          totalEmails: analysis.totalEmails,
          categories: analysis.categories,
          topSenders: (analysis.senders || []).slice(0, 5),
          topKeywords: (analysis.keywords || []).slice(0, 10),
          actionItems: analysis.actionItems,
        };
      }
    );

    this.agentModelExecutor.registerTool(
      "email_summarize",
      {
        name: "email_summarize",
        description: "Parse a single raw email and produce a summary",
        parameters: {
          rawEmail: { type: "string", description: "Raw email content" },
        },
      },
      async (params: Record<string, unknown>) => {
        const rawEmail = String(params.rawEmail || "");
        const parsed = await this.emailClient.parseRawEmail(rawEmail);
        const summary = this.emailClient.summarizeEmail(parsed);
        return {
          success: true,
          from: summary.from,
          subject: summary.subject,
          date: summary.date,
          snippet: summary.snippet,
          categories: summary.categories,
          priority: summary.priority,
          hasAttachments: summary.hasAttachments,
        };
      }
    );

    this.agentModelExecutor.registerTool(
      "email_list_accounts",
      {
        name: "email_list_accounts",
        description: "List configured email accounts",
        parameters: {},
      },
      async () => {
        const accounts = this.emailClient.listAccounts();
        return { success: true, accounts };
      }
    );

    this.agentModelExecutor.registerTool(
      "email_list_inbox",
      {
        name: "email_list_inbox",
        description: "List emails from inbox with optional filters",
        parameters: {
          accountId: { type: "string", description: "Email account ID (use first available if not provided)" },
          limit: { type: "number", description: "Maximum number of emails to fetch (default: 50)" },
          unreadOnly: { type: "boolean", description: "Only show unread emails (default: false)" },
        },
      },
      async (params: Record<string, unknown>) => {
        const accountId = String(params.accountId || "");
        const limit = Number(params.limit || 50);
        const unreadOnly = Boolean(params.unreadOnly || false);

        const accounts = this.emailClient.listAccounts();
        if (accounts.length === 0) {
          return { success: false, error: "No email accounts configured" };
        }

        // If accountId specified, try that first; otherwise try all accounts until one succeeds
        const accountIdsToTry = accountId
          ? [accountId]
          : accounts.map(a => a.id);

        let lastError = "";
        for (const targetId of accountIdsToTry) {
          try {
            const emails = await this.emailClient.listEmails({
              accountId: targetId,
              limit,
              unreadOnly,
            });
            return { success: true, emails, account: accounts.find(a => a.id === targetId) };
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            console.error(`[Server] email_list_inbox failed for account ${targetId}: ${lastError}`);
            // Try next account
          }
        }

        return { success: false, error: `All accounts failed. Last error: ${lastError}` };
      }
    );

    this.agentModelExecutor.registerTool(
      "email_get_inbox_summary",
      {
        name: "email_get_inbox_summary",
        description: "Get inbox summary and statistics",
        parameters: {
          accountId: { type: "string", description: "Email account ID (use first available if not provided)" },
        },
      },
      async (params: Record<string, unknown>) => {
        const accountId = String(params.accountId || "");

        const accounts = this.emailClient.listAccounts();
        if (accounts.length === 0) {
          return { success: false, error: "No email accounts configured" };
        }

        // If accountId specified, try that first; otherwise try all accounts until one succeeds
        const accountIdsToTry = accountId
          ? [accountId]
          : accounts.map(a => a.id);

        let lastError = "";
        for (const targetId of accountIdsToTry) {
          try {
            const summary = await this.emailClient.getInboxSummary(targetId);
            return { success: true, summary, account: accounts.find(a => a.id === targetId) };
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            console.error(`[Server] email_get_inbox_summary failed for account ${targetId}: ${lastError}`);
            // Try next account
          }
        }

        return { success: false, error: `All accounts failed. Last error: ${lastError}` };
      }
    );
  }

  private registerSchedulerTools(): void {
    const sched = this.scheduleManager;

    sched.registerHandler("email_check", async (task: ScheduledTask) => {
      const config = task.handlerConfig as { accountId?: string; rawEmails?: string[] };
      if (config.rawEmails && Array.isArray(config.rawEmails)) {
        const parsed: ParsedEmail[] = [];
        for (const raw of config.rawEmails) {
          try {
            parsed.push(await this.emailClient.parseRawEmail(raw));
          } catch {}
        }
        const analysis = this.emailClient.analyzeEmails(parsed);
        this.eventBus.publish("scheduler.email_checked", { taskId: task.id, analysis }, "scheduler");
      }
    });

    sched.registerHandler("report_generate", async (task: ScheduledTask) => {
      const config = task.handlerConfig as { templateName?: string; reportData?: ReportData; outputPath?: string };
      if (config.reportData) {
        this.reportGenerator.generateReport(config.reportData, {
          templateName: config.templateName || "default-report",
          outputPath: config.outputPath,
        });
      }
    });

    sched.registerHandler("system_cleanup", async (task: ScheduledTask) => {
      this.eventBus.publish("scheduler.cleanup_run", { taskId: task.id }, "scheduler");
    });

    sched.registerHandler("browser_action", async (task: ScheduledTask) => {
      const config = task.handlerConfig as { action?: string; url?: string };
      if (config.action === "screenshot" && config.url) {
        await this.playwrightBrowser.navigate(config.url);
        const buf = await this.playwrightBrowser.screenshot({ fullPage: true, type: "png" });
        this.eventBus.publish("scheduler.browser_screenshot", {
          taskId: task.id, url: config.url, size: buf.length,
        }, "scheduler");
      }
    });

    sched.registerHandler("custom", async (task: ScheduledTask) => {
      this.eventBus.publish("scheduler.custom_task", {
        taskId: task.id, name: task.name, config: task.handlerConfig,
      }, "scheduler");
    });

    this.agentModelExecutor.registerTool(
      "scheduler_create",
      {
        name: "scheduler_create",
        description: "Create a scheduled task with cron expression",
        parameters: {
          name: { type: "string", description: "Task name" },
          cronExpression: { type: "string", description: "Cron expression (e.g. '0 9 * * *')" },
          description: { type: "string", description: "Task description" },
          handlerType: { type: "string", description: "Handler type: email_check, report_generate, browser_action, system_cleanup, custom" },
          handlerConfig: { type: "string", description: "JSON config for handler" },
        },
      },
      async (params: Record<string, unknown>) => {
        const name = String(params.name || "");
        const cronExpression = String(params.cronExpression || "");
        const description = String(params.description || "");
        const handlerType = (String(params.handlerType || "custom")) as ScheduledTask["handlerType"];
        let handlerConfig: Record<string, unknown> = {};
        try {
          handlerConfig = JSON.parse(String(params.handlerConfig || "{}"));
        } catch {
          return { error: "Invalid handlerConfig JSON" };
        }
        if (!name || !cronExpression) {
          return { error: "name and cronExpression are required" };
        }
        try {
          const task = sched.createTask({ name, cronExpression, description, handlerType, handlerConfig });
          return { success: true, taskId: task.id, name: task.name, nextRun: task.nextRun };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    );

    this.agentModelExecutor.registerTool(
      "scheduler_list",
      {
        name: "scheduler_list",
        description: "List all scheduled tasks",
        parameters: {},
      },
      async () => {
        const tasks = sched.listTasks();
        const stats = sched.getStats();
        return {
          success: true,
          tasks: tasks.map((t) => ({
            id: t.id, name: t.name, cronExpression: t.cronExpression,
            enabled: t.enabled, handlerType: t.handlerType, runCount: t.runCount,
            errorCount: t.errorCount, lastRun: t.lastRun, nextRun: t.nextRun,
          })),
          stats,
        };
      }
    );

    this.agentModelExecutor.registerTool(
      "scheduler_update",
      {
        name: "scheduler_update",
        description: "Update or enable/disable a scheduled task",
        parameters: {
          taskId: { type: "string", description: "Task ID to update" },
          enabled: { type: "string", description: "Enable (true) or disable (false)" },
          cronExpression: { type: "string", description: "New cron expression (optional)" },
          handlerConfig: { type: "string", description: "JSON config for handler (optional)" },
        },
      },
      async (params: Record<string, unknown>) => {
        const taskId = String(params.taskId || "");
        const updates: Record<string, unknown> = {};
        if (params.enabled !== undefined) {
          updates.enabled = String(params.enabled) === "true";
        }
        if (params.cronExpression) {
          updates.cronExpression = String(params.cronExpression);
        }
        if (params.handlerConfig) {
          try {
            updates.handlerConfig = JSON.parse(String(params.handlerConfig));
          } catch {
            return { error: "Invalid handlerConfig JSON" };
          }
        }
        try {
          const updated = sched.updateTask(taskId, updates as Parameters<typeof sched.updateTask>[1]);
          return { success: true, task: updated };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    );

    this.agentModelExecutor.registerTool(
      "scheduler_delete",
      {
        name: "scheduler_delete",
        description: "Delete a scheduled task",
        parameters: {
          taskId: { type: "string", description: "Task ID to delete" },
        },
      },
      async (params: Record<string, unknown>) => {
        const taskId = String(params.taskId || "");
        const removed = sched.deleteTask(taskId);
        return { success: removed, taskId };
      }
    );

    this.agentModelExecutor.registerTool(
      "scheduler_execute",
      {
        name: "scheduler_execute",
        description: "Execute a scheduled task immediately",
        parameters: {
          taskId: { type: "string", description: "Task ID to execute" },
        },
      },
      async (params: Record<string, unknown>) => {
        const taskId = String(params.taskId || "");
        const result = await sched.executeTask(taskId);
        return result;
      }
    );

    this.agentModelExecutor.registerTool(
      "scheduler_history",
      {
        name: "scheduler_history",
        description: "Get execution history for tasks",
        parameters: {
          taskId: { type: "string", description: "Task ID (optional, omit for all)" },
          limit: { type: "string", description: "Max results (default 20)" },
        },
      },
      async (params: Record<string, unknown>) => {
        const taskId = String(params.taskId || "");
        const limit = parseInt(String(params.limit || "20"), 10) || 20;
        const history = sched.getRunHistory(taskId || undefined, limit);
        return { success: true, history, count: history.length };
      }
    );
  }

  private registerReportingTools(): void {
    const reportGen = this.reportGenerator;

    this.agentModelExecutor.registerTool(
      "report_generate",
      {
        name: "report_generate",
        description: "Generate an HTML report from data sections",
        parameters: {
          title: { type: "string", description: "Report title" },
          templateName: { type: "string", description: "Template name: default-report, email-digest, weekly-report" },
          sections: { type: "string", description: "JSON array of report sections" },
          summary: { type: "string", description: "JSON object for summary {totalItems, highlights[], recommendations[]}" },
          outputPath: { type: "string", description: "File path to save the report HTML" },
        },
      },
      async (params: Record<string, unknown>) => {
        const title = String(params.title || "Report");
        const templateName = String(params.templateName || "default-report");
        let sections: ReportSection[] = [];
        try {
          sections = JSON.parse(String(params.sections || "[]"));
        } catch {
          return { error: "sections must be a valid JSON array" };
        }
        let summary: ReportData["summary"] | undefined;
        try {
          if (params.summary) {
            summary = JSON.parse(String(params.summary));
          }
        } catch {
          return { error: "summary must be valid JSON" };
        }
        const outputPath = String(params.outputPath || "");
        try {
          const html = reportGen.generateReport(
            { title, generatedAt: new Date().toLocaleString("zh-CN"), sections, summary },
            { templateName, outputPath: outputPath || undefined }
          );
          if (outputPath) {
            return { success: true, outputPath, length: html.length };
          }
          return { success: true, html: html.substring(0, 5000) + (html.length > 5000 ? "... [truncated]" : ""), length: html.length };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    );

    this.agentModelExecutor.registerTool(
      "report_templates",
      {
        name: "report_templates",
        description: "List available report templates",
        parameters: {},
      },
      async () => {
        const names = reportGen.getTemplateNames();
        const templates = names.map((n) => {
          const t = reportGen.getTemplate(n);
          return { name: t?.name, title: t?.title, description: t?.description };
        });
        return { success: true, templates };
      }
    );

    this.agentModelExecutor.registerTool(
      "report_email_digest",
      {
        name: "report_email_digest",
        description: "Generate an email digest report from email data",
        parameters: {
          emails: { type: "string", description: "JSON array of email summaries with from, subject, date, snippet, categories, priority, hasAttachments" },
          dateRange: { type: "string", description: "Date range label for the report" },
          outputPath: { type: "string", description: "File path to save the report HTML" },
        },
      },
      async (params: Record<string, unknown>) => {
        let emails: unknown[] = [];
        try {
          emails = JSON.parse(String(params.emails || "[]"));
        } catch {
          return { error: "emails must be a valid JSON array" };
        }
        const dateRange = String(params.dateRange || "");
        const outputPath = String(params.outputPath || "");

        const categoriesBreakdown: Record<string, number> = {};
        for (const e of emails as Array<{ categories?: string[] }>) {
          for (const cat of e.categories || []) {
            categoriesBreakdown[cat] = (categoriesBreakdown[cat] || 0) + 1;
          }
        }

        const templateData = {
          title: "邮件摘要报告",
          totalEmails: emails.length,
          dateRange: dateRange || undefined,
          categoriesBreakdown: Object.entries(categoriesBreakdown).map(([name, count]) => ({ name, count })),
          emails,
          generatedAt: new Date().toLocaleString("zh-CN"),
        };

        try {
          const html = reportGen.generateReport(
            {
              title: "邮件摘要报告",
              generatedAt: new Date().toLocaleString("zh-CN"),
              sections: [],
            },
            { templateName: "email-digest", outputPath: outputPath || undefined }
          );
          return { success: true, outputPath: outputPath || "(not saved)", length: html.length };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    );

    this.agentModelExecutor.registerTool(
      "report_weekly",
      {
        name: "report_weekly",
        description: "Generate a weekly summary report with metrics and table data",
        parameters: {
          title: { type: "string", description: "Report title" },
          periodStart: { type: "string", description: "Period start date string" },
          periodEnd: { type: "string", description: "Period end date string" },
          metrics: { type: "string", description: "JSON array of metric items: {label, value, change?, trend?, unit?}" },
          sections: { type: "string", description: "JSON array of sections: {title, tableData?, content?}" },
          outputPath: { type: "string", description: "File path to save the report HTML" },
        },
      },
      async (params: Record<string, unknown>) => {
        const title = String(params.title || "周报");
        const periodStart = String(params.periodStart || "");
        const periodEnd = String(params.periodEnd || "");
        let metrics: unknown[] = [];
        try {
          metrics = JSON.parse(String(params.metrics || "[]"));
        } catch {
          return { error: "metrics must be valid JSON array" };
        }
        let sections: ReportSection[] = [];
        try {
          sections = JSON.parse(String(params.sections || "[]"));
        } catch {
          return { error: "sections must be valid JSON array" };
        }
        const outputPath = String(params.outputPath || "");

        try {
          const html = reportGen.generateReport(
            {
              title: title,
              generatedAt: new Date().toLocaleString("zh-CN"),
              sections,
            },
            { templateName: "weekly-report", outputPath: outputPath || undefined }
          );
          return { success: true, outputPath: outputPath || "(not saved)", length: html.length };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    );
  }

  private registerMarkItDownTools(): void {
    const { execFile } = require("child_process");
    const { promisify } = require("util");
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const execFileAsync = promisify(execFile);

    let mdAvailable: string | null = null;

    const checkAvailable = async (): Promise<boolean> => {
      if (mdAvailable !== null) return mdAvailable !== "";
      try {
        await execFileAsync("markitdown", ["--version"], { timeout: 5000 });
        mdAvailable = "markitdown";
      } catch {
        try {
          await execFileAsync("python", ["-m", "markitdown", "--version"], { timeout: 5000 });
          mdAvailable = "python -m markitdown";
        } catch {
          try {
            await execFileAsync("python3", ["-m", "markitdown", "--version"], { timeout: 5000 });
            mdAvailable = "python3 -m markitdown";
          } catch {
            mdAvailable = "";
            console.log("[MarkItDown] markitdown not found. Install: pip install 'markitdown[all]'");
          }
        }
      }
      return mdAvailable !== "";
    };

    const doConvert = async (inputPath: string): Promise<string | null> => {
      const available = await checkAvailable();
      if (!available || !mdAvailable) return null;
      try {
        const parts = mdAvailable.split(" ");
        const cmd = parts[0];
        const baseArgs = parts.slice(1);
        const args = [...baseArgs, inputPath];
        const { stdout } = await execFileAsync(cmd, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
        return stdout || null;
      } catch (err: any) {
        return null;
      }
    };

    this.agentModelExecutor.registerTool(
      "markitdown_convert",
      {
        name: "markitdown_convert",
        description: "Convert documents (PDF, Word, Excel, PowerPoint, HTML, etc.) or web pages to Markdown format for better readability. Uses microsoft/markitdown. Supports: .pdf .docx .pptx .xlsx .html .csv .json .xml .epub and more. Does NOT support images or videos.",
        parameters: {
          source: { type: "string", description: "File path or URL to convert. Can be a local file path or an HTTP/HTTPS URL." },
          output_format: { type: "string", description: "Output format: 'markdown' (default) or 'text' (plain text without markdown formatting)" },
        },
      },
      async (params: Record<string, unknown>) => {
        const source = String(params.source || "");
        const outputFormat = String(params.output_format || "markdown");
        if (!source) return { error: "Source file path or URL is required" };

        const skipExts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp", ".ico",
          ".mp4", ".avi", ".mkv", ".mov", ".mp3", ".wav", ".ogg", ".flac",
          ".zip", ".tar", ".gz", ".7z", ".rar", ".exe", ".dll"];
        const ext = path.extname(source.split("?")[0]).toLowerCase();
        if (skipExts.includes(ext)) {
          return { error: `File type '${ext}' is not supported. MarkItDown converts documents (PDF, Word, Excel, PPT, HTML, etc.), not images/videos/archives.` };
        }

        const isUrl = source.startsWith("http://") || source.startsWith("https://");

        if (isUrl) {
          const tmpDir = os.tmpdir();
          const tmpFile = path.join(tmpDir, `evoclaw-md-${Date.now()}${ext || ".html"}`);
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            const response = await fetch(source, {
              headers: { "User-Agent": "Mozilla/5.0 (compatible; EvoClaw/1.0; +markitdown)" },
              signal: controller.signal,
              redirect: "follow",
            });
            clearTimeout(timeout);
            if (!response.ok) {
              return { error: `HTTP ${response.status} fetching URL`, source };
            }
            const buffer = await response.arrayBuffer();
            fs.writeFileSync(tmpFile, Buffer.from(buffer));
            const markdown = await doConvert(tmpFile);
            if (!markdown) {
              return { error: "markitdown conversion failed. Ensure markitdown is installed: pip install 'markitdown[all]'", source };
            }
            const result = outputFormat === "text"
              ? markdown.replace(/[#*_\[\](){}|`~>-]/g, "").replace(/\n{3,}/g, "\n\n")
              : markdown;
            return { source, format: "markdown", length: result.length, content: result.slice(0, 30000), truncated: result.length > 30000 };
          } catch (err: any) {
            return { error: err.message || String(err), source };
          } finally {
            try { fs.unlinkSync(tmpFile); } catch {}
          }
        }

        if (!fs.existsSync(source)) {
          return { error: `File not found: ${source}` };
        }
        const stat = fs.statSync(source);
        if (stat.size > 50 * 1024 * 1024) {
          return { error: `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB. Maximum: 50MB.` };
        }

        const markdown = await doConvert(source);
        if (!markdown) {
          return { error: "markitdown conversion failed. Ensure markitdown is installed: pip install 'markitdown[all]'", source };
        }
        const result = outputFormat === "text"
          ? markdown.replace(/[#*_\[\](){}|`~>-]/g, "").replace(/\n{3,}/g, "\n\n")
          : markdown;
        return { source, format: "markdown", length: result.length, content: result.slice(0, 30000), truncated: result.length > 30000 };
      }
    );
  }

  private registerIntelligenceTools(): void {
    const classifier = this.taskClassifier;
    const orchestrator = this.skillOrchestrator;
    const planner = this.taskPlanner;

    this.agentModelExecutor.registerTool(
      "classify_task",
      {
        name: "classify_task",
        description: "Classify a user task to determine category, complexity, and suggest tools/skills",
        parameters: {
          task: { type: "string", description: "The task description to classify" },
        },
      },
      async (params: Record<string, unknown>) => {
        const task = String(params.task || "");
        const result = classifier.classify(task);
        return {
          success: true,
          primaryCategory: result.primaryCategory,
          categories: result.categories,
          confidence: result.confidence,
          complexity: result.complexity,
          suggestedTools: result.suggestedTools,
          suggestedSkills: result.suggestedSkills,
          keywords: result.keywords,
          estimatedSteps: result.estimatedSteps,
          language: result.language,
          hasCode: result.hasCode,
          requiresAuth: result.requiresAuth,
          entities: result.entities,
        };
      }
    );

    this.agentModelExecutor.registerTool(
      "classification_stats",
      {
        name: "classification_stats",
        description: "Get task classification statistics for a batch of tasks",
        parameters: {
          tasks: { type: "string", description: "JSON array of task descriptions" },
        },
      },
      async (params: Record<string, unknown>) => {
        let tasks: string[] = [];
        try {
          tasks = JSON.parse(String(params.tasks || "[]"));
        } catch {
          return { error: "tasks must be a valid JSON array of strings" };
        }

        const results = tasks.map((t) => classifier.classify(t));
        const categoryStats: Record<string, number> = {};
        const complexityStats: Record<string, number> = { simple: 0, medium: 0, complex: 0 };

        for (const r of results) {
          categoryStats[r.primaryCategory] = (categoryStats[r.primaryCategory] || 0) + 1;
          complexityStats[r.complexity] = (complexityStats[r.complexity] || 0) + 1;
        }

        return {
          success: true,
          totalTasks: tasks.length,
          categoryDistribution: categoryStats,
          complexityDistribution: complexityStats,
          averageConfidence: results.reduce((sum, r) => sum + r.confidence, 0) / results.length,
        };
      }
    );

    this.agentModelExecutor.registerTool(
      "orchestrate_skills",
      {
        name: "orchestrate_skills",
        description: "Create and execute a skill orchestration plan with multiple skills in pipeline",
        parameters: {
          name: { type: "string", description: "Plan name" },
          description: { type: "string", description: "Plan description" },
          steps: { type: "string", description: "JSON array of steps: [{name, skillName, dependsOn[], params{}, mergeStrategy}]" },
        },
      },
      async (params: Record<string, unknown>) => {
        const name = String(params.name || "orchestration");
        const description = String(params.description || "");
        let steps: Array<{
          name: string;
          skillName: string;
          dependsOn?: string[];
          params?: Record<string, unknown>;
          mergeStrategy?: "replace" | "merge" | "append" | "none";
        }> = [];
        try {
          steps = JSON.parse(String(params.steps || "[]"));
        } catch {
          return { error: "steps must be a valid JSON array" };
        }
        try {
          const plan = orchestrator.createPlan({ name, description, steps });
          const result = await orchestrator.execute(plan.id);
          return {
            success: result.success,
            planId: result.planId,
            totalDuration: result.totalDuration,
            resultCount: result.results.length,
            aggregatedOutput: result.aggregatedOutput,
            results: result.results.map((r) => ({
              stepId: r.stepId,
              skillName: r.skillName,
              success: r.success,
              duration: r.duration,
              error: r.error,
            })),
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    );

    this.agentModelExecutor.registerTool(
      "task_templates",
      {
        name: "task_templates",
        description: "List available project templates for task decomposition",
        parameters: {},
      },
      async () => {
        const templates = planner.getAvailableTemplates();
        return { success: true, templates, count: templates.length };
      }
    );

    this.agentModelExecutor.registerTool(
      "task_decompose_with_template",
      {
        name: "task_decompose_with_template",
        description: "Decompose a task using a specific project template",
        parameters: {
          task: { type: "string", description: "The task description to decompose" },
          template: { type: "string", description: "Template name: static_website, react_app, api_server, cli_tool, fullstack_app, data_pipeline" },
        },
      },
      async (params: Record<string, unknown>) => {
        const task = String(params.task || "");
        const template = String(params.template || "");
        const plan = planner.decomposeWithTemplate(task, template);
        return {
          planId: plan.id,
          task: plan.task,
          subtaskCount: plan.subtasks.length,
          subtasks: plan.subtasks.map((s) => ({
            id: s.id,
            description: s.description,
            tool: s.tool,
            dependencies: s.dependencies,
          })),
          structure: planner.getTemplateStructure(template),
        };
      }
    );
  }

  private registerSkillIndexTools(): void {
    const index = this.skillIndex;

    this.agentModelExecutor.registerTool(
      "skill_view",
      {
        name: "skill_view",
        description: "View a skill at a specific detail level. Level 0 = brief (~20 tokens), Level 1 = detailed (~200 tokens), Level 2 = full instructions (~1000+ tokens). Default: Level 1.",
        parameters: {
          skill: { type: "string", description: "Skill name or ID to view" },
          level: { type: "number", description: "Detail level: 0 (brief), 1 (detailed), 2 (full). Default: 1" },
        },
      },
      async (params: Record<string, unknown>) => {
        const skillName = String(params.skill || "");
        const level = Number(params.level ?? 1) as 0 | 1 | 2;
        const allEntries = index.getAll();
        const entry = allEntries.find(e => e.name === skillName || e.id === skillName);
        if (!entry) return { error: `Skill "${skillName}" not found in index` };
        const content = index.getSkillLevel(entry.id, level);
        if (!content) return { error: `Skill "${skillName}" level ${level} not available` };
        return { skillName: entry.name, level, content, successRate: entry.successRate, useCount: entry.useCount };
      }
    );

    this.agentModelExecutor.registerTool(
      "skill_index_list",
      {
        name: "skill_index_list",
        description: "List all skills in the compact Level 0 index (minimal token usage)",
        parameters: {},
      },
      async () => {
        const level0 = index.getLevel0Index();
        const count = index.getSize();
        return { count, index: level0 };
      }
    );
  }

  getRegistry(): ServiceRegistry {
    return this.registry;
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }
}

async function main(): Promise<void> {
  const server = new EvoClawServer();
  await server.start();
}

main().catch((err) => {
  const logger = Logger.getInstance();
  logger.fatal("server", "Failed to start", err);
  process.exit(1);
});

export { main };