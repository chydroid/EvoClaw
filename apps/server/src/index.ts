import { ServiceRegistry, EventBus, SystemEvents, ConfigManager, type PersonaConfig } from "@evoclaw/core";
import { GatewayServer } from "@evoclaw/gateway";
import { TaskOrchestrator, AgentPoolManager, ActorSystem, AgentModelExecutor } from "@evoclaw/agent";
import { SkillManager, AutoSkillManager } from "@evoclaw/skills";
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
  private autoSkillManager: AutoSkillManager;

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
    this.autoSkillManager = new AutoSkillManager(this.registry, this.eventBus, path.resolve("skills"));
  }

  async start(): Promise<void> {
    console.log("============================================");
    console.log("  EcoClaw v0.4.0 - Self-Evolving Agent OS");
    console.log("============================================");

    await this.eventBus.publish(SystemEvents.SYSTEM_STARTING, null, "server");

    console.log("\n[EcoClaw] Starting all services...");

    console.log("[EcoClaw] Gateway server starting...");
    await this.gateway.start();

    console.log("[EcoClaw] Loading persisted configuration...");
    this.gateway.loadPersistedConfig();

    console.log("[EcoClaw] Agent pool starting...");
    console.log("[EcoClaw] Agent pool initialized");

    console.log("[EcoClaw] Skill manager starting...");
    console.log("[EcoClaw] Skill manager ready");

    const skillsDir = path.resolve("skills");
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
    this.skillManager.startAutoScan(skillsDir, 30000);

    const fsBase = path.resolve(".");
    this.fileSystemManager.setBasePath(fsBase);
    this.registerFileTools();
    this.registerAutoSkillTool();

    console.log("[EcoClaw] File operation tools registered");
    console.log("[EcoClaw] Auto-skill discovery enabled");

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

  private registerFileTools(): void {
    const fsMgr = this.fileSystemManager;

    this.agentModelExecutor.registerTool(
      "file_create",
      {
        name: "file_create",
        description: "Create a new file at the specified path with the given content",
        parameters: {
          path: { type: "string", description: "Relative file path to create" },
          content: { type: "string", description: "Content to write to the file" },
        },
      },
      async (params: Record<string, unknown>) => {
        const filePath = String(params.path || "");
        const content = String(params.content || "");
        return await fsMgr.createFile(filePath, content);
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
        return await fsMgr.modifyFile(filePath, content);
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
        await fsMgr.deleteFile(filePath);
        return { success: true, path: filePath };
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
        const content = await fsMgr.readFile(filePath);
        return { path: filePath, content };
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
        return await fsMgr.listAll(dirPath);
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