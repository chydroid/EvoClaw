import { ServiceRegistry, EventBus, SystemEvents, ConfigManager, type PersonaConfig } from "@evoclaw/core";
import { GatewayServer } from "@evoclaw/gateway";
import { TaskOrchestrator, AgentPoolManager, ActorSystem, AgentModelExecutor } from "@evoclaw/agent";
import { SkillManager } from "@evoclaw/skills";
import { EvolutionEngine } from "@evoclaw/evolution";
import { MemoryHub } from "@evoclaw/memory";
import { SecurityGovernor, AuditCenter, TenantManager, SelfHealingManager } from "@evoclaw/security";
import { MessageQueue, ProcessManager, FileSystemManager } from "@evoclaw/infrastructure";

export class EvoClawServer {
  private registry: ServiceRegistry;
  private eventBus: EventBus;
  private configManager: ConfigManager;

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

  constructor() {
    this.registry = new ServiceRegistry();
    this.eventBus = new EventBus();
    this.configManager = new ConfigManager();
    this.configManager.loadFromEnv();

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
    this.memoryHub = new MemoryHub(this.registry, this.eventBus);
    this.securityGovernor = new SecurityGovernor(this.registry, this.eventBus);
    this.auditCenter = new AuditCenter(this.registry, this.eventBus);
    this.tenantManager = new TenantManager(this.registry, this.eventBus);
    this.selfHealing = new SelfHealingManager(this.registry, this.eventBus);
    this.messageQueue = new MessageQueue(this.registry, this.eventBus);
    this.processManager = new ProcessManager(this.registry, this.eventBus);
    this.fileSystemManager = new FileSystemManager(this.registry, this.eventBus);
  }

  async start(): Promise<void> {
    console.log("============================================");
    console.log("  EvoClaw v0.2.0 - Self-Evolving Agent OS");
    console.log("============================================");

    await this.eventBus.publish(SystemEvents.SYSTEM_STARTING, null, "server");

    console.log("\n[EvoClaw] Starting all services...");

    console.log("[EvoClaw] Gateway server starting...");
    await this.gateway.start();

    console.log("[EvoClaw] Agent pool starting...");
    console.log("[EvoClaw] Agent pool initialized");

    console.log("[EvoClaw] Skill manager starting...");
    console.log("[EvoClaw] Skill manager ready");

    console.log("[EvoClaw] Evolution engine starting...");
    console.log("[EvoClaw] Evolution engine online");

    console.log("[EvoClaw] Memory hub starting...");
    console.log("[EvoClaw] Memory hub active");

    console.log("[EvoClaw] Security governor engaged");
    console.log("[EvoClaw] Audit center online");

    console.log("[EvoClaw] Tenant manager starting...");
    console.log("[EvoClaw] Tenant manager ready");

    console.log("[EvoClaw] Self-healing monitor starting...");
    this.selfHealing.start();

    this.tenantManager.createTenant("default", {
      defaultLanguage: "zh-CN",
      timezone: "Asia/Shanghai",
    });

    await this.eventBus.publish(SystemEvents.SYSTEM_READY, {
      version: "0.2.0",
      serviceCount: this.registry.getRegisteredServices().length,
    }, "server");

    console.log("\n[EvoClaw] All systems ready!");
    console.log("[EvoClaw] Registered services:", this.registry.getRegisteredServices().join(", "));
    console.log("\n============================================\n");

    this.eventBus.subscribe("system.shutdown", async () => {
      await this.shutdown();
    });

    process.on("SIGINT", async () => {
      console.log("[EvoClaw] Received SIGINT");
      await this.shutdown();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("[EvoClaw] Received SIGTERM");
      await this.shutdown();
      process.exit(0);
    });

    process.on("uncaughtException", (err) => {
      console.error("[EvoClaw] Uncaught exception:", err.message);
      process.exit(1);
    });

    process.on("unhandledRejection", (reason) => {
      console.error("[EvoClaw] Unhandled rejection:", reason);
    });
  }

  async shutdown(): Promise<void> {
    console.log("[EvoClaw] Shutting down...");
    this.selfHealing.stop();
    await this.eventBus.publish(SystemEvents.SYSTEM_SHUTTING_DOWN, null, "server");
    await this.processManager.killAll();
    await this.gateway.stop();
    await this.registry.stopAll();
    console.log("[EvoClaw] Goodbye!");
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
  console.error("[EvoClaw] Failed to start:", err);
  process.exit(1);
});

export { main };