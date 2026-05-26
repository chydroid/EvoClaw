/** cron — Scheduled task management (via Gateway API) */
import { Command } from "commander";
import { c } from "../utils/colors";
import { apiRequest } from "../utils/api";

interface CronTask {
  id: string;
  name: string;
  cronExpression: string;
  description: string;
  handlerType: string;
  enabled: boolean;
  runCount: number;
  errorCount: number;
  lastRun?: string;
  nextRun?: string;
}

interface CronResult {
  success?: boolean;
  tasks?: CronTask[];
  task?: CronTask;
  stats?: { totalTasks: number; activeTasks: number; totalRuns: number; totalErrors: number };
  error?: string;
}

function formatDate(d?: string): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const cron = program
    .command("cron")
    .description("Manage scheduled cron tasks (requires running Gateway server)");

  cron
    .command("status")
    .description("Show scheduler status")
    .action(async () => {
      try {
        const res = await apiRequest<CronResult>("GET", "/api/scheduler/tasks");
        if (res.status !== 200) {
          console.log(c("red", "Failed to fetch scheduler status"));
          return;
        }
        const { stats, tasks } = res.data;
        console.log(`\n${c("bold", "=== Cron Scheduler Status ===\n")}`);
        if (stats) {
          console.log(`  Tasks:         ${c("cyan", String(stats.totalTasks))} total, ${c("green", String(stats.activeTasks))} active`);
          console.log(`  Runs:          ${c("cyan", String(stats.totalRuns))} total, ${c("red", String(stats.totalErrors))} errors`);
        }
        if (tasks && tasks.length > 0) {
          console.log(`\n${c("bold", "Active Tasks:")}`);
          for (const t of tasks) {
            if (t.enabled) {
              console.log(`  ${c("green", "●")} ${c("bold", t.name)} — ${c("gray", t.cronExpression)}`);
              console.log(`    Next run: ${c("cyan", formatDate(t.nextRun))} | Runs: ${t.runCount} | Errors: ${t.errorCount}`);
            }
          }
        }
        console.log();
      } catch (err) {
        console.log(c("red", `❌ Server not reachable: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  cron
    .command("list")
    .description("List all scheduled tasks")
    .action(async () => {
      try {
        const res = await apiRequest<CronResult>("GET", "/api/scheduler/tasks");
        if (res.status !== 200) {
          console.log(c("red", "Failed to fetch tasks list"));
          return;
        }
        const tasks = res.data.tasks || [];
        if (tasks.length === 0) {
          console.log(`\n${c("gray", "No tasks scheduled. Use:")} ${c("cyan", "evoclaw cron add")}\n`);
          return;
        }
        console.log(`\n${c("bold", "=== Scheduled Tasks ===\n")}`);
        for (const t of tasks) {
          const status = t.enabled ? c("green", "● enabled") : c("gray", "○ disabled");
          console.log(`  ${c("bold", t.name)} ${status}`);
          console.log(`    ${c("gray", `ID: ${t.id}`)}`);
          console.log(`    Cron: ${c("cyan", t.cronExpression)} | Type: ${c("yellow", t.handlerType)}`);
          console.log(`    Runs: ${t.runCount} | Errors: ${c("red", String(t.errorCount))}`);
          console.log(`    Last: ${formatDate(t.lastRun)} | Next: ${formatDate(t.nextRun)}`);
          if (t.description) console.log(`    ${c("gray", t.description)}`);
          console.log();
        }
      } catch (err) {
        console.log(c("red", `❌ Server not reachable: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  cron
    .command("add")
    .description("Add a scheduled cron task")
    .requiredOption("--name <name>", "Task name")
    .requiredOption("--cron <expression>", "Cron expression (e.g. '0 9 * * *')")
    .option("--desc <description>", "Task description")
    .option("--type <handlerType>", "Handler type: system, custom, email_check, report_generate, browser_action", "custom")
    .option("--no-enable", "Create in disabled state")
    .action(async (opts) => {
      try {
        const body = {
          name: opts.name,
          cronExpression: opts.cron,
          description: opts.desc || "",
          handlerType: opts.type,
          enabled: opts.enable !== false,
        };
        const res = await apiRequest<CronResult>("POST", "/api/scheduler/tasks", body);
        if (res.status === 201 || res.status === 200) {
          const task = res.data.task;
          console.log(c("green", `✅ Task "${task?.name || opts.name}" created`));
          if (task) {
            console.log(`   ID:     ${c("gray", task.id)}`);
            console.log(`   Cron:   ${c("cyan", task.cronExpression)}`);
            console.log(`   Next:   ${c("cyan", formatDate(task.nextRun))}`);
            console.log(`   Status: ${task.enabled ? c("green", "enabled") : c("gray", "disabled")}`);
          }
        } else {
          console.log(c("red", `❌ Failed: ${res.data.error || `HTTP ${res.status}`}`));
        }
      } catch (err) {
        console.log(c("red", `❌ ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  cron
    .command("edit <taskId>")
    .description("Edit a scheduled task")
    .option("--name <name>", "New task name")
    .option("--cron <expression>", "New cron expression")
    .option("--desc <description>", "New description")
    .option("--enable", "Enable the task")
    .option("--disable", "Disable the task")
    .action(async (taskId: string, opts) => {
      try {
        const updates: Record<string, unknown> = {};
        if (opts.name) updates.name = opts.name;
        if (opts.cron) updates.cronExpression = opts.cron;
        if (opts.desc) updates.description = opts.desc;
        if (opts.enable) updates.enabled = true;
        if (opts.disable) updates.enabled = false;

        if (Object.keys(updates).length === 0) {
          console.log(c("yellow", "No updates specified. Use --name, --cron, --desc, --enable, or --disable"));
          return;
        }

        const res = await apiRequest<CronResult>("PUT", `/api/scheduler/tasks/${taskId}`, updates);
        if (res.status === 200) {
          console.log(c("green", `✅ Task "${taskId}" updated`));
          if (res.data.task) {
            console.log(`   Name:   ${c("bold", String(res.data.task.name))}`);
            console.log(`   Cron:   ${c("cyan", String(res.data.task.cronExpression))}`);
            console.log(`   Status: ${(res.data.task as CronTask).enabled ? c("green", "enabled") : c("gray", "disabled")}`);
          }
        } else {
          console.log(c("red", `❌ Failed: ${res.data.error || `HTTP ${res.status}`}`));
        }
      } catch (err) {
        console.log(c("red", `❌ ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  cron
    .command("rm <taskId>")
    .description("Remove a scheduled task")
    .action(async (taskId: string) => {
      try {
        const res = await apiRequest("DELETE", `/api/scheduler/tasks/${taskId}`);
        if (res.status === 200) {
          console.log(c("green", `✅ Task "${taskId}" removed`));
        } else {
          console.log(c("red", `❌ Failed: ${(res.data as CronResult).error || `HTTP ${res.status}`}`));
        }
      } catch (err) {
        console.log(c("red", `❌ ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  cron
    .command("enable <taskId>")
    .description("Enable a task")
    .action(async (taskId: string) => {
      try {
        const res = await apiRequest<CronResult>("PUT", `/api/scheduler/tasks/${taskId}`, { enabled: true });
        if (res.status === 200) {
          console.log(c("green", `✅ Task "${taskId}" enabled`));
        } else {
          console.log(c("red", `❌ Failed: ${res.data.error || `HTTP ${res.status}`}`));
        }
      } catch (err) {
        console.log(c("red", `❌ ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  cron
    .command("disable <taskId>")
    .description("Disable a task")
    .action(async (taskId: string) => {
      try {
        const res = await apiRequest<CronResult>("PUT", `/api/scheduler/tasks/${taskId}`, { enabled: false });
        if (res.status === 200) {
          console.log(c("green", `✅ Task "${taskId}" disabled`));
        } else {
          console.log(c("red", `❌ Failed: ${res.data.error || `HTTP ${res.status}`}`));
        }
      } catch (err) {
        console.log(c("red", `❌ ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  cron
    .command("run <taskId>")
    .description("Trigger a task immediately")
    .action(async (taskId: string) => {
      try {
        console.log(c("gray", `Triggering task "${taskId}"...`));
        const res = await apiRequest<CronResult>("POST", `/api/scheduler/tasks/${taskId}/run`);
        if (res.status === 200) {
          const result = res.data as Record<string, unknown>;
          if (result.success) {
            console.log(c("green", `✅ Task "${taskId}" executed successfully`));
          } else {
            console.log(c("red", `❌ Task execution failed: ${result.error || "Unknown error"}`));
          }
        } else {
          console.log(c("red", `❌ Failed: ${(res.data as CronResult).error || `HTTP ${res.status}`}`));
        }
      } catch (err) {
        console.log(c("red", `❌ ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  cron
    .command("runs [taskId]")
    .description("Show execution history")
    .action(async (taskId?: string) => {
      try {
        const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";
        const res = await apiRequest<{ history?: Array<{ taskId: string; runAt: string; success: boolean; duration: number; error?: string }> }>(
          "GET", `/api/scheduler/history${query}`
        );
        if (res.status !== 200) {
          console.log(c("red", "Failed to fetch history"));
          return;
        }
        const history = res.data.history || [];
        if (history.length === 0) {
          console.log(`\n${c("gray", "No execution history yet")}\n`);
          return;
        }
        console.log(`\n${c("bold", `Execution history${taskId ? ` for ${taskId}` : ""}`)}\n`);
        for (const entry of history) {
          const icon = entry.success ? c("green", "✓") : c("red", "✗");
          console.log(`  ${icon} ${c("gray", entry.taskId.slice(0, 10))}... at ${c("cyan", new Date(entry.runAt).toLocaleString())}`);
          console.log(`    Duration: ${entry.duration}ms${entry.error ? ` | ${c("red", entry.error)}` : ""}`);
        }
        console.log();
      } catch (err) {
        console.log(c("red", `❌ ${err instanceof Error ? err.message : String(err)}`));
      }
    });
}