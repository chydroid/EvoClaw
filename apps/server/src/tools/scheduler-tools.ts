import type { AgentModelExecutor } from "@evoclaw/agent";
import type { EventBus } from "@evoclaw/core";
import type { EmailClient } from "@evoclaw/email";
import type { ParsedEmail } from "@evoclaw/email";
import type { ScheduleManager } from "@evoclaw/scheduler";
import type { ScheduledTask } from "@evoclaw/scheduler";
import type { PlaywrightBrowser } from "@evoclaw/infrastructure";
import type { ReportGenerator } from "@evoclaw/reporting";
import type { ReportData } from "@evoclaw/reporting";
import path from "path";

export function registerSchedulerTools(
  executor: AgentModelExecutor,
  scheduleManager: ScheduleManager,
  emailClient: EmailClient,
  eventBus: EventBus,
  reportGenerator: ReportGenerator,
  playwrightBrowser: PlaywrightBrowser
): void {
  const sched = scheduleManager;

  sched.registerHandler("email_check", async (task: ScheduledTask) => {
    const config = task.handlerConfig as { accountId?: string; rawEmails?: string[] };
    if (config.rawEmails && Array.isArray(config.rawEmails)) {
      const parsed: ParsedEmail[] = [];
      for (const raw of config.rawEmails) {
        try {
          parsed.push(await emailClient.parseRawEmail(raw));
        } catch (parseErr) {
          console.warn(`[Email] Failed to parse email: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        }
      }
      const analysis = emailClient.analyzeEmails(parsed);
      eventBus.publish("scheduler.email_checked", { taskId: task.id, analysis }, "scheduler");
    }
  });

  sched.registerHandler("report_generate", async (task: ScheduledTask) => {
    const config = task.handlerConfig as { templateName?: string; reportData?: ReportData; outputPath?: string };
    if (config.reportData) {
      reportGenerator.generateReport(config.reportData, {
        templateName: config.templateName || "default-report",
        outputPath: config.outputPath,
      });
    }
  });

  sched.registerHandler("system_cleanup", async (task: ScheduledTask) => {
    eventBus.publish("scheduler.cleanup_run", { taskId: task.id }, "scheduler");
  });

  sched.registerHandler("browser_action", async (task: ScheduledTask) => {
    const config = task.handlerConfig as { action?: string; url?: string };
    if (config.action === "screenshot" && config.url) {
      await playwrightBrowser.navigate(config.url);
      const buf = await playwrightBrowser.screenshot({ fullPage: true, type: "png" });
      eventBus.publish("scheduler.browser_screenshot", {
        taskId: task.id, url: config.url, size: buf.length,
      }, "scheduler");
    }
  });

  sched.registerHandler("custom", async (task: ScheduledTask) => {
    eventBus.publish("scheduler.custom_task", {
      taskId: task.id, name: task.name, config: task.handlerConfig,
    }, "scheduler");
  });

  // shell handler：执行 shell 命令（带超时和危险命令拦截）
  // 安全：复用 shell_exec 的危险命令黑名单，防止定时任务执行 rm -rf / 等破坏性命令
  const SCHED_DANGEROUS_PATTERNS = [
    /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\s+([.\/\*~]|\$HOME|--no-preserve-root)/i,
    /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-r\s+-f|-f\s+-r)\s+\/(\s|$)/i,
    /rm\s+-r\s+\//i, /rm\s+-rf\s+\//i, /rm\s+-rf\s+\~/i, /rm\s+-rf\s+\./i, /rm\s+-rf\s+\*/i,
    /del\s+\/S\s+\/Q\s+C:\\/i, /rmdir\s+\/[sS]\s+\/[qQ]/i,
    /Remove-Item\s+[^|;]*(-Recurse|-Force)[^|;]*(-Recurse|-Force)/i,
    /\bpowershell\b.*\b(Stop-Process|Stop-Service|Set-ExecutionPolicy|Invoke-Expression|iex|Start-Process|Remove-Item)\b/i,
    /\b(Stop-Process|Stop-Service|Set-ExecutionPolicy|Invoke-Expression|iex)\b/i,
    /shutdown/, /reboot/, /format\s+[a-z]:/i, /dd\s+if=/, /mkfs/, /fdisk/,
    /:\(\)\s*\{/, /fork\s*bomb/, />\s*\/dev\/sda/, />\s*\/dev\/nvme/,
    /chmod\s+777\s+\//, /chown\s+-R\s+\//,
    /\b(curl|wget)\b[^|&;]*\|\s*(sh|bash|python)/i,
    /\b(curl|wget)\b[^|&;]*&&\s*(sh|bash|python)/i,
    /\b(curl|wget)\b[^|&;]*>\s*\/[^\s|&;]+\s*&&\s*(sh|bash|python)/i,
    /`[^`]*`/, /\r|\n/,
  ];

  sched.registerHandler("shell", async (task: ScheduledTask) => {
    const config = task.handlerConfig as { command?: string; cwd?: string; timeout?: number };
    if (!config.command) {
      eventBus.publish("scheduler.shell_error", { taskId: task.id, error: "No command specified" }, "scheduler");
      return;
    }
    // 安全：危险命令过滤，防止定时任务执行破坏性命令
    for (const pattern of SCHED_DANGEROUS_PATTERNS) {
      if (pattern.test(config.command)) {
        eventBus.publish("scheduler.shell_error", {
          taskId: task.id, error: "Command blocked by safety filter: matched dangerous pattern",
        }, "scheduler");
        return;
      }
    }
    const { execFile } = await import("child_process");
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/c", config.command] : ["-c", config.command];
    // 安全：cwd 默认为 data/workspace 而非项目根目录，防止破坏项目文件
    const cwd = config.cwd || path.resolve(process.cwd(), "data", "workspace");
    const timeout = Math.min(config.timeout || 60000, 300000); // 最长 5 分钟
    try {
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(shell, shellArgs, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
      });
      eventBus.publish("scheduler.shell_completed", {
        taskId: task.id, stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 1024),
      }, "scheduler");
    } catch (err) {
      eventBus.publish("scheduler.shell_error", {
        taskId: task.id, error: err instanceof Error ? err.message : String(err),
      }, "scheduler");
    }
  });

  executor.registerTool(
    "scheduler_create",
    {
      name: "scheduler_create",
      description: "Create a scheduled task with cron expression",
      parameters: {
        name: { type: "string", description: "Task name" },
        cronExpression: { type: "string", description: "Cron expression (e.g. '0 9 * * *')" },
        description: { type: "string", description: "Task description" },
        handlerType: { type: "string", description: "Handler type: email_check, report_generate, browser_action, system_cleanup, custom, shell. For shell handler, handlerConfig should be {\"command\":\"pnpm test\",\"cwd\":\"/path\",\"timeout\":60000}" },
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

  executor.registerTool(
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

  executor.registerTool(
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
        if (!updated) {
          return { success: false, error: `Task not found: ${taskId}` };
        }
        return { success: true, task: updated };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  executor.registerTool(
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

  executor.registerTool(
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
      try {
        const result = await sched.executeTask(taskId);
        return result;
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  executor.registerTool(
    "scheduler_history",
    {
      name: "scheduler_history",
      description: "Get execution history for tasks",
      parameters: {
        taskId: { type: "string", description: "Task ID (optional, omit for all)" },
        limit: { type: "number", description: "Max results (default 20)" },
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
