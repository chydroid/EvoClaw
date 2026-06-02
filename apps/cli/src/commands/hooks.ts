import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const hooks = program
    .command("hooks")
    .description("Manage system event hooks");

  hooks
    .command("list")
    .description("List all hooks")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/api/events/snapshot");
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        console.log(`\n${c("bold", "=== System Hooks ===\n")}`);
        const events = (r.data.events || r.data.hooks || r.data.items || (Array.isArray(r.data) ? r.data : [])) as Array<Record<string, unknown>>;
        if (events.length === 0) {
          console.log(`  ${c("gray", "No hooks found")}`);
        } else {
          for (const ev of events) {
            const name = String(ev.name || ev.event || ev.id || "unknown");
            const handler = ev.handler || ev.listener || "";
            const status = ev.status || ev.enabled;
            const statusStr = status === false || status === "disabled"
              ? c("yellow", "disabled")
              : c("green", "enabled");
            console.log(`  ${ICONS.bullet()} ${name}  ${c("gray", `→ ${handler}`)}  [${statusStr}]`);
          }
        }
        console.log();
      } catch (err) {
        console.log(c("yellow", `${ICONS.warn()} Could not fetch hooks: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  hooks
    .command("info <name>")
    .description("Show hook details")
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/api/events/snapshot");
        const events = (r.data.events || r.data.hooks || r.data.items || (Array.isArray(r.data) ? r.data : [])) as Array<Record<string, unknown>>;
        const found = events.find(ev =>
          ev.name === name || ev.event === name || ev.id === name
        );
        if (!found) {
          console.log(c("yellow", `${ICONS.warn()} Hook "${name}" not found`));
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(found, null, 2));
          return;
        }
        console.log(`\n${c("bold", `Hook: ${name}`)}`);
        const status = found.status || found.enabled;
        console.log(`  Status: ${status === false || status === "disabled" ? c("yellow", "disabled") : c("green", "enabled")}`);
        if (found.handler || found.listener) console.log(`  Handler: ${found.handler || found.listener}`);
        if (found.description || found.desc) console.log(`  Description: ${found.description || found.desc}`);
        if (found.type) console.log(`  Type: ${found.type}`);
        if (found.lastTriggered || found.lastTriggeredAt) console.log(`  Last triggered: ${found.lastTriggered || found.lastTriggeredAt}`);
        console.log();
      } catch (err) {
        console.log(c("yellow", `${ICONS.warn()} Could not fetch hook info: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  hooks
    .command("check")
    .description("Check hook system health")
    .action(async () => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("red", `${ICONS.error()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/api/events");
        const data = r.data;
        const healthy = data.healthy !== false && r.status >= 200 && r.status < 300;
        if (healthy) {
          console.log(`  ${ICONS.ok()} Event system healthy`);
          const events = (data.events || data.items || (Array.isArray(data) ? data : [])) as Array<Record<string, unknown>>;
          console.log(`  ${c("gray", `${Array.isArray(events) ? events.length : 0} event types registered`)}`);
        } else {
          console.log(`  ${ICONS.error()} Event system unhealthy`);
          if (data.error || data.message) console.log(`  ${c("red", String(data.error || data.message))}`);
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Event system unreachable: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  hooks
    .command("enable <name>")
    .description("Enable a hook")
    .action(async (name: string) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("PUT", "/api/config/llm", {
          key: `hooks.${name}.enabled`,
          value: true,
        });
        if (r.status >= 200 && r.status < 300) {
          console.log(c("green", `${ICONS.ok()} Hook "${name}" enabled`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} Could not enable hook via API. Use the Web UI → Settings → Hooks to enable "${name}".`));
        }
      } catch {
        console.log(c("yellow", `${ICONS.warn()} Could not enable hook via API. Use the Web UI → Settings → Hooks to enable "${name}".`));
      }
    });

  hooks
    .command("disable <name>")
    .description("Disable a hook")
    .action(async (name: string) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("PUT", "/api/config/llm", {
          key: `hooks.${name}.enabled`,
          value: false,
        });
        if (r.status >= 200 && r.status < 300) {
          console.log(c("green", `${ICONS.ok()} Hook "${name}" disabled`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} Could not disable hook via API. Use the Web UI → Settings → Hooks to disable "${name}".`));
        }
      } catch {
        console.log(c("yellow", `${ICONS.warn()} Could not disable hook via API. Use the Web UI → Settings → Hooks to disable "${name}".`));
      }
    });

  hooks
    .command("install <name>")
    .description("Install a hook")
    .action((name: string) => {
      console.log(c("cyan", `${ICONS.info()} Hooks are built into EvoClaw and installed automatically with the system.`));
      console.log(c("gray", `  To add custom hooks, create a plugin with event handlers in the plugins/ directory.`));
      console.log(c("gray", `  See: https://docs.evoclaw.ai/hooks for the hook development guide.`));
      console.log(c("gray", `  Hook "${name}" — check if it's available in your current version with: EvoClaw hooks list`));
    });

  hooks
    .command("update [name]")
    .description("Update hook(s)")
    .action((name: string | undefined) => {
      console.log(c("cyan", `${ICONS.info()} Hooks are updated together with EvoClaw system updates.`));
      if (name) {
        console.log(c("gray", `  To update hook "${name}", run: EvoClaw update`));
      } else {
        console.log(c("gray", `  To update all hooks, run: EvoClaw update`));
      }
      console.log(c("gray", `  Custom hook plugins can be updated via: EvoClaw plugins update`));
    });
}
