import type { AgentModelExecutor, DLQEntry, DLQRetryHandler } from "@evoclaw/agent";
import { DLQBatchRetry as DLQClass } from "@evoclaw/agent";
import type { EventBus, ServiceRegistry } from "@evoclaw/core";
import type { EmailClient } from "@evoclaw/email";
import type { ParsedEmail } from "@evoclaw/email";
import type { ScheduleManager } from "@evoclaw/scheduler";
import type { ScheduledTask } from "@evoclaw/scheduler";
import type { PlaywrightBrowser } from "@evoclaw/infrastructure";
import type { ReportGenerator } from "@evoclaw/reporting";
import type { ReportData } from "@evoclaw/reporting";
import path from "path";

/**
 * Scheduler 复合工具 — 原 scheduler_create/list/update/delete/execute/history 六个工具
 * 与 dlq_retry_batch（从 vision-batch-tools.ts 搬来）合并为一个 scheduler 工具，
 * 通过 action 参数选择具体操作。
 */
export function registerSchedulerTools(
  executor: AgentModelExecutor,
  scheduleManager: ScheduleManager,
  emailClient: EmailClient,
  eventBus: EventBus,
  reportGenerator: ReportGenerator,
  playwrightBrowser: PlaywrightBrowser,
  registry: ServiceRegistry,
  /** dlq_retry_batch（现 retry_dlq action）调用的重试处理器（可选；未提供时工具返回错误） */
  dlqHandler?: DLQRetryHandler
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
    // 安全：cwd 默认为 data/workspace 而非项目根目录，且必须校验 cwd 在 workspace 内，防止路径逃逸
    // 与 shell_exec（shell-media-tools）对齐：按 __dirname 定位项目根（4 层 = dist/tools → 根），
    // 而非 process.cwd()——从仓库外启动/不同 cwd 运行时两者会指向不同目录（split brain），
    // 定时任务与交互 shell 找不到同一份 workspace 文件。
    const workspaceDir = path.resolve(__dirname, "..", "..", "..", "..", "data", "workspace");
    const cwd = config.cwd ? path.resolve(config.cwd) : workspaceDir;
    // 校验 cwd 必须在 workspace 内
    if (cwd !== workspaceDir && !cwd.startsWith(workspaceDir + path.sep)) {
      publish("scheduler.shell_error", { taskId: task.id, error: "cwd must be within workspace" });
      return;
    }
    const timeout = Math.min(Math.max(config.timeout ?? 60000, 1000), 300000); // 1s~5min
    // SCHED-WSDUP 修复（2026-10-17 eval10-t06）：shell handler 的 cwd 是
    // data/workspace 本身，但任务命令常写成 "date +%s > data/workspace/x"
    // （相对项目根的输出风格）→ 重定向落到嵌套的 data/workspace/data/
    // workspace/… 目录树，scheduler_execute 报 success=true 但文件不在
    // 期望位置，与 shell_exec 的 WS-DUP 前缀剥除对齐：cwd 即 workspace 时
    // 先剥掉 "data/workspace/" 前缀。
    let command = config.command;
    if (cwd === workspaceDir) {
      const stripped = command.replace(/(?<![:\w/.])data[\\/]workspace[\\/](?=\S)/g, "");
      if (stripped !== command) {
        process.stdout.write(`[scheduler] Stripped workspace-relative prefix in task "${task.name}": ${command}\n`);
        command = stripped;
      }
    }
    try {
      const { stdout, stderr, timedOut } = await new Promise<{ stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
        execFile(shell, [process.platform === "win32" ? "/c" : "-c", command], { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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

  // ── scheduler 复合工具 ─────────────────────────────────────
  // 以下 7 个 handler 为原工具 handler 原样抽出，逻辑逐字保留

  /** 原 scheduler_create */
  const handleSchedulerCreate = async (params: Record<string, unknown>) => {
    const name = String(params.name || "");
    const cronExpression = String(params.cronExpression || "");
    const description = String(params.description || "");
    const handlerType = (String(params.handlerType || "custom")) as ScheduledTask["handlerType"];
    let handlerConfig: Record<string, unknown> = {};
    try {
      handlerConfig = JSON.parse(String(params.handlerConfig || "{}"));
    } catch {
      return { success: false, error: "Invalid handlerConfig JSON" };
    }
    if (!name || !cronExpression) {
      return { success: false, error: "name and cronExpression are required" };
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
  };

  /** 原 scheduler_list */
  const handleSchedulerList = async () => {
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
  };

  /** 原 scheduler_update */
  const handleSchedulerUpdate = async (params: Record<string, unknown>) => {
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
        return { success: false, error: "Invalid handlerConfig JSON" };
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
  };

  /** 原 scheduler_delete */
  const handleSchedulerDelete = async (params: Record<string, unknown>) => {
    const taskId = String(params.taskId || "").trim();
    if (!taskId) return { success: false, error: "taskId is required" };
    const removed = sched.deleteTask(taskId);
    // 明确区分"任务不存在"与"删除成功"，避免模型把 false 当成成功或误判
    return removed
      ? { success: true, taskId }
      : { success: false, taskId, error: `Task not found: ${taskId}` };
  };

  /** 原 scheduler_execute */
  const handleSchedulerExecute = async (params: Record<string, unknown>) => {
    const taskId = String(params.taskId || "");
    try {
      const result = await sched.executeTask(taskId);
      return result;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** 原 scheduler_history */
  const handleSchedulerHistory = async (params: Record<string, unknown>) => {
    const taskId = String(params.taskId || "");
    const limit = Math.max(1, Math.min(parseInt(String(params.limit ?? "20"), 10) || 20, 100));
    const history = sched.getRunHistory(taskId || undefined, limit);
    return { success: true, history, count: history.length };
  };

  /** 原 dlq_retry_batch（从 vision-batch-tools.ts 搬来；仅 deps.dlqHandler → dlqHandler 适配） */
  const handleSchedulerRetryDlq = async (params: Record<string, unknown>) => {
    try {
      if (!dlqHandler) {
        return { success: false, error: "DLQ retry handler not configured on server" };
      }
      const entries = Array.isArray(params.entries) ? (params.entries as DLQEntry[]) : [];
      if (entries.length === 0) return { success: false, error: "entries array is required" };
      const dlqRetry = new DLQClass(dlqHandler, {
        maxConcurrency: (() => {
          if (!params.maxConcurrency) return undefined;
          const n = Number(params.maxConcurrency);
          return Number.isFinite(n) ? n : undefined;
        })(),
        maxRetries: (() => {
          if (!params.maxRetries) return undefined;
          const n = Number(params.maxRetries);
          return Number.isFinite(n) ? n : undefined;
        })(),
        failFast: params.failFast === true,
      });
      const result = await dlqRetry.retryAll(entries);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  executor.registerTool(
    "scheduler",
    {
      name: "scheduler",
      description:
        "复合定时任务工具（composite scheduler tool），通过 action 参数选择具体操作，默认 list。" +
        "actions: " +
        "create（创建定时任务，必填 name + cronExpression；handlerType: email_check, report_generate, browser_action, system_cleanup, custom, shell；For shell handler, handlerConfig should be {\"command\":\"pnpm test\",\"cwd\":\"/path\",\"timeout\":60000}；shell 任务会做危险命令黑名单拦截与告警）； " +
        "list（默认，列出所有定时任务及统计）； " +
        "update（更新任务：enabled 开关、cronExpression、handlerConfig；shell 任务更新时重新检查危险命令）； " +
        "delete（删除任务，区分任务不存在与删除成功）； " +
        "execute（立即执行指定任务）； " +
        "history（查看执行历史，可按 taskId 过滤，limit 默认 20）； " +
        "retry_dlq（死信队列批量重试：并发上限、指数退避、失败隔离，返回统计）。",
      parameters: {
        action: {
          type: "string",
          description: "要执行的定时任务操作。action to perform: create / list (default) / update / delete / execute / history / retry_dlq",
          enum: ["create", "list", "update", "delete", "execute", "history", "retry_dlq"],
          required: true,
        },
        name: { type: "string", description: "Task name（create 用）", required: false },
        cronExpression: { type: "string", description: "Cron expression (e.g. '0 9 * * *')（create / update 用）", required: false },
        description: { type: "string", description: "Task description（create 用）", required: false },
        handlerType: { type: "string", description: "Handler type: email_check, report_generate, browser_action, system_cleanup, custom, shell. For shell handler, handlerConfig should be {\"command\":\"pnpm test\",\"cwd\":\"/path\",\"timeout\":60000}（create 用）", required: false },
        handlerConfig: { type: "string", description: "JSON config for handler（create / update 用）", required: false },
        taskId: { type: "string", description: "Task ID（update / delete / execute / history 用）", required: false },
        enabled: { type: "string", description: "Enable (true) or disable (false)（update 用）", required: false },
        limit: { type: "number", description: "Max results (default 20)（history 用）", required: false },
        entries: { type: "array", description: "Array of DLQ entries to retry（retry_dlq 用）", required: false },
        maxConcurrency: { type: "number", description: "Max concurrent retries (default: 10)（retry_dlq 用）", required: false },
        maxRetries: { type: "number", description: "Max retries per entry (default: 3)（retry_dlq 用）", required: false },
        failFast: { type: "boolean", description: "Stop on first failure (default: false)（retry_dlq 用）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "list");
      if (action === "create") return await handleSchedulerCreate(params);
      if (action === "list") return await handleSchedulerList();
      if (action === "update") return await handleSchedulerUpdate(params);
      if (action === "delete") return await handleSchedulerDelete(params);
      if (action === "execute") return await handleSchedulerExecute(params);
      if (action === "history") return await handleSchedulerHistory(params);
      if (action === "retry_dlq") return await handleSchedulerRetryDlq(params);
      return { success: false, error: `未知 scheduler action: ${action}（仅支持 create / list / update / delete / execute / history / retry_dlq）` };
    }
  );
}
