import { ServiceRegistry, EventBus, SystemEvents } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

export interface SubTask {
  id: string;
  description: string;
  tool?: string;
  parameters?: Record<string, unknown>;
  dependencies: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: unknown;
  error?: string;
  retryCount: number;
  maxRetries: number;
}

export interface TaskPlan {
  id: string;
  task: string;
  subtasks: SubTask[];
  createdAt: Date;
  status: "planned" | "executing" | "completed" | "failed";
  progress: number;
}

export interface ProjectTemplate {
  name: string;
  description: string;
  keywords: string[];
  files: Array<{ path: string; description: string; tool: string; template?: string }>;
  structure: string[];
}

const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    name: "static_website",
    description: "Static HTML/CSS/JS website",
    keywords: ["website", "网页", "网站", "html", "css", "static", "静态"],
    files: [
      { path: "index.html", description: "Main HTML page with structure", tool: "file_create" },
      { path: "style.css", description: "Stylesheet with responsive design", tool: "file_create" },
      { path: "script.js", description: "JavaScript for interactivity", tool: "file_create" },
    ],
    structure: ["index.html", "style.css", "script.js"],
  },
  {
    name: "react_app",
    description: "React single-page application",
    keywords: ["react", "spa", "component", "组件", "jsx", "tsx", "frontend", "前端"],
    files: [
      { path: "src/index.html", description: "Entry HTML", tool: "file_create" },
      { path: "src/index.tsx", description: "React entry point with root render", tool: "file_create" },
      { path: "src/App.tsx", description: "Main App component", tool: "file_create" },
      { path: "src/components/Header.tsx", description: "Header component", tool: "file_create" },
      { path: "src/components/Footer.tsx", description: "Footer component", tool: "file_create" },
      { path: "src/styles/global.css", description: "Global styles", tool: "file_create" },
      { path: "src/types/index.ts", description: "TypeScript type definitions", tool: "file_create" },
    ],
    structure: ["src/index.html", "src/index.tsx", "src/App.tsx", "src/components/", "src/styles/", "src/types/"],
  },
  {
    name: "api_server",
    description: "REST API server",
    keywords: ["api", "server", "服务", "接口", "rest", "endpoint", "后端", "backend"],
    files: [
      { path: "src/index.ts", description: "Server entry point with Express/Fastify setup", tool: "file_create" },
      { path: "src/routes/index.ts", description: "Route aggregation", tool: "file_create" },
      { path: "src/routes/users.ts", description: "User-related endpoints", tool: "file_create" },
      { path: "src/middleware/auth.ts", description: "Authentication middleware", tool: "file_create" },
      { path: "src/middleware/error.ts", description: "Error handling middleware", tool: "file_create" },
      { path: "src/models/index.ts", description: "Data models", tool: "file_create" },
      { path: "src/config.ts", description: "Configuration module", tool: "file_create" },
    ],
    structure: ["src/index.ts", "src/routes/", "src/middleware/", "src/models/", "src/config.ts"],
  },
  {
    name: "cli_tool",
    description: "Command-line tool",
    keywords: ["cli", "command", "命令行", "工具", "tool", "script", "脚本"],
    files: [
      { path: "src/index.ts", description: "CLI entry point with argument parsing", tool: "file_create" },
      { path: "src/commands/index.ts", description: "Command registry", tool: "file_create" },
      { path: "src/utils.ts", description: "Utility functions", tool: "file_create" },
    ],
    structure: ["src/index.ts", "src/commands/", "src/utils.ts"],
  },
  {
    name: "fullstack_app",
    description: "Full-stack application with frontend and backend",
    keywords: ["fullstack", "全栈", "前后端", "monorepo", "complete", "完整", "全套"],
    files: [
      { path: "backend/src/index.ts", description: "Backend server entry", tool: "file_create" },
      { path: "backend/src/routes/index.ts", description: "API routes", tool: "file_create" },
      { path: "backend/src/models/index.ts", description: "Data models", tool: "file_create" },
      { path: "frontend/src/index.html", description: "Frontend entry HTML", tool: "file_create" },
      { path: "frontend/src/App.tsx", description: "React App component", tool: "file_create" },
      { path: "frontend/src/components/Header.tsx", description: "Header component", tool: "file_create" },
      { path: "shared/types.ts", description: "Shared TypeScript types", tool: "file_create" },
    ],
    structure: ["backend/src/", "frontend/src/", "shared/"],
  },
  {
    name: "data_pipeline",
    description: "Data processing/analysis pipeline",
    keywords: ["data", "数据", "pipeline", "etl", "分析", "analysis", "处理", "清洗"],
    files: [
      { path: "src/index.ts", description: "Pipeline orchestrator entry", tool: "file_create" },
      { path: "src/extract.ts", description: "Data extraction module", tool: "file_create" },
      { path: "src/transform.ts", description: "Data transformation module", tool: "file_create" },
      { path: "src/load.ts", description: "Data loading/output module", tool: "file_create" },
      { path: "src/analyze.ts", description: "Data analysis module", tool: "file_create" },
      { path: "src/report.ts", description: "Reporting module", tool: "file_create" },
    ],
    structure: ["src/index.ts", "src/extract.ts", "src/transform.ts", "src/load.ts", "src/analyze.ts", "src/report.ts"],
  },
];

