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
}
