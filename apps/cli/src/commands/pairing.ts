import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const pairing = program
    .command("pairing")
    .description("Manage device and channel pairing");

  pairing
    .command("list [channel]")
    .description("List approved contacts / paired devices")
    .option("--json", "Output as JSON")
    .action(async (channel: string | undefined, opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/api/channels/approved");
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        console.log(`\n${c("bold", `Approved Contacts${channel ? ` (${channel})` : ""}\n`)}`);
        const contacts = (r.data?.contacts || r.data?.channels || r.data?.items || r.data?.peers || r.data?.approved || []) as Array<Record<string, unknown>>;
        if (contacts.length === 0) {
          console.log(`  ${c("gray", "No approved contacts yet")}`);
          console.log(`  ${c("gray", "Requests appear when users send their first DM")}`);
          console.log(`  ${c("gray", "(endpoint may return single-channel info, not a contact list)")}`);
        } else {
          for (const ct of contacts) {
            const ch = String(ct.channel || ct.id || ct.name || "unknown");
            const label = String(ct.label || ct.displayName || ct.name || "");
            const statusStr = ct.status ? ` ${c("green", String(ct.status))}` : "";
            if (channel && ch !== channel) continue;
            console.log(`  ${ICONS.bullet()} ${ch}${label ? ` ${c("gray", label)}` : ""}${statusStr}`);
          }
        }
        console.log();
      } catch (err) {
        console.log(c("yellow", `${ICONS.warn()} Could not fetch approved contacts: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  pairing
    .command("approve <channel> <code>")
    .description("Approve a pairing request")
    .option("--notify", "Send notification to requester")
    .action(async (channel: string, code: string, opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("POST", "/api/channels/pairing/approve", { channel, code });
        if (r.status >= 200 && r.status < 300) {
          console.log(c("green", `${ICONS.ok()} Pairing "${code}" approved for ${channel}`));
          if (opts.notify) console.log(c("gray", "  Notification sent to requester"));
        } else {
          const msg = (r.data as Record<string, unknown>)?.error || (r.data as Record<string, unknown>)?.message || `HTTP ${r.status}`;
          console.log(c("red", `${ICONS.error()} Approval failed: ${msg}`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Approval failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  pairing
    .command("reject <channel> <code>")
    .description("Reject a pairing request")
    .action(async (channel: string, code: string) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("DELETE", `/api/channels/pairing/${encodeURIComponent(channel)}/${encodeURIComponent(code)}`);
        if (r.status >= 200 && r.status < 300 && r.data?.success !== false) {
          console.log(c("green", `${ICONS.ok()} Pairing "${code}" rejected for ${channel}`));
        } else {
          const msg = (r.data as Record<string, unknown>)?.message || (r.data as Record<string, unknown>)?.error || `HTTP ${r.status}`;
          console.log(c("yellow", `${ICONS.warn()} Could not reject pairing: ${msg}`));
          console.log(c("gray", `  The pairing code may be invalid, already expired, or already handled.`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Rejection failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  pairing
    .command("pending")
    .description("Show pending pairing requests awaiting approval")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/api/permission/requests");
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        console.log(`\n${c("bold", "Pending Pairing Requests\n")}`);
        const requests = (r.data.requests || r.data.items || (Array.isArray(r.data) ? r.data : [])) as Array<Record<string, unknown>>;
        if (requests.length === 0) {
          console.log(`  ${c("gray", "No pending pairing requests")}`);
          console.log(`  ${c("gray", "Requests appear when users send their first DM")}`);
        } else {
          for (const req of requests) {
            const ch = String(req.channel || req.id || "unknown");
            const code = req.code ? String(req.code) : "";
            const from = req.from || req.requester || req.sender || "";
            console.log(`  ${ICONS.bullet()} ${ch}${code ? ` code=${c("cyan", code)}` : ""}${from ? ` ${c("gray", `from ${from}`)}` : ""}`);
          }
          console.log(`\n  ${c("gray", `Approve with: EvoClaw pairing approve <channel> <code>`)}`);
        }
        console.log();
      } catch (err) {
        console.log(c("yellow", `${ICONS.warn()} Could not fetch pending requests: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
}