export class TaskPlanner {
  private plans = new Map<string, TaskPlan>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  decompose(task: string): TaskPlan {
    const plan: TaskPlan = {
      id: uuid(),
      task,
      subtasks: [],
      createdAt: new Date(),
      status: "planned",
      progress: 0,
    };

    const template = this.matchProjectTemplate(task);
    if (template) {
      plan.subtasks = this.buildFromTemplate(template, task);
    } else {
      plan.subtasks = this.analyzeTask(task);
    }

    this.plans.set(plan.id, plan);

    this.eventBus.publish(SystemEvents.TASK_CREATED, {
      planId: plan.id,
      subtaskCount: plan.subtasks.length,
      template: template?.name || "custom",
    }, "task-planner");

    return plan;
  }

  decomposeWithTemplate(task: string, templateName: string): TaskPlan {
    const plan: TaskPlan = {
      id: uuid(),
      task,
      subtasks: [],
      createdAt: new Date(),
      status: "planned",
      progress: 0,
    };

    const template = PROJECT_TEMPLATES.find((t) => t.name === templateName);
    if (template) {
      plan.subtasks = this.buildFromTemplate(template, task);
    } else {
      plan.subtasks = this.analyzeTask(task);
    }

    this.plans.set(plan.id, plan);
    return plan;
  }

  getAvailableTemplates(): Array<{ name: string; description: string; keywords: string[] }> {
    return PROJECT_TEMPLATES.map((t) => ({
      name: t.name,
      description: t.description,
      keywords: t.keywords,
    }));
  }

  getTemplateStructure(templateName: string): string[] | null {
    const template = PROJECT_TEMPLATES.find((t) => t.name === templateName);
    return template ? [...template.structure] : null;
  }

  private matchProjectTemplate(task: string): ProjectTemplate | null {
    const lower = task.toLowerCase();
    let bestMatch: { template: ProjectTemplate; score: number } | null = null;

    for (const template of PROJECT_TEMPLATES) {
      let score = 0;
      for (const kw of template.keywords) {
        if (lower.includes(kw)) score++;
      }

      const projectIndicators = ["创建", "新建", "搭建", "构建", "create", "new", "build", "scaffold", "generate", "生成"];
      for (const indicator of projectIndicators) {
        if (lower.includes(indicator)) score += 0.5;
      }

      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { template, score };
      }
    }

