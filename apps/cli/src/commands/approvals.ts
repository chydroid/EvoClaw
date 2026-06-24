import * as fs from "fs";
import { Command } from "commander";
import { c, ICONS, divider } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

interface PermissionRequest {
  id: string;
  agent?: string;
  action?: string;
  resource?: string;
  reason?: string;
  timestamp?: string;
  status?: string;
}

interface WhitelistEntry {
  path: string;
  permissions: string;
}

async function ensureServer(): Promise<boolean> {
  const alive = await checkServer();
  if (!alive) {
    console.log(c("red", "❌ Gateway not reachable. Start with: EvoClaw gateway start"));
    return false;
  }
  return true;
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const approvals = program
    .command("approvals")
    .description("Manage execution approval policies");

  approvals
    .command("get")
    .description("Show pending approval requests")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ requests: PermissionRequest[] }>("GET", "/api/permission/requests");
        const requests = r.data?.requests || [];
        if (opts.json) {
          console.log(JSON.stringify({ requests }, null, 2));
          return;
        }
        console.log();
        console.log(c("bold", "=== Pending Approval Requests ===\n"));
        if (requests.length === 0) {
          console.log(c("gray", "  No pending requests."));
          console.log();
          return;
        }
        for (const req of requests) {
          const ts = req.timestamp ? new Date(req.timestamp).toLocaleString() : "—";
          console.log(`  ${ICONS.bullet()} ${c("cyan", req.id)}`);
          if (req.agent) console.log(`    Agent:      ${req.agent}`);
          if (req.action) console.log(`    Action:     ${req.action}`);
          if (req.resource) console.log(`    Resource:   ${req.resource}`);
          if (req.reason) console.log(`    Reason:     ${c("gray", req.reason)}`);
          console.log(`    Requested:  ${c("gray", ts)}`);
          console.log();
        }
      } catch (err) {
        console.log(c("red", `❌ Failed to fetch requests: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  approvals
    .command("approve <requestId>")
    .description("Approve a permission request")
    .action(async (requestId: string) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ success: boolean }>("POST", "/api/permission/approve", { requestId });
        if (r.data?.success || r.status === 200) {
          console.log(c("green", `✅ Request ${requestId} approved`));
        } else {
          console.log(c("yellow", `⚠ Request ${requestId} could not be approved`));
        }
      } catch (err) {
        console.log(c("red", `❌ Failed to approve: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  approvals
    .command("deny <requestId>")
    .description("Deny a permission request")
    .action(async (requestId: string) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ success: boolean }>("POST", "/api/permission/deny", { requestId });
        if (r.data?.success || r.status === 200) {
          console.log(c("green", `✅ Request ${requestId} denied`));
        } else {
          console.log(c("yellow", `⚠ Request ${requestId} could not be denied`));
        }
      } catch (err) {
        console.log(c("red", `❌ Failed to deny: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  const allowlist = approvals
    .command("allowlist")
    .description("Manage permission allowlist");

  allowlist
    .command("list")
    .description("List allowlist entries")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<any>("GET", "/api/permission/whitelist");
        const entries = (r.data?.whitelist || []).map((w: any) => ({ path: w.targetPattern, permissions: w.operation }));
        if (opts.json) {
          console.log(JSON.stringify({ entries }, null, 2));
          return;
        }
        console.log();
        console.log(c("bold", "=== Permission Allowlist ===\n"));
        if (entries.length === 0) {
          console.log(c("gray", "  No allowlist entries."));
          console.log();
          return;
        }
        for (const entry of entries) {
          console.log(`  ${ICONS.bullet()} ${c("cyan", entry.path)}  ${c("gray", entry.permissions)}`);
        }
        console.log();
      } catch (err) {
        console.log(c("red", `❌ Failed to fetch allowlist: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  allowlist
    .command("add <path> <permissions>")
    .description("Add an entry to the allowlist")
    .action(async (entryPath: string, permissions: string) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ success: boolean }>("POST", "/api/permission/whitelist", {
          path: entryPath,
          permissions,
        });
        if (r.data?.success || r.status === 200) {
          console.log(c("green", `✅ Added ${entryPath} with permissions: ${permissions}`));
        } else {
          console.log(c("yellow", `⚠ Could not add allowlist entry`));
        }
      } catch (err) {
        console.log(c("red", `❌ Failed to add allowlist entry: ${err instanceof Error ? err.message : String(err)}`));
        console.log(c("yellow", "  Note: whitelist add requires server-side POST /api/permission/whitelist route"));
      }
    });

  allowlist
    .command("remove <path>")
    .description("Remove an entry from the allowlist")
    .action(async (entryPath: string) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ success: boolean }>("DELETE", "/api/permission/whitelist", {
          operation: entryPath,
          target: entryPath,
        });
        if (r.data?.success || r.status === 200) {
          console.log(c("green", `✅ Removed ${entryPath} from allowlist`));
        } else {
          console.log(c("yellow", `⚠ Could not remove allowlist entry`));
        }
      } catch (err) {
        console.log(c("red", `❌ Failed to remove allowlist entry: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  approvals
    .command("set <json-file>")
    .description("Load approval policy from JSON file")
    .action(async (file: string) => {
      if (!(await ensureServer())) return;
      try {
        const raw = fs.readFileSync(file, "utf-8");
        const policy = JSON.parse(raw);
        const r = await apiRequest<{ success: boolean }>("POST", "/api/permission/whitelist", policy);
        if (r.data?.success || r.status === 200) {
          console.log(c("green", `✅ Approval policy loaded from ${file}`));
        } else {
          console.log(c("yellow", `⚠ Policy may not have been fully applied`));
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.log(c("red", `❌ Invalid JSON in ${file}`));
        } else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          console.log(c("red", `❌ File not found: ${file}`));
        } else {
          console.log(c("red", `❌ Failed to load policy: ${err instanceof Error ? err.message : String(err)}`));
          console.log(c("yellow", "  Note: whitelist add requires server-side POST /api/permission/whitelist route"));
        }
      }
    });

  approvals
    .command("policy")
    .description("Show current approval policy")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const [whitelistRes, requestsRes] = await Promise.all([
          apiRequest<any>("GET", "/api/permission/whitelist"),
          apiRequest<{ requests: PermissionRequest[] }>("GET", "/api/permission/requests"),
        ]);
        const entries = (whitelistRes.data?.whitelist || []).map((w: any) => ({ path: w.targetPattern, permissions: w.operation }));
        const pending = requestsRes.data?.requests || [];

        if (opts.json) {
          console.log(JSON.stringify({ allowlist: entries, pendingCount: pending.length }, null, 2));
          return;
        }

        console.log();
        console.log(c("bold", "=== Approval Policy ===\n"));
        console.log(`  Mode:         ${c("green", "interactive")}`);
        console.log(`  Pending:      ${pending.length} request(s)`);
        console.log(`  Allowlist:    ${entries.length} entr(y/ies)`);
        if (entries.length > 0) {
          for (const entry of entries) {
            console.log(`    ${ICONS.bullet()} ${c("cyan", entry.path)}  ${c("gray", entry.permissions)}`);
          }
        }
        console.log();
      } catch (err) {
        console.log(c("red", `❌ Failed to fetch policy: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
}
