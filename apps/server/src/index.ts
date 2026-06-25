import dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import * as dns from "dns";
import { initTracing, shutdownTracing, spanCollector } from "./tracing";

// IPv4 优先：避免 IPv6 DNS 解析延迟（借鉴 hermes-agent apply_ipv4_preference）
dns.setDefaultResultOrder("ipv4first");

dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

function getServerVersion(): string {
  try {
    // Try multiple paths to find root package.json
    const candidates = [
      path.resolve(__dirname, "../../../../package.json"),
      path.resolve(__dirname, "../../../package.json"),
      path.resolve(__dirname, "../../package.json"),
      path.resolve(process.cwd(), "package.json"),
    ];
    for (const pkgPath of candidates) {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.version && pkg.name === "evoclaw") return pkg.version;
      }
    }
  } catch { /* version detection failed, using fallback */ }
  return "0.0.0-unknown";
}
const SERVER_VERSION = getServerVersion();
// 设置全局版本号，供 gateway健康检查和 /api/version 端点使用
(globalThis as Record<string, unknown>).__EVOCLAW_VERSION__ = SERVER_VERSION;

import { ServiceRegistry, EventBus, SystemEvents, ConfigManager, PluginManager, ConfigValidator, ConfigWatcher, CONFIG_SCHEMA, printMigrationHints, FeatureFlagStore } from "@evoclaw/core";
import { GatewayServer, ChannelManager, ProtocolHandler, WeixinPluginAdapter, ReplyReferenceManager, DeadLetterQueue, VoiceService } from "@evoclaw/gateway";
import { TaskOrchestrator, AgentPoolManager, ActorSystem, AgentModelExecutor, TaskPlanner, BootstrapManager, CompactionManager, AgentLifecycleManager, QueueManager, SessionManager, ContextEngine, AgentRouter, SubagentRegistry, AutoReplyEngine, CommitmentManager, EventLedger, ExecutionCheckpointStore, HumanApprovalManager, TokenUsageTracker } from "@evoclaw/agent";
import { SkillManager, AutoSkillManager, SkillDispatcher } from "@evoclaw/skills";
import { EvolutionEngine } from "@evoclaw/evolution";
import { MemoryHub, SemanticMemoryStore, MemoryHost } from "@evoclaw/memory";
import { SecurityGovernor, AuditCenter, TenantManager, SelfHealingManager, PermissionManager, ErrorRecoveryManager, ToolPolicyManager, DMPairingManager, PermissionRelay, TranscriptRedactor, MCPToolPoisoningScanner, ApprovalTimeoutManager } from "@evoclaw/security";
import { MessageQueue, ProcessManager, FileSystemManager, BrowserController, PlaywrightBrowser, Logger, Crestodian, Observability } from "@evoclaw/infrastructure";
import { EmailClient } from "@evoclaw/email";
import { ScheduleManager, CronScheduler } from "@evoclaw/scheduler";
import { ReportGenerator } from "@evoclaw/reporting";
import type { ReportData, ReportSection } from "@evoclaw/reporting";
import { TaskClassifier, SkillOrchestrator } from "@evoclaw/intelligence";
import { SecurityMiddleware } from "@evoclaw/security";
import { CopilotRouter, CredentialPool, A2AClient, A2AServer, EvalRunner, BUILTIN_EVAL_CASES } from "@evoclaw/agent";
import { SkillIndex } from "@evoclaw/skills";
import {
  registerFileTools,
  registerAutoSkillTools,
  registerBrowserTools,
  registerWebTools,
  registerEmailTools,
  registerSchedulerTools,
  registerShellMediaTools,
  registerSkillIndexTools,
  registerDocxTools,
  registerXlsxTools,
  registerPptxTools,
  registerVideoTools,
  registerImageTools,
} from "./tools";

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
  private evalRunner: EvalRunner;

  constructor() {
    this.registry = new ServiceRegistry();
    this.eventBus = new EventBus();
    // Expose the in-memory OTel span collector as a registry service so the
    // gateway can surface live traces via the /api/tracing/* endpoints.
    this.registry.registerService("spanCollector", spanCollector);
    // 注册 packageJson 供 /api/version 等端点读取版本号
    this.registry.registerService("packageJson", { version: SERVER_VERSION, name: "evoclaw" });
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
    // Agent-layer observability will be registered after agentModelExecutor is created
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
      { key: "humanApproval", description: "人工审批 — 高风险工具操作需人工确认后执行", enabled: true, owner: "security", updatedAt: Date.now() },
      { key: "a2a", description: "A2A协议 — Agent-to-Agent跨框架通信协议支持", enabled: true, owner: "integration", updatedAt: Date.now() },
    ]);
    this.registry.registerService("featureFlagStore", this.featureFlagStore);

    // ── Config validation (OpenClaw parity) ──
    this.configValidator = new ConfigValidator(CONFIG_SCHEMA);
    this.registry.registerService("configValidator", this.configValidator);
    this.registry.registerService("config", this.configManager);

    this.configWatcher = new ConfigWatcher();
    const configFilePath = path.resolve(process.cwd(), "config.json");
    if (fs.existsSync(configFilePath)) {
      this.configManager.startWatching(configFilePath, this.configWatcher);
    } else {
      this.logger.info("config", `Optional config file not found, skipping hot-reload: ${configFilePath}`);
    }
    this.configManager.onChange((change) => {
      this.eventBus.publish("config.changed", change, "config-manager").catch(() => {});
    });
    this.configWatcher.onChange((filePath) => {
      this.logger.info("config", `Config file changed: ${filePath}, reloading...`);
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
    this.crestodian.setServiceHealth("gatewayServer", "ok", { port: process.env.EvoClaw_PORT || "27788" });
    this.crestodian.setServiceHealth("autoSkillManager", "ok");
    this.crestodian.setServiceHealth("skillDispatcher", "ok");
    this.crestodian.setServiceHealth("eventLedger", "ok");
    this.crestodian.setServiceHealth("permissionManager", "ok");
    this.crestodian.setServiceHealth("taskOrchestrator", "ok");
    this.crestodian.setServiceHealth("featureFlagStore", "ok");
    this.registry.registerService("crestodian", this.crestodian);

    this.registry.registerService("registry", this.registry);
    this.registry.registerService("eventBus", this.eventBus);

    const dataDir = path.resolve(__dirname, "..", "..", "..", "data");

    // ── Voice Service (local speech recognition) ──
    const voiceService = new VoiceService(path.join(dataDir, "voice"));
    this.registry.registerService("voiceService", voiceService);

    this.gateway = new GatewayServer(this.registry, this.eventBus);
    this.agentPool = new AgentPoolManager(this.registry, this.eventBus);
    this.registry.registerService("agentPool", this.agentPool);
    this.taskOrchestrator = new TaskOrchestrator(this.registry, this.eventBus);
    this.registry.registerService("taskOrchestrator", this.taskOrchestrator);
    this.actorSystem = new ActorSystem();
    this.registry.registerService("actorSystem", this.actorSystem);
    this.agentModelExecutor = new AgentModelExecutor(
      this.registry,
      this.eventBus,
      undefined,
      this.configManager.get("persona"),
      { storeDir: dataDir }
    );
    // Register TokenUsageTracker for real-time token/cost tracking
    const tokenUsageTracker = new TokenUsageTracker({
      retainCount: 10000,
      cache: this.agentModelExecutor.getModelCostProvider?.() as any,
      storeDir: path.join(dataDir, "token-usage"),
    });
    this.registry.registerService("tokenUsageTracker", tokenUsageTracker);
    // Wire token usage recording into the LLM call flow
    this.agentModelExecutor.setTokenUsageTracker(tokenUsageTracker);
    // Register agent-layer observability for /metrics endpoint
    const agentObs = this.agentModelExecutor.getAgentObservability();
    if (agentObs) {
      this.registry.registerService("agentObservability", agentObs);
    }
    // Register the execution checkpoint store as a service for system-wide access
    const executionCheckpointStore = this.agentModelExecutor.getExecutionCheckpointStore();
    this.registry.registerService("executionCheckpointStore", executionCheckpointStore);
    this.skillManager = new SkillManager(this.registry, this.eventBus);
    this.evolutionEngine = new EvolutionEngine(this.registry, this.eventBus, { storeDir: dataDir });
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
      maxContextTokens: 128000,
      reserveTokens: 4000,
    });
    this.agentModelExecutor.setContextEngine(this.contextEngine);
    this.registry.registerService("contextEngine", this.contextEngine);

    // ── ContextPruning: trim large tool results and clear old ones ──
    const { ContextPruningManager } = require("@evoclaw/agent");
    const contextPruningManager = new ContextPruningManager({
      softTrimThreshold: 4000,
      hardClearTurnThreshold: 10,
      enableSoftTrim: true,
      enableHardClear: true,
    });
    this.agentModelExecutor.setContextPruningManager(contextPruningManager);
    this.registry.registerService("contextPruningManager", contextPruningManager);
    process.stdout.write(`[Server] ContextPruning initialized`);

    // ── InputPipeline: sequential stage-based input processing ──
    const { PipelineRunner, createXssSanitizeStage, createSystemTagSanitizeStage, createLengthGuardStage, createEchoDetectionStage, createAttachmentInjectionStage, createGuardrailsStage, createPluginPreProcessStage } = require("@evoclaw/agent");
    const inputPipeline = new PipelineRunner([
      createXssSanitizeStage(),
      createSystemTagSanitizeStage(),
      createLengthGuardStage(4000),
      createEchoDetectionStage(),
      createAttachmentInjectionStage(),
      createGuardrailsStage(this.agentModelExecutor.getGuardrailsManager()),
      createPluginPreProcessStage(this.pluginManager),
    ]);
    this.agentModelExecutor.setInputPipeline(inputPipeline);
    this.registry.registerService("inputPipeline", inputPipeline);
    process.stdout.write(`[Server] InputPipeline initialized with 7 stages`);

    // ── CopilotRouter: route simple tasks to cheaper models ──
    // v0.42.0: No longer defaults to gpt-4o-mini. Uses user's LLM config order.
    // When local model is available, simple tasks route to local Qwen2.5-0.5B.
    this.agentModelExecutor.setCopilotRouter({
      enabled: true,
      defaultModel: "",  // Will use first enabled user provider
      defaultProvider: "",  // Will use first enabled user provider
    });
    process.stdout.write(`[Server] CopilotRouter initialized (respects user LLM config order)`);

    this.channelManager = new ChannelManager(this.eventBus);
    this.agentModelExecutor.setChannelManager(this.channelManager as any);
    this.registry.registerService("channelManager", this.channelManager);

    // ── Dead Letter Queue ──
    const dlq = new DeadLetterQueue({ storageDir: path.resolve("data", "dlq") });
    this.registry.registerService("deadLetterQueue", dlq);
    this.channelManager.onSendFailure((channel, target, text, error) => {
      try {
        dlq.enqueue({
          channel,
          target,
          content: text,
          contentType: "text",
          error,
          retryCount: 0,
          originalSentAt: new Date().toISOString(),
          failureType: "unknown",
        });
      } catch { /* non-critical */ }
    });

    // ── Reply Reference Manager ──
    const replyRefManager = new ReplyReferenceManager({ autoClean: true, cleanIntervalMs: 300_000 });
    this.registry.registerService("replyReferenceManager", replyRefManager);

    // ── Human-in-the-Loop Approval Manager (feature-flagged, default: off) ──
    if (this.featureFlagStore.isEnabled("humanApproval")) {
      const humanApprovalManager = new HumanApprovalManager();
      this.agentModelExecutor.setHumanApprovalManager(humanApprovalManager);
      this.registry.registerService("humanApprovalManager", humanApprovalManager);
      this.logger.info("server", "Human-in-the-Loop approval system enabled");
    }

    // ── A2A (Agent-to-Agent) Protocol (feature-flagged, default: off) ──
    const a2aClient = new A2AClient();
    this.registry.registerService("a2aClient", a2aClient);

    const a2aServer = new A2AServer({
      publicUrl: process.env.EVOCLAW_A2A_URL || `http://localhost:${process.env.EvoClaw_PORT || "27788"}`,
      enabled: this.featureFlagStore.isEnabled("a2a"),
      authType: (process.env.EVOCLAW_A2A_AUTH as "none" | "api_key") || "api_key",
      validApiKeys: process.env.EVOCLAW_A2A_API_KEYS?.split(",").map(k => k.trim()).filter(Boolean),
    });
    a2aServer.setTaskHandler(async (task) => {
      const input = typeof task.input === "string" ? task.input : JSON.stringify(task.input);
      const result = await this.agentModelExecutor.chat(input, { sessionId: `a2a-${task.id}` });
      return result;
    });
    a2aServer.buildCapabilitiesFromTools(this.agentModelExecutor.getRegisteredTools());
    this.registry.registerService("a2aServer", a2aServer);
    if (a2aServer.isEnabled()) {
      this.logger.info("server", "A2A protocol server enabled");
    }

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
    this.autoSkillManager = new AutoSkillManager(this.registry, this.eventBus, path.resolve(__dirname, "..", "..", "..", "data", "skills"));
    this.skillDispatcher = new SkillDispatcher(this.registry, this.eventBus);
    this.skillDispatcher.initialize();
    this.taskPlanner = new TaskPlanner(this.registry, this.eventBus);
    this.permissionManager = new PermissionManager(this.registry, this.eventBus);
    this.registry.registerService("permissionManager", this.permissionManager);
    this.errorRecoveryManager = new ErrorRecoveryManager(this.registry, this.eventBus);

    // Security services: TranscriptRedactor, MCPToolPoisoningScanner, ApprovalTimeoutManager
    const transcriptRedactor = new TranscriptRedactor();
    this.registry.registerService("transcriptRedactor", transcriptRedactor);
    const mcpPoisoningScanner = new MCPToolPoisoningScanner();
    this.registry.registerService("mcpPoisoningScanner", mcpPoisoningScanner);
    const approvalTimeoutManager = new ApprovalTimeoutManager({ askFallback: "fail-closed" });
    this.registry.registerService("approvalTimeoutManager", approvalTimeoutManager);

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

    // ── Eval Runner (Agent behavior evaluation) ──
    this.evalRunner = new EvalRunner();
    this.evalRunner.addCases(BUILTIN_EVAL_CASES);
    this.registry.registerService("evalRunner", this.evalRunner);
    this.agentModelExecutor.setEvalRunner(this.evalRunner);

    // Initialize Weixin plugin adapter
    this.weixinPluginAdapter = new WeixinPluginAdapter(this.eventBus, this.agentModelExecutor);
  }

  async start(): Promise<void> {
    // Initialize OpenTelemetry tracing before any other initialization
    initTracing("evoclaw", SERVER_VERSION, process.env.EVOCLAW_OTLP_ENDPOINT);

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

    // Initialize migration system (detect version changes, load persisted records)
    this.gateway.initMigrations(path.resolve("data"), SERVER_VERSION);

    // Connect channel message handler to agent
    this.channelManager.setMessageHandler(async (msg) => {
      try {
        this.logger.info("channel", `Message from ${msg.channel}: ${msg.from} -> ${msg.text?.slice(0, 50)}`);
        const sessionId = `${msg.channel}-${msg.from}`;
        const result = await this.agentModelExecutor.chat(msg.text, {
          sessionId,
          channel: msg.channel,
          peerId: msg.from,
        });
        if (result?.reply && msg.isDirect) {
          let replyText = result.reply;
          // For IM channels, append file info if files were created
          if (result.files && result.files.length > 0 && msg.channel !== "webchat" && msg.channel !== "cli") {
            const fileInfo = result.files
              .filter(f => f.path)
              .map(f => `📄 文件已保存至本地: ${f.path}`)
              .join("\n");
            if (fileInfo) {
              replyText += "\n\n" + fileInfo;
            }
          }
          await this.channelManager.sendMessage(msg.channel, msg.from, replyText);
        }
      } catch (err) {
        this.logger.error("channel", `Failed to handle channel message: ${err}`);
      }
    });

    this.logger.info("server", "Agent pool starting...");
    this.logger.info("server", "Agent pool initialized");

    this.logger.info("server", "Skill manager starting...");
    this.logger.info("server", "Skill manager ready");

    const workspaceDir = path.resolve(__dirname, "..", "..", "..", "data", "workspace");
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }
    const skillsDir = path.resolve(__dirname, "..", "..", "..", "data", "skills");
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
    // Auto-skill scan interval: default 5 minutes (300000ms), configurable via env.
    // Previous values: 30s (data/skills) / 60s (bundled) — caused excessive I/O on large skill dirs.
    const skillScanIntervalMs = Number(process.env.EVOCLAW_SKILL_SCAN_INTERVAL_MS) || 300_000;
    this.skillManager.startAutoScan(skillsDir, skillScanIntervalMs);
    const bundledSkillsDir = path.resolve(__dirname, "..", "..", "..", "packages", "skills", "bundled");
    if (fs.existsSync(bundledSkillsDir)) {
      this.skillManager.startAutoScan(bundledSkillsDir, skillScanIntervalMs);
    }

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
    this.registerDocxTools(fsBase);
    this.registerXlsxTools(fsBase);
    this.registerPptxTools(fsBase);
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
      try { await this.shutdown(); } catch (err) { this.logger.error("server", "Shutdown error", err instanceof Error ? err : new Error(String(err))); }
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      this.logger.info("server", "Received SIGTERM");
      try { await this.shutdown(); } catch (err) { this.logger.error("server", "Shutdown error", err instanceof Error ? err : new Error(String(err))); }
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

  private shuttingDown = false;

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
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
    await shutdownTracing();
    this.logger.info("server", "Goodbye!");
  }

  private registerFileTools(fsBase: string): void {
    registerFileTools(
      this.agentModelExecutor,
      this.permissionManager,
      this.permissionRelay,
      this.errorRecoveryManager,
      this.fileSystemManager,
      fsBase
    );
  }

  private registerDocxTools(fsBase: string): void {
    registerDocxTools(this.agentModelExecutor, fsBase);
  }

  private registerXlsxTools(fsBase: string): void {
    registerXlsxTools(this.agentModelExecutor, fsBase);
  }

  private registerPptxTools(fsBase: string): void {
    registerPptxTools(this.agentModelExecutor, fsBase);
  }

  private registerAutoSkillTool(): void {
    registerAutoSkillTools(
      this.agentModelExecutor,
      this.autoSkillManager,
      this.skillManager,
      this.registry
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
          } catch { /* bootstrap memory store failure is non-critical */ }
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
    registerBrowserTools(
      this.agentModelExecutor,
      this.browserController,
      this.playwrightBrowser,
      this.registry,
      this.eventBus,
      this.fileSystemManager
    );
    registerWebTools(
      this.agentModelExecutor,
      this.skillManager
    );
    registerEmailTools(
      this.agentModelExecutor,
      this.emailClient,
      this.permissionManager
    );
  }

  private registerSchedulerTools(): void {
    registerSchedulerTools(
      this.agentModelExecutor,
      this.scheduleManager,
      this.emailClient,
      this.eventBus,
      this.reportGenerator,
      this.playwrightBrowser
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
              sections: [
                {
                  id: "overview",
                  title: "概览",
                  type: "table" as const,
                  data: {
                    headers: ["指标", "值"],
                    rows: [
                      ["邮件总数", String(templateData.totalEmails)],
                      ["时间范围", templateData.dateRange || "全部"],
                      ["分类数", String(templateData.categoriesBreakdown.length)],
                    ],
                  },
                },
                {
                  id: "categories",
                  title: "分类统计",
                  type: "table" as const,
                  data: {
                    headers: ["分类", "数量"],
                    rows: templateData.categoriesBreakdown.map(c => [c.name, String(c.count)]),
                  },
                },
              ],
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
            process.stdout.write("[MarkItDown] markitdown not found. Install: pip install 'markitdown[all]'");
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
          // SSRF protection: validate URL before fetching
          const ssrfProtection = this.registry.resolveService<import("@evoclaw/security").SSRFProtection>("ssrfProtection");
          if (ssrfProtection) {
            const ssrfResult = await ssrfProtection.checkURL(source);
            if (!ssrfResult.allowed) {
              return { error: `URL blocked by security policy: ${ssrfResult.reason}`, source };
            }
          }

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
            try { fs.unlinkSync(tmpFile); } catch { /* temp file cleanup failure is non-critical */ }
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
          averageConfidence: results.length > 0 ? results.reduce((sum, r) => sum + r.confidence, 0) / results.length : 0,
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
    registerSkillIndexTools(
      this.agentModelExecutor,
      this.skillIndex
    );
    registerShellMediaTools(
      this.agentModelExecutor
    );
    registerVideoTools(
      this.agentModelExecutor
    );
    registerImageTools(
      this.agentModelExecutor
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