    if (bestMatch && bestMatch.score >= 1) return bestMatch.template;
    return null;
  }

  private buildFromTemplate(template: ProjectTemplate, task: string): SubTask[] {
    const subtasks: SubTask[] = [];
    const folderSet = new Set<string>();

    for (const file of template.files) {
      const dir = file.path.substring(0, file.path.lastIndexOf("/"));
      if (dir && !folderSet.has(dir)) {
        folderSet.add(dir);
        subtasks.push(this.makeSubTask(
          `Create directory: ${dir}`,
          "file_create",
          { path: `${dir}/.gitkeep`, content: "" },
          subtasks.length > 0 ? [subtasks[subtasks.length - 1].id] : []
        ));
      }
    }

    for (const file of template.files) {
      const dir = file.path.substring(0, file.path.lastIndexOf("/"));
      const folderTaskId = dir ? subtasks.find((s) => s.parameters && (s.parameters as Record<string, unknown>).path === `${dir}/.gitkeep`)?.id : undefined;

      subtasks.push(this.makeSubTask(
        file.description,
        file.tool,
        { path: file.path, content: "" },
        folderTaskId ? [folderTaskId] : []
      ));
    }

    return subtasks;
  }

  private analyzeTask(task: string): SubTask[] {
    const lower = task.toLowerCase();
    const subtasks: SubTask[] = [];

    if (lower.includes("file") || lower.includes("文件") || lower.includes("create") || lower.includes("创建") || lower.includes("write") || lower.includes("写入") || lower.includes("生成")) {
      subtasks.push(this.makeSubTask(
        "Validate file path and prepare content",
        "file_create",
        { path: "", content: "" },
        []
      ));
    }

    if (lower.includes("folder") || lower.includes("文件夹") || lower.includes("directory") || lower.includes("目录") || lower.includes("mkdir")) {
      subtasks.push(this.makeSubTask(
        "Ensure target directory exists",
        "file_create",
        { path: ".placeholder", content: "" },
        []
      ));
    }

    if (lower.includes("html") || lower.includes("网页") || lower.includes("web")) {
      subtasks.push(this.makeSubTask(
        "Generate HTML content structure",
        "file_create",
        { path: "", content: "" },
        subtasks.length > 0 ? [subtasks[subtasks.length - 1].id] : []
      ));
    }

    if (lower.includes("css") || lower.includes("样式") || lower.includes("style")) {
      subtasks.push(this.makeSubTask(
        "Create stylesheet file",
        "file_create",
        { path: "", content: "" },
        []
      ));
    }

    if (lower.includes("js") || lower.includes("javascript") || lower.includes("脚本") || lower.includes("script")) {
      subtasks.push(this.makeSubTask(
        "Create JavaScript file",
        "file_create",
        { path: "", content: "" },
        []
      ));
    }

    if (lower.includes("skill") || lower.includes("技能") || lower.includes("find") || lower.includes("查找") || lower.includes("install") || lower.includes("安装")) {
      subtasks.push(this.makeSubTask(
        "Search for matching skills",
        "skill_search",
        { task },
        []
      ));
      subtasks.push(this.makeSubTask(
        "Install the best matching skill",
        "skill_find_and_install",
        { task },
        subtasks.length > 0 ? [subtasks[0].id] : []
      ));
    }

    if (lower.includes("read") || lower.includes("读取") || lower.includes("查看") || lower.includes("view")) {
      subtasks.push(this.makeSubTask(
        "Read target file content",
        "file_read",
        { path: "" },
        []
      ));
    }

    if (lower.includes("list") || lower.includes("列出") || lower.includes("ls") || lower.includes("dir")) {
      subtasks.push(this.makeSubTask(
        "List directory contents",
        "file_list",
        { path: "." },
        []
      ));
    }

    if (lower.includes("report") || lower.includes("报告") || lower.includes("报表") || lower.includes("周报") || lower.includes("日报") || lower.includes("摘要")) {
      subtasks.push(this.makeSubTask(
        "Generate report with appropriate template",
        "report_generate",
        { title: "", sections: "[]" },
        []
      ));
    }

    if (lower.includes("email") || lower.includes("邮件") || lower.includes("发送") || lower.includes("发邮件")) {
      subtasks.push(this.makeSubTask(
        "Compose and send email",
        "email_send",
        { accountId: "", to: "", subject: "", body: "" },
        []
      ));
    }

    if (lower.includes("browser") || lower.includes("浏览器") || lower.includes("网页") || lower.includes("截图") || lower.includes("登录")) {
      subtasks.push(this.makeSubTask(
        "Launch browser and navigate",
        "browser_launch",
        {},
        []
      ));
      subtasks.push(this.makeSubTask(
        "Navigate to target URL",
        "browser_navigate",
        { url: "" },
        [subtasks[subtasks.length - 1].id]
      ));
    }

    if (lower.includes("定时") || lower.includes("计划") || lower.includes("schedule") || lower.includes("cron") || lower.includes("定期")) {
      subtasks.push(this.makeSubTask(
        "Create scheduled task",
        "scheduler_create",
        { name: "", cronExpression: "", handlerType: "custom", handlerConfig: "{}" },
        []
      ));
    }

    if (subtasks.length === 0) {
      subtasks.push(this.makeSubTask(
        "Execute general task",
        undefined,
        {},
        []
      ));
    }

    return subtasks;
  }

  private makeSubTask(
    description: string,
    tool: string | undefined,
    parameters: Record<string, unknown>,
    dependencies: string[]
  ): SubTask {
    return {
      id: uuid().slice(0, 8),
      description,
      tool,
      parameters,
      dependencies,
      status: "pending",
      retryCount: 0,
      maxRetries: 3,
    };
  }

  getPlan(planId: string): TaskPlan | undefined {
    return this.plans.get(planId);
  }

  getPendingSubtasks(planId: string): SubTask[] {
    const plan = this.plans.get(planId);
    if (!plan) return [];
    return plan.subtasks.filter((s) => s.status === "pending");
  }

  getNextExecutableSubtask(planId: string): SubTask | undefined {
    const plan = this.plans.get(planId);
    if (!plan) return undefined;

    const completed = new Set(
      plan.subtasks
        .filter((s) => s.status === "completed")
        .map((s) => s.id)
    );

    return plan.subtasks.find(
      (s) =>
        s.status === "pending" &&
        s.dependencies.every((depId) => completed.has(depId))
    );
  }

  updateSubtaskStatus(
    planId: string,
    subtaskId: string,
    status: SubTask["status"],
    result?: unknown,
    error?: string
  ): void {
    const plan = this.plans.get(planId);
    if (!plan) return;

    const subtask = plan.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) return;

    subtask.status = status;
    if (result !== undefined) subtask.result = result;
    if (error !== undefined) subtask.error = error;

    const completed = plan.subtasks.filter(
      (s) => s.status === "completed" || s.status === "skipped"
    ).length;
    const failed = plan.subtasks.filter((s) => s.status === "failed").length;

    plan.progress =
      plan.subtasks.length > 0
        ? Math.round((completed / plan.subtasks.length) * 100)
        : 0;

    if (completed + failed === plan.subtasks.length) {
      plan.status = failed > 0 ? "failed" : "completed";
    }

    this.eventBus.publish(
      "task.subtask.updated",
      { planId, subtaskId, status, progress: plan.progress },
      "task-planner"
    );
  }

  incrementRetry(planId: string, subtaskId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan) return false;

    const subtask = plan.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) return false;

    if (subtask.retryCount >= subtask.maxRetries) return false;

    subtask.retryCount++;
    subtask.status = "pending";
    subtask.error = undefined;
    return true;
  }

  listPlans(): TaskPlan[] {
    return Array.from(this.plans.values());
  }

  async healthCheck(): Promise<boolean> {
    return this.plans.size >= 0;
  }
}