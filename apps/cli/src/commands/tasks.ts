/** tasks — Task management */
import { Command } from "commander";
import { c } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const tasks = program
    .command("tasks")
    .description("View and manage tasks");

  tasks
    .command("list")
    .description("List active tasks")
    .action(async () => {
      const serverAlive = await checkServer();
      if (!serverAlive) { console.log(c("yellow", "⚠ Server not running")); return; }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/api/evolution/dashboard");
        console.log(`  Active Tasks: ${(r.data.summary as Record<string, unknown>)?.totalCycles || 0}`);
      } catch {
        console.log(c("yellow", "⚠ Could not fetch tasks"));
      }
    });
}