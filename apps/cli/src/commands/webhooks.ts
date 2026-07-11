import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired, DEFAULT_PORT } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const webhooks = program
    .command("webhooks")
    .description("Manage webhook integrations");

  webhooks
    .command("list")
    .description("List configured webhooks")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) { serverRequired(); return; }

      try {
        const { data } = await apiRequest<Record<string, unknown>>("GET", "/api/webhooks");
        const endpoints = (data?.endpoints || []) as Array<Record<string, unknown>>;

        if (opts.json) {
          console.log(JSON.stringify(endpoints, null, 2));
          return;
        }

        console.log(section("Webhooks"));
        if (endpoints.length === 0) {
          console.log(c("gray", "  No webhooks configured"));
          console.log(c("gray", "  Add one: EvoClaw webhooks add <url>"));
          return;
        }

        for (const ep of endpoints) {
          const statusIcon = ep.enabled !== false ? ICONS.ok() : ICONS.warn();
          console.log(`  ${statusIcon} ${c("cyan", String(ep.id))}  ${c("gray", String(ep.method || "POST"))} ${String(ep.path || "")}`);
          if (ep.description) console.log(c("gray", `     ${ep.description}`));
          if (ep.action) console.log(c("gray", `     Action: ${ep.action}`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to list webhooks: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  const gmail = webhooks
    .command("gmail")
    .description("Gmail webhook integration");

  gmail
    .command("setup")
    .description("Setup Gmail webhook via Pub/Sub")
    .requiredOption("--account <email>", "Gmail account email")
    .option("--topic <name>", "Pub/Sub topic name", "evoclaw-gmail")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) { serverRequired(); return; }

      // 路径注入防护：account 用于构造 webhook path/id，禁止路径穿越字符
      const account = String(opts.account);
      if (account.includes("..") || account.includes("/") || account.includes("\\") || account.includes("\n") || account.includes("\r")) {
        console.log(c("red", `${ICONS.error()} Invalid account: must not contain "..", path separators, or newlines`));
        return;
      }

      try {
        const { data, status } = await apiRequest<Record<string, unknown>>("POST", "/api/webhooks", {
          id: `gmail-${account.replace(/@/g, "-")}`,
          path: `/hooks/gmail/${account.replace(/@/g, "-")}`,
          method: "POST",
          action: "gmail_pubsub",
          description: `Gmail Pub/Sub for ${opts.account}`,
          enabled: true,
        });

        if (status === 201 || data?.success) {
          console.log(c("green", `${ICONS.ok()} Gmail webhook configured for ${opts.account}`));
          console.log(c("gray", `  Webhook ID: gmail-${account.replace(/@/g, "-")}`));
          console.log(c("gray", `  Endpoint: /hooks/gmail/${account.replace(/@/g, "-")}`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} Setup response: ${JSON.stringify(data)}`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to setup Gmail webhook: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  gmail
    .command("run")
    .description("Start Gmail webhook listener")
    .option("--account <email>", "Gmail account")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) { serverRequired(); return; }

      try {
        const { data } = await apiRequest<Record<string, unknown>>("GET", "/api/webhooks");
        const endpoints = (data?.endpoints || []) as Array<Record<string, unknown>>;
        const gmailHooks = endpoints.filter((ep: Record<string, unknown>) =>
          String(ep.id || "").startsWith("gmail-")
        );

        if (gmailHooks.length === 0) {
          console.log(c("yellow", `${ICONS.warn()} No Gmail webhooks configured`));
          console.log(c("gray", "  Run: EvoClaw webhooks gmail setup --account <email>"));
          return;
        }

        const account = opts.account ? String(opts.account) : null;
        const target = account
          ? gmailHooks.find((ep: Record<string, unknown>) => ep.id === `gmail-${account.replace(/@/g, "-")}`)
          : gmailHooks[0];

        if (!target) {
          console.log(c("yellow", `${ICONS.warn()} Gmail webhook not found for ${account}`));
          return;
        }

        console.log(c("green", `${ICONS.ok()} Gmail webhook listener active`));
        console.log(c("gray", `  Webhook: ${target.id}`));
        console.log(c("gray", `  Path: ${target.path}`));
        console.log(c("gray", `  Gateway: http://localhost:${DEFAULT_PORT}`));
        console.log(c("gray", "  Listening for Pub/Sub push messages..."));
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to start Gmail listener: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  webhooks
    .command("add <url>")
    .description("Add a webhook endpoint")
    .option("--method <method>", "HTTP method (POST or GET)", "POST")
    .option("--action <action>", "Action to trigger", "forward")
    .option("--description <text>", "Webhook description")
    .option("--token <token>", "Authentication token")
    .action(async (url: string, opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) { serverRequired(); return; }

      const id = `hook-${Date.now()}`;
      const hookPath = `/hooks/${id}`;

      try {
        const { data, status } = await apiRequest<Record<string, unknown>>("POST", "/api/webhooks", {
          id,
          path: hookPath,
          method: opts.method || "POST",
          action: opts.action || "forward",
          description: opts.description || `Webhook: ${url}`,
          authToken: opts.token || undefined,
          enabled: true,
        });

        if (status === 201 || data?.success) {
          console.log(c("green", `${ICONS.ok()} Webhook added`));
          console.log(c("gray", `  ID: ${id}`));
          console.log(c("gray", `  Endpoint: http://localhost:${DEFAULT_PORT}${hookPath}`));
          console.log(c("gray", `  Target: ${url}`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} Response: ${JSON.stringify(data)}`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to add webhook: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  webhooks
    .command("remove <id>")
    .description("Remove a webhook")
    .action(async (id: string) => {
      const serverAlive = await checkServer();
      if (!serverAlive) { serverRequired(); return; }

      try {
        const { data, status } = await apiRequest<Record<string, unknown>>("DELETE", `/api/webhooks/${id}`);
        if (status === 200 || data?.success) {
          console.log(c("green", `${ICONS.ok()} Webhook "${id}" removed`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} Webhook "${id}" not found`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to remove webhook: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  webhooks
    .command("test <id>")
    .description("Test a webhook endpoint")
    .option("--payload <json>", "Custom test payload JSON")
    .action(async (id: string, opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) { serverRequired(); return; }

      let testPayload: unknown = { test: true, timestamp: new Date().toISOString() };
      if (opts.payload) {
        try {
          testPayload = JSON.parse(String(opts.payload));
        } catch {
          console.log(c("red", `${ICONS.error()} Invalid JSON payload`));
          return;
        }
      }

      try {
        const { data, status } = await apiRequest<Record<string, unknown>>("POST", `/api/webhooks/${id}/test`, {
          testPayload,
        });

        if (data?.success) {
          console.log(c("green", `${ICONS.ok()} Webhook test successful`));
          console.log(c("gray", `  Status: ${data.statusCode || "N/A"}`));
          if (data.response) console.log(c("gray", `  Response: ${JSON.stringify(data.response).slice(0, 200)}`));
          if (data.eventLog) console.log(c("gray", `  Events: ${JSON.stringify(data.eventLog).slice(0, 200)}`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} Webhook test failed`));
          console.log(c("gray", `  Status: ${data?.statusCode || status}`));
          if (data?.response) console.log(c("gray", `  Response: ${JSON.stringify(data.response).slice(0, 200)}`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Webhook test error: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
}
