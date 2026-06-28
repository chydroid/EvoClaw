/** tasks — Task and workboard management */
import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired } from "../utils/api";

interface WorkboardTask {
  id: string;
  title: string;
  status: string;
  priority?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface EvolutionDashboard {
  summary?: {
    totalCycles?: number;
    activeEvolutions?: number;
    completedEvolutions?: number;
    failedEvolutions?: number;
    [key: string]: unknown;
  };
  recentEvolutions?: Array<{
    id: string;
    type: string;
    status: string;
    timestamp: string;
    summary?: string;
  }>;
  [key: string]: unknown;
}

interface AgentStatus {
  sessionId: string;
  state: string;
  currentAction: string;
  tokensUsed: number;
  duration: number;
  runId: number;
}

export function register(program: Command, _shared: (cmd: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const tasks = program
    .command("tasks")
    .description("View and manage tasks, agent executions, and evolution cycles");

  // tasks list — show active agent executions + workboard tasks
  tasks
    .command("list")
    .description("List active tasks and agent executions")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const [statusRes, wbRes, evoRes] = await Promise.allSettled([
          apiRequest<{ agentStatuses: AgentStatus[] }>("GET", "/api/status"),
          apiRequest<WorkboardTask[] | { tasks: WorkboardTask[] }>("GET", "/api/workboard"),
          apiRequest<EvolutionDashboard>("GET", "/api/evolution/dashboard"),
        ]);

        if (opts.json) {
          const result: Record<string, unknown> = {};
          if (statusRes.status === "fulfilled") result.agents = statusRes.value.data.agentStatuses || [];
          if (wbRes.status === "fulfilled") {
            const wbData = wbRes.value.data;
            result.workboard = Array.isArray(wbData) ? wbData : (wbData as { tasks: WorkboardTask[] }).tasks || [];
          }
          if (evoRes.status === "fulfilled") result.evolution = evoRes.value.data;
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(section("Active Tasks"));

        // Agent executions
        if (statusRes.status === "fulfilled") {
          const agents = statusRes.value.data.agentStatuses || [];
          if (agents.length > 0) {
            console.log(c("bold", "  Agent Executions:"));
            for (const a of agents) {
              const stateColor = a.state === "running" ? "green" : a.state === "error" ? "red" : "gray";
              console.log(`    ${ICONS.bullet()} ${c("cyan", a.sessionId)}  ${c(stateColor as never, a.state)}  ${c("gray", a.currentAction || "idle")}`);
              console.log(c("gray", `       tokens: ${a.tokensUsed}  duration: ${a.duration}ms  run: #${a.runId}`));
            }
          } else {
            console.log(c("gray", "  No active agent executions."));
          }
        }

        // Workboard tasks
        if (wbRes.status === "fulfilled") {
          const wbData = wbRes.value.data;
          const wbTasks = Array.isArray(wbData) ? wbData : (wbData as { tasks: WorkboardTask[] }).tasks || [];
          if (wbTasks.length > 0) {
            console.log(c("bold", "\n  Workboard Tasks:"));
            for (const t of wbTasks) {
              const statusIcon = t.status === "done" || t.status === "completed" ? ICONS.ok() : t.status === "error" || t.status === "failed" ? ICONS.error() : ICONS.bullet();
              console.log(`    ${statusIcon} ${c("cyan", t.id)}  ${t.title}  ${c("gray", t.status)}`);
            }
          }
        }

        // Evolution summary
        if (evoRes.status === "fulfilled") {
          const summary = evoRes.value.data.summary;
          if (summary) {
            console.log(c("bold", "\n  Evolution Summary:"));
            console.log(c("gray", `    Total cycles: ${summary.totalCycles || 0}  Active: ${summary.activeEvolutions || 0}  Completed: ${summary.completedEvolutions || 0}`));
          }
        }

        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to fetch tasks: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // tasks show <id> — show task/execution details
  tasks
    .command("show <id>")
    .description("Show details of a specific task or execution")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", `/api/tasks/${encodeURIComponent(id)}`);
        if (opts.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
        console.log(section(`Task: ${id}`));
        const data = r.data as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          if (value === null || value === undefined) continue;
          const display = typeof value === "object" ? JSON.stringify(value) : String(value);
          console.log(`  ${ICONS.arrow()} ${key}: ${display.length > 100 ? display.slice(0, 100) + "..." : display}`);
        }
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Task not found or error: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // tasks create — create a workboard task
  tasks
    .command("create <title>")
    .description("Create a new workboard task")
    .option("--priority <level>", "Priority (low/medium/high)")
    .option("--json", "Output as JSON")
    .action(async (title: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const body: Record<string, unknown> = { title };
        if (opts.priority) body.priority = opts.priority;
        const r = await apiRequest<WorkboardTask>("POST", "/api/workboard/tasks", body);
        if (opts.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
        console.log(c("green", `${ICONS.ok()} Task created: ${c("cyan", r.data.id || "unknown")} — ${title}`));
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to create task: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // tasks status <id> <status> — update task status
  tasks
    .command("status <id> <status>")
    .description("Update task status (e.g. done, in-progress, cancelled)")
    .action(async (id: string, status: string) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        await apiRequest("POST", `/api/workboard/tasks/${encodeURIComponent(id)}/status`, { status });
        console.log(c("green", `${ICONS.ok()} Task ${c("cyan", id)} → ${status}`));
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to update task: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // tasks delete <id> — delete a workboard task
  tasks
    .command("delete <id>")
    .description("Delete a workboard task")
    .action(async (id: string) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        await apiRequest("DELETE", `/api/workboard/tasks/${encodeURIComponent(id)}`);
        console.log(c("green", `${ICONS.ok()} Task ${c("cyan", id)} deleted`));
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to delete task: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // tasks evolution — show evolution cycles
  tasks
    .command("evolution")
    .description("Show evolution engine cycles and stats")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const r = await apiRequest<EvolutionDashboard>("GET", "/api/evolution/dashboard");
        if (opts.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
        console.log(section("Evolution Engine"));
        const s = r.data.summary;
        if (s) {
          console.log(`  ${ICONS.arrow()} Total cycles:   ${s.totalCycles || 0}`);
          console.log(`  ${ICONS.arrow()} Active:         ${c("green", String(s.activeEvolutions || 0))}`);
          console.log(`  ${ICONS.arrow()} Completed:      ${s.completedEvolutions || 0}`);
          console.log(`  ${ICONS.arrow()} Failed:         ${s.failedEvolutions || 0}`);
        }
        const recent = r.data.recentEvolutions;
        if (recent && recent.length > 0) {
          console.log(c("bold", "\n  Recent Cycles:"));
          for (const e of recent.slice(0, 10)) {
            const statusIcon = e.status === "completed" ? ICONS.ok() : e.status === "failed" ? ICONS.error() : ICONS.bullet();
            console.log(`    ${statusIcon} ${e.id}  ${e.type}  ${c("gray", e.status)}  ${c("gray", e.timestamp)}`);
            if (e.summary) console.log(c("gray", `       ${e.summary.slice(0, 100)}`));
          }
        }
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to fetch evolution data: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // tasks trigger — trigger an evolution cycle
  tasks
    .command("trigger")
    .description("Trigger a new evolution cycle")
    .option("--skill <id>", "Trigger evolution for a specific skill")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        if (opts.skill) {
          await apiRequest("POST", "/api/evolution/trigger-skill", { skillId: opts.skill });
          console.log(c("green", `${ICONS.ok()} Evolution triggered for skill: ${c("cyan", opts.skill as string)}`));
        } else {
          await apiRequest("POST", "/api/evolution/trigger", {});
          console.log(c("green", `${ICONS.ok()} Evolution cycle triggered`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to trigger evolution: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // ── tasks audit ─────────────────────────────────────────────────
  // 审计工作板变更记录（openclaw 兼容命令）
  tasks
    .command("audit")
    .description("Show audit trail of workboard task changes")
    .option("--task <id>", "Filter by task id")
    .option("--limit <n>", "Max entries to show", "50")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const query = opts.task ? `?taskId=${encodeURIComponent(String(opts.task))}` : "";
        const r = await apiRequest<{ entries?: Array<Record<string, unknown>> }>(
          "GET",
          `/api/workboard/audit${query}`,
        );
        let entries = r.data?.entries || [];
        const limit = parseInt(String(opts.limit || "50"), 10);
        entries = entries.slice(0, isNaN(limit) ? 50 : limit);
        if (opts.json) {
          console.log(JSON.stringify({ count: entries.length, entries }, null, 2));
          return;
        }
        console.log(section("Workboard Audit"));
        if (entries.length === 0) {
          console.log(c("gray", "  No audit entries."));
          return;
        }
        for (const e of entries) {
          const ts = (e.timestamp as string) || (e.at as string) || "—";
          const actor = (e.actor as string) || (e.user as string) || "system";
          const action = (e.action as string) || (e.op as string) || "—";
          const taskId = (e.taskId as string) || (e.id as string) || "—";
          console.log(`  ${c("gray", String(ts))} ${c("cyan", String(actor))} ${action} ${c("gray", String(taskId))}`);
        }
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Audit fetch failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // ── tasks maintenance ──────────────────────────────────────────
  // 工作板维护：清理过期、归档已完成、统计
  tasks
    .command("maintenance")
    .description("Run workboard maintenance (archive completed, prune stale)")
    .option("--archive-age <days>", "Archive tasks completed more than N days ago", "7")
    .option("--prune-age <days>", "Prune archived tasks older than N days", "30")
    .option("--dry-run", "Preview without modifying")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const body: Record<string, unknown> = {
          archiveAgeDays: parseInt(String(opts.archiveAge || "7"), 10),
          pruneAgeDays: parseInt(String(opts.pruneAge || "30"), 10),
          dryRun: Boolean(opts.dryRun),
        };
        const r = await apiRequest<{ archived?: number; pruned?: number; errors?: string[] }>(
          "POST",
          "/api/workboard/maintenance",
          body,
        );
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        console.log(section("Workboard Maintenance"));
        if (opts.dryRun) console.log(c("yellow", `${ICONS.warn()} Dry run — no changes applied`));
        console.log(`  Archived:   ${c("cyan", String(r.data?.archived ?? 0))}`);
        console.log(`  Pruned:      ${c("cyan", String(r.data?.pruned ?? 0))}`);
        if (r.data?.errors && r.data.errors.length > 0) {
          console.log(c("red", `  Errors (${r.data.errors.length}):`));
          for (const e of r.data.errors) console.log(c("gray", `    ${e}`));
        }
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Maintenance failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // ── tasks notify ───────────────────────────────────────────────
  // 为 task 推送通知（openclaw 兼容命令，对接 notification subsystem）
  tasks
    .command("notify <id>")
    .description("Send a notification referencing a task")
    .requiredOption("--message <text>", "Notification message body")
    .option("--channel <name>", "Notification channel (e.g. webhook, email)")
    .option("--level <level>", "Notification level (info|warn|critical)", "info")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const body: Record<string, unknown> = {
          taskId: id,
          message: opts.message,
          level: opts.level,
        };
        if (opts.channel) body.channel = opts.channel;
        const r = await apiRequest<{ success?: boolean; notificationId?: string }>(
          "POST",
          "/api/workboard/notify",
          body,
        );
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        if (r.data?.success || r.status === 200) {
          console.log(c("green", `${ICONS.ok()} Notification sent for task ${c("cyan", id)}`));
          if (r.data?.notificationId) console.log(c("gray", `  Notification id: ${r.data.notificationId}`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} Notification may not have been delivered`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Notify failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // ── tasks cancel ───────────────────────────────────────────────
  // 取消任务（区别于 delete：cancel 保留记录但状态置为 cancelled）
  tasks
    .command("cancel <id>")
    .description("Cancel a task (keeps the record, marks as cancelled)")
    .option("--reason <text>", "Cancellation reason")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const body: Record<string, unknown> = { status: "cancelled" };
        if (opts.reason) body.reason = opts.reason;
        const r = await apiRequest<WorkboardTask>(
          "POST",
          `/api/workboard/tasks/${encodeURIComponent(id)}/status`,
          body,
        );
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        console.log(c("green", `${ICONS.ok()} Task ${c("cyan", id)} cancelled`));
        if (opts.reason) console.log(c("gray", `  Reason: ${opts.reason}`));
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Cancel failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // ── tasks flow ──────────────────────────────────────────────────
  // 多步骤工作流管理（openclaw 兼容：flow list / show / cancel）
  const flow = tasks
    .command("flow")
    .description("Manage multi-step task flows");

  flow
    .command("list")
    .description("List active task flows")
    .option("--status <status>", "Filter by status (running|paused|completed|failed)")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const query = opts.status ? `?status=${encodeURIComponent(String(opts.status))}` : "";
        const r = await apiRequest<{ flows?: Array<Record<string, unknown>> }>(
          "GET",
          `/api/workboard/flows${query}`,
        );
        const flows = r.data?.flows || [];
        if (opts.json) {
          console.log(JSON.stringify({ count: flows.length, flows }, null, 2));
          return;
        }
        console.log(section("Task Flows"));
        if (flows.length === 0) {
          console.log(c("gray", "  No active flows."));
          return;
        }
        for (const f of flows) {
          const fid = (f.id as string) || "—";
          const status = (f.status as string) || "—";
          const title = (f.title as string) || (f.name as string) || "—";
          const progress = (f.progress as string) || (f.step as string) || "—";
          const statusIcon = status === "running" ? c("green", "●") : status === "paused" ? c("yellow", "◐") : status === "failed" ? c("red", "✗") : c("gray", "○");
          console.log(`  ${statusIcon} ${c("cyan", fid)} ${c("bold", title)} ${c("gray", status)} step=${progress}`);
        }
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to list flows: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  flow
    .command("show <flowId>")
    .description("Show details of a task flow")
    .option("--json", "Output as JSON")
    .action(async (flowId: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const r = await apiRequest<Record<string, unknown>>(
          "GET",
          `/api/workboard/flows/${encodeURIComponent(flowId)}`,
        );
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        console.log(section(`Flow: ${flowId}`));
        const data = r.data as Record<string, unknown> | undefined;
        if (!data) {
          console.log(c("gray", "  Flow not found."));
          return;
        }
        for (const [k, v] of Object.entries(data)) {
          if (v === null || v === undefined) continue;
          const display = typeof v === "object" ? JSON.stringify(v) : String(v);
          console.log(`  ${ICONS.arrow()} ${k}: ${display.length > 100 ? display.slice(0, 100) + "..." : display}`);
        }
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Flow not found: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  flow
    .command("cancel <flowId>")
    .description("Cancel a running task flow")
    .option("--reason <text>", "Cancellation reason")
    .option("--json", "Output as JSON")
    .action(async (flowId: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const body: Record<string, unknown> = {};
        if (opts.reason) body.reason = opts.reason;
        const r = await apiRequest<{ success?: boolean }>(
          "POST",
          `/api/workboard/flows/${encodeURIComponent(flowId)}/cancel`,
          body,
        );
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        if (r.data?.success || r.status === 200) {
          console.log(c("green", `${ICONS.ok()} Flow ${c("cyan", flowId)} cancelled`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} Flow cancellation may not have succeeded`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Cancel flow failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
}
