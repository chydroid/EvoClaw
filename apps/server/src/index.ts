import dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

import { ServiceRegistry, EventBus, SystemEvents, ConfigManager, type PersonaConfig } from "@evoclaw/core";
import { GatewayServer } from "@evoclaw/gateway";
import { TaskOrchestrator, AgentPoolManager, ActorSystem, AgentModelExecutor, TaskPlanner } from "@evoclaw/agent";
import { SkillManager, AutoSkillManager } from "@evoclaw/skills";
import { EvolutionEngine } from "@evoclaw/evolution";
import { MemoryHub } from "@evoclaw/memory";
import { SecurityGovernor, AuditCenter, TenantManager, SelfHealingManager, PermissionManager, ErrorRecoveryManager } from "@evoclaw/security";
import { MessageQueue, ProcessManager, FileSystemManager, BrowserController } from "@evoclaw/infrastructure";
import * as fs from "fs";

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
  private taskPlanner: TaskPlanner;
  private permissionManager: PermissionManager;
  private errorRecoveryManager: ErrorRecoveryManager;
  private browserController: BrowserController;

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
    this.autoSkillManager = new AutoSkillManager(this.registry, this.eventBus, path.resolve(__dirname, "..", "..", "..", "skills"));
    this.taskPlanner = new TaskPlanner(this.registry, this.eventBus);
    this.permissionManager = new PermissionManager(this.registry, this.eventBus);
    this.errorRecoveryManager = new ErrorRecoveryManager(this.registry, this.eventBus);
    this.browserController = new BrowserController(this.registry, this.eventBus);
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

    const skillsDir = path.resolve(__dirname, "..", "..", "..", "skills");
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
    this.skillManager.startAutoScan(skillsDir, 30000);

    const fsBase = path.resolve(__dirname, "..", "..", "..");
    this.fileSystemManager.setBasePath(fsBase);
    this.registerFileTools();
    this.registerAutoSkillTool();
    this.registerTaskPlannerTool();
    this.registerPermissionTools();
    this.registerBrowserTools();

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
    const errRecovery = this.errorRecoveryManager;
    const permMgr = this.permissionManager;

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
        const permRequest = permMgr.requestPermission("file_create", filePath, { size: content.length }, "tool");
        if (permRequest.status === "denied") {
          return { success: false, error: `Permission denied for file_create on ${filePath}. Request ID: ${permRequest.id}` };
        }
        if (permRequest.status === "pending") {
          return { success: false, requiresPermission: true, requestId: permRequest.id, description: permRequest.description, target: filePath, error: `Awaiting user approval to create: ${filePath}` };
        }
        return await errRecovery.executeWithRetry("file_create", filePath, () => fsMgr.createFile(filePath, content));
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
        const permRequest = permMgr.requestPermission("file_modify", filePath, { size: content.length }, "tool");
        if (permRequest.status === "denied") {
          return { success: false, error: `Permission denied for file_modify on ${filePath}. Request ID: ${permRequest.id}` };
        }
        if (permRequest.status === "pending") {
          return { success: false, requiresPermission: true, requestId: permRequest.id, description: permRequest.description, target: filePath, error: `Awaiting user approval to modify: ${filePath}` };
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
        const permRequest = permMgr.requestPermission("file_delete", filePath, {}, "tool");
        if (permRequest.status === "denied") {
          return { success: false, error: `Permission denied for file_delete on ${filePath}. Request ID: ${permRequest.id}` };
        }
        if (permRequest.status === "pending") {
          return { success: false, requiresPermission: true, requestId: permRequest.id, description: permRequest.description, target: filePath, error: `Awaiting user approval to delete: ${filePath}` };
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