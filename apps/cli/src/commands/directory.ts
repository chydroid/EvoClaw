import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired, VERSION } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const dir = program
    .command("directory")
    .description("Manage contact directory");

  dir
    .command("self")
    .description("Show current identity")
    .option("-c, --channel <name>", "Channel context")
    .action(async (opts: Record<string, unknown>) => {
      console.log(section("Current Identity"));

      const serverAlive = await checkServer();
      if (serverAlive) {
        try {
          const servicesRes = await apiRequest<Array<Record<string, unknown>>>("GET", "/api/system/services");
          const services = servicesRes.data || [];
          console.log(`  ${ICONS.arrow()} Name:         EvoClaw`);
          console.log(`  ${ICONS.arrow()} Version:      v${VERSION}`);
          console.log(`  ${ICONS.arrow()} Channel:      ${opts.channel || "web-ui"}`);
          console.log(`  ${ICONS.arrow()} Services:     ${services.length} registered`);

          try {
            const healthRes = await apiRequest<Record<string, unknown>>("GET", "/health");
            console.log(`  ${ICONS.arrow()} Uptime:       ${healthRes.data.uptime || 0}s`);
            console.log(`  ${ICONS.arrow()} Server:       ${c("green", "online")}`);
          } catch {
            console.log(`  ${ICONS.arrow()} Server:       ${c("yellow", "degraded")}`);
          }
        } catch {
          console.log(`  ${ICONS.arrow()} Name:    EvoClaw`);
          console.log(`  ${ICONS.arrow()} Channel: ${opts.channel || "web-ui"}`);
          console.log(c("yellow", `  ${ICONS.warn()} Could not fetch service info`));
        }
      } else {
        console.log(`  ${ICONS.arrow()} Name:    EvoClaw`);
        console.log(`  ${ICONS.arrow()} Version: v${VERSION}`);
        console.log(`  ${ICONS.arrow()} Channel: ${opts.channel || "web-ui"}`);
        console.log(c("yellow", `  ${ICONS.warn()} Gateway offline`));
      }
    });

  dir
    .command("peers [action]")
    .description("Manage peer contacts")
    .option("-c, --channel <name>", "Channel context")
    .option("--query <text>", "Search query")
    .action(async (action: string, opts: Record<string, unknown>) => {
      if (action === "list" || !action) {
        console.log(section(`Peers${opts.channel ? ` (${opts.channel})` : ""}`));

        const serverAlive = await checkServer();
        if (!serverAlive) {
          console.log(c("yellow", `  ${ICONS.warn()} Gateway offline`));
          return;
        }

        try {
          const chRes = await apiRequest<Record<string, unknown>>("GET", "/api/channels/status");
          const channels = ((chRes.data as Record<string, unknown>)?.channels || []) as Array<Record<string, unknown>>;

          if (channels.length === 0) {
            console.log(c("gray", "  No channels configured"));
            return;
          }

          const connected = channels.filter((ch: Record<string, unknown>) => ch.connected);
          const disconnected = channels.filter((ch: Record<string, unknown>) => !ch.connected);

          if (connected.length > 0) {
            console.log(c("green", `  Connected (${connected.length}):`));
            for (const ch of connected) {
              console.log(`  ${ICONS.ok()} ${ch.label || ch.type} — messages: ${ch.messageCount || 0}`);
            }
          }

          if (disconnected.length > 0) {
            console.log(c("yellow", `  Disconnected (${disconnected.length}):`));
            for (const ch of disconnected) {
              console.log(`  ${ICONS.warn()} ${ch.label || ch.type}`);
            }
          }
        } catch {
          console.log(c("yellow", `  ${ICONS.warn()} Could not fetch channel status`));
        }
      }
    });

  dir
    .command("groups [action]")
    .description("Manage group contacts")
    .option("-c, --channel <name>", "Channel context")
    .option("--group-id <id>", "Group identifier")
    .action(async (action: string, opts: Record<string, unknown>) => {
      if (action === "list" || !action) {
        console.log(section(`Groups${opts.channel ? ` (${opts.channel})` : ""}`));

        const serverAlive = await checkServer();
        if (!serverAlive) {
          console.log(c("yellow", `  ${ICONS.warn()} Gateway offline`));
          return;
        }

        try {
          const chRes = await apiRequest<Record<string, unknown>>("GET", "/api/channels/active");
          const activeChannels = (chRes.data as Record<string, unknown>)?.activeChannels || [];

          const activeList = activeChannels as string[];
          if (activeList.length === 0) {
            console.log(c("gray", "  No active groups"));
            return;
          }

          for (const ch of activeList) {
            console.log(`  ${ICONS.bullet()} ${ch}`);
          }
        } catch {
          console.log(c("yellow", `  ${ICONS.warn()} Could not fetch active channels`));
        }
      } else if (action === "members") {
        console.log(section(`Group Members${opts.groupId ? `: ${opts.groupId}` : ""}`));
        console.log(c("gray", "  Use Web UI → Channels tab for group member management"));
      }
    });
}
