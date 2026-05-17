import { ServiceRegistry, EventBus, SystemEvents, ConfigManager, type PersonaConfig } from "@evoclaw/core";
import { GatewayServer } from "@evoclaw/gateway";
import { TaskOrchestrator, AgentPoolManager, ActorSystem, AgentModelExecutor } from "@evoclaw/agent";
import { SkillManager } from "@evoclaw/skills";
import { EvolutionEngine } from "@evoclaw/evolution";
import { MemoryHub } from "@evoclaw/memory";
import { SecurityGovernor, AuditCenter, TenantManager, SelfHealingManager } from "@evoclaw/security";
import { MessageQueue, ProcessManager, FileSystemManager } from "@evoclaw/infrastructure";
import * as fs from "fs";
import * as path from "path";

export class EcoClawServer {
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
    console.log("  EcoClaw v0.4.0 - Self-Evolving Agent OS");
    console.log("============================================");

    await this.eventBus.publish(SystemEvents.SYSTEM_STARTING, null, "server");

    console.log("\n[EcoClaw] Starting all services...");

    console.log("[EcoClaw] Gateway server starting...");
    await this.gateway.start();

    console.log("[EcoClaw] Agent pool starting...");
    console.log("[EcoClaw] Agent pool initialized");

    console.log("[EcoClaw] Skill manager starting...");
    console.log("[EcoClaw] Skill manager ready");

    const skillsDir = path.resolve("skills");
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
    this.skillManager.startAutoScan(skillsDir, 30000);

    console.log("[EcoClaw] Evolution engine starting...");
    console.log("[EcoClaw] Evolution engine online");

    console.log("[EcoClaw] Memory hub starting...");
    console.log("[EcoClaw] Memory hub active");

    console.log("[EcoClaw] Security governor engaged");
    console.log("[EcoClaw] Audit center online");

    console.log("[EcoClaw] Tenant manager starting...");
    console.log("[EcoClaw] Tenant manager ready");

    console.log("[EcoClaw] Self-healing monitor starting...");
    this.selfHealing.start();

    this.tenantManager.createTenant("default", {
      defaultLanguage: "zh-CN",
      timezone: "Asia/Shanghai",
    });

    await this.eventBus.publish(SystemEvents.SYSTEM_READY, {
      version: "0.2.0",
      serviceCount: this.registry.getRegisteredServices().length,
    }, "server");

    console.log("\n[EcoClaw] All systems ready!");
    console.log("[EcoClaw] Registered services:", this.registry.getRegisteredServices().join(", "));
    console.log("\n============================================\n");

    this.eventBus.subscribe("system.shutdown", async () => {
      await this.shutdown();
    });

    process.on("SIGINT", async () => {
      console.log("[EcoClaw] Received SIGINT");
      await this.shutdown();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("[EcoClaw] Received SIGTERM");
      await this.shutdown();
      process.exit(0);
    });

    process.on("uncaughtException", (err) => {
      console.error("[EcoClaw] Uncaught exception:", err.message);
      process.exit(1);
    });

    process.on("unhandledRejection", (reason) => {
      console.error("[EcoClaw] Unhandled rejection:", reason);
    });
  }

  async shutdown(): Promise<void> {
    console.log("[EcoClaw] Shutting down...");
    this.selfHealing.stop();
    await this.eventBus.publish(SystemEvents.SYSTEM_SHUTTING_DOWN, null, "server");
    await this.processManager.killAll();
    await this.gateway.stop();
    await this.registry.stopAll();
    console.log("[EcoClaw] Goodbye!");
  }

  getRegistry(): ServiceRegistry {
    return this.registry;
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }
}

async function main(): Promise<void> {
  const server = new EcoClawServer();
  await server.start();
}

main().catch((err) => {
  console.error("[EcoClaw] Failed to start:", err);
  process.exit(1);
});

export { main };