import type { AgentModelExecutor } from "@evoclaw/agent";
import type { EventBus, ServiceRegistry } from "@evoclaw/core";
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
  playwrightBrowser: PlaywrightBrowser,
  registry: ServiceRegistry
): void {
  const sched = scheduleManager;

  // 防止 eventBus.publish 的 Promise rejection 成为 unhandled rejection
  const publish = (eventType: string, data: unknown): void => {
    eventBus.publish(eventType, data, "scheduler").catch((err) => {
      process.stderr.write(`[scheduler-tools] publish ${eventType} failed: ${err}\n`);
    });
  };

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
      publish("scheduler.email_checked", { taskId: task.id, analysis });
    }
  });

  sched.registerHandler("report_generate", async (task: ScheduledTask) => {
    const config = task.handlerConfig as { templateName?: string; reportData?: ReportData; outputPath?: string };
    if (config.reportData) {
      try {
        const result = reportGenerator.generateReport(config.reportData, {
          templateName: config.templateName || "default-report",
          outputPath: config.outputPath,
        });
        publish("scheduler.report_generated", { taskId: task.id, outputPath: config.outputPath, length: result.length });
      } catch (err) {
        publish("scheduler.report_error", { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  sched.registerHandler("system_cleanup", async (task: ScheduledTask) => {
    publish("scheduler.cleanup_run", { taskId: task.id });
  });

  // SSRF 校验：安全服务未注册时 fail-closed（拒绝请求），防止内网地址绕过
  async function validateUrlSsrf(url: string): Promise<{ ok: boolean; error?: string }> {
    const ssrfProtection = registry.resolveService<import("@evoclaw/security").SSRFProtection>("ssrfProtection");
    if (!ssrfProtection) {
      return { ok: false, error: "SSRF protection service unavailable" };
    }
    const result = await ssrfProtection.checkURL(url);
    if (!result.allowed) {
      return { ok: false, error: `URL blocked by security policy: ${result.reason}` };
    }
    return { ok: true };
  }

  sched.registerHandler("browser_action", async (task: ScheduledTask) => {
    const config = task.handlerConfig as { action?: string; url?: string };
    if (config.action === "screenshot" && config.url) {
      const ssrfCheck = await validateUrlSsrf(config.url);
      if (!ssrfCheck.ok) {
        publish("scheduler.browser_error", { taskId: task.id, error: ssrfCheck.error, url: config.url });
        return;
      }
      await playwrightBrowser.navigate(config.url);
      const buf = await playwrightBrowser.screenshot({ fullPage: true, type: "png" });
      publish("scheduler.browser_screenshot", {
        taskId: task.id, url: config.url, size: buf.length,
      });
    }
  });

  sched.registerHandler("custom", async (task: ScheduledTask) => {
    publish("scheduler.custom_task", {
      taskId: task.id, name: task.name, config: task.handlerConfig,
    });
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
      publish("scheduler.shell_error", { taskId: task.id, error: "No command specified" });
      return;
    }
    // 安全：危险命令过滤，防止定时任务执行破坏性命令
    for (const pattern of SCHED_DANGEROUS_PATTERNS) {
      if (pattern.test(config.command)) {
        publish("scheduler.shell_error", {
          taskId: task.id, error: "Command blocked by safety filter: matched dangerous pattern",
        });
        return;
      }
    }
    const { execFile } = await import("child_process");
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/c", config.command] : ["-c", config.command];
    // 安全：cwd 默认为 data/workspace 而非项目根目录，且必须校验 cwd 在 workspace 内，防止路径逃逸
    const workspaceDir = path.resolve(process.cwd(), "data", "workspace");
    const cwd = config.cwd ? path.resolve(config.cwd) : workspaceDir;
    // 校验 cwd 必须在 workspace 内
    if (cwd !== workspaceDir && !cwd.startsWith(workspaceDir + path.sep)) {
      publish("scheduler.shell_error", { taskId: task.id, error: "cwd must be within workspace" });
      return;
    }
    const timeout = Math.min(Math.max(config.timeout || 60000, 1000), 300000); // 1s~5min
    try {
      const { stdout, stderr, timedOut } = await new Promise<{ stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
        execFile(shell, shellArgs, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          // 超时时 Node 仍会回传已收集的 stdout/stderr，不丢弃
          const isTimeout = !!(err && (err as NodeJS.ErrnoException & { timedOut?: boolean }).timedOut);
          if (err && !isTimeout) {
            resolve({ stdout: String(stdout), stderr: String(stderr || err.message), timedOut: false });
          } else {
            resolve({ stdout: String(stdout), stderr: String(stderr), timedOut: isTimeout });
          }
        });
      });
      publish(timedOut ? "scheduler.shell_timeout" : "scheduler.shell_completed", {
        taskId: task.id, stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 1024), timedOut,
      });
    } catch (err) {
      publish("scheduler.shell_error", {
        taskId: task.id, error: err instanceof Error ? err.message : String(err),
      });
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
      // 安全：shell 类型任务需审批告警并阻止明显危险命令（registerSchedulerTools 无 permissionManager，故仅告警+黑名单拦截）
      if (handlerType === "shell") {
        const command = typeof handlerConfig.command === "string" ? handlerConfig.command : "";
        if (command && SCHED_DANGEROUS_PATTERNS.some((p) => p.test(command))) {
          return { success: false, error: "Command blocked by safety filter: matched dangerous pattern" };
        }
        process.stderr.write(`[scheduler_create] WARNING: creating shell scheduled task "${name}" — ensure command is trusted\n`);
        publish("scheduler.shell_task_created", { name, command });
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
        // 安全：shell 任务更新 handlerConfig 时重新检查危险命令（与 scheduler_create 一致）
        const existingTask = sched.getTask(taskId);
        if (existingTask?.handlerType === "shell") {
          const newConfig = updates.handlerConfig as Record<string, unknown>;
          const command = typeof newConfig.command === "string" ? newConfig.command : "";
          if (command && SCHED_DANGEROUS_PATTERNS.some((p) => p.test(command))) {
            return { success: false, error: "Command blocked by safety filter: matched dangerous pattern" };
          }
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
      const limit = Math.max(1, Math.min(parseInt(String(params.limit || "20"), 10) || 20, 100));
      const history = sched.getRunHistory(taskId || undefined, limit);
      return { success: true, history, count: history.length };
    }
  );
}
