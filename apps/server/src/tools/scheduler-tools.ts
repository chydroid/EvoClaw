import type { AgentModelExecutor } from "@evoclaw/agent";
import type { EventBus } from "@evoclaw/core";
import type { EmailClient } from "@evoclaw/email";
import type { ParsedEmail } from "@evoclaw/email";
import type { ScheduleManager } from "@evoclaw/scheduler";
import type { ScheduledTask } from "@evoclaw/scheduler";
import type { PlaywrightBrowser } from "@evoclaw/infrastructure";
import type { ReportGenerator } from "@evoclaw/reporting";
import type { ReportData } from "@evoclaw/reporting";

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

  executor.registerTool(
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
      const result = await sched.executeTask(taskId);
      return result;
    }
  );

  executor.registerTool(
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
