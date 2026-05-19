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
import { MessageQueue, ProcessManager, FileSystemManager, BrowserController, PlaywrightBrowser } from "@evoclaw/infrastructure";
import { EmailClient } from "@evoclaw/email";
import type { EmailAccount, ParsedEmail } from "@evoclaw/email";
import { ScheduleManager } from "@evoclaw/scheduler";
import type { ScheduledTask } from "@evoclaw/scheduler";
import { ReportGenerator } from "@evoclaw/reporting";
import type { ReportData, ReportSection } from "@evoclaw/reporting";
import { TaskClassifier, SkillOrchestrator } from "@evoclaw/intelligence";
import type { ClassificationResult, OrchestrationPlan } from "@evoclaw/intelligence";
import * as fs from "fs";

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
  private autoSkillManager: AutoSkillManager;
  private taskPlanner: TaskPlanner;
  private permissionManager: PermissionManager;
  private errorRecoveryManager: ErrorRecoveryManager;
  private browserController: BrowserController;
  private playwrightBrowser: PlaywrightBrowser;
  private emailClient: EmailClient;
  private scheduleManager: ScheduleManager;
  private reportGenerator: ReportGenerator;
  private taskClassifier: TaskClassifier;
  private skillOrchestrator: SkillOrchestrator;

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
  }

  async start(): Promise<void> {
    console.log("============================================");
    console.log("  EvoClaw v0.4.0 - Self-Evolving Agent OS");
    console.log("============================================");

    await this.eventBus.publish(SystemEvents.SYSTEM_STARTING, null, "server");

    console.log("\n[EvoClaw] Starting all services...");

    console.log("[EvoClaw] Gateway server starting...");
    await this.gateway.start();

    console.log("[EvoClaw] Loading persisted configuration...");
    this.gateway.loadPersistedConfig();

    console.log("[EvoClaw] Agent pool starting...");
    console.log("[EvoClaw] Agent pool initialized");

    console.log("[EvoClaw] Skill manager starting...");
    console.log("[EvoClaw] Skill manager ready");

    const skillsDir = path.resolve(__dirname, "..", "..", "..", "skills");
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
    this.skillManager.startAutoScan(skillsDir, 30000);

    const workspaceDir = path.resolve(__dirname, "..", "..", "..", "data", "workspace");
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }
    const bootstrapFiles = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"];
    for (const fileName of bootstrapFiles) {
      const fpath = path.join(workspaceDir, fileName);
      if (!fs.existsSync(fpath)) {
        fs.writeFileSync(fpath, `# ${fileName.replace(".md", "")}\n\nSee ${workspaceDir}/${fileName} for documentation.\n`, "utf-8");
      }
    }
    this.agentModelExecutor.setWorkspacePath(workspaceDir);
    console.log(`[EvoClaw] Workspace initialized at ${workspaceDir}`);

    const fsBase = path.resolve(__dirname, "..", "..", "..");
    this.fileSystemManager.setBasePath(fsBase);
    this.registerFileTools();
    this.registerAutoSkillTool();
    this.registerTaskPlannerTool();
    this.registerPermissionTools();
    this.registerBrowserTools();

    await this.emailClient.initialize();
    await this.scheduleManager.initialize();
    await this.reportGenerator.initialize();
    this.registerSchedulerTools();
    this.registerReportingTools();
    this.registerIntelligenceTools();

    this.scheduleManager.start();

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
    this.scheduleManager.stop();
    await this.eventBus.publish(SystemEvents.SYSTEM_SHUTTING_DOWN, null, "server");
    await this.processManager.killAll();
    await this.gateway.stop();
    await this.registry.stopAll();
    console.log("[EvoClaw] Goodbye!");
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
          return { success: false, requiresPermission: true, requestId: permRequest.id, operation: "file_create", description: permRequest.description, target: filePath, error: `Awaiting user approval to create: ${filePath}` };
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
        const permRequest = permMgr.requestPermission("file_delete", filePath, {}, "tool");
        if (permRequest.status === "denied") {
          return { success: false, error: `Permission denied for file_delete on ${filePath}. Request ID: ${permRequest.id}` };
        }
        if (permRequest.status === "pending") {
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