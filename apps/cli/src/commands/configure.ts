import * as readline from "readline";
import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired } from "../utils/api";

interface ProviderInfo {
  id: string;
  name: string;
  models: string[];
  enabled: boolean;
  apiKeySet: boolean;
}

interface LlmConfig {
  defaultModel?: string;
  defaultProvider?: string;
  providerOrder?: string[];
  fallbacks?: string[];
  providers?: Record<string, any>;
  [key: string]: unknown;
}

interface ChannelConfig {
  channels?: Record<string, any>;
  [key: string]: unknown;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function configureModel(): Promise<void> {
  const alive = await checkServer();
  if (!alive) { serverRequired(); return; }

  try {
    const { data: providersData } = await apiRequest<ProviderInfo[] | { providers: ProviderInfo[] }>("GET", "/api/system/providers");
    const providers = Array.isArray(providersData) ? providersData : (providersData?.providers || []);

    if (providers.length === 0) {
      console.log(c("yellow", `${ICONS.warn()} No providers found. Configure API keys first.`));
      return;
    }

    console.log(section("Select Default Model"));
    const allModels: { provider: string; model: string; label: string }[] = [];
    for (const p of providers) {
      const keyIcon = p.apiKeySet ? ICONS.ok() : ICONS.warn();
      console.log(`  ${keyIcon} ${c("cyan", p.name || p.id)} ${p.enabled ? c("green", "(enabled)") : c("gray", "(disabled)")}`);
      for (const m of p.models) {
        const label = `${p.id}/${m}`;
        allModels.push({ provider: p.id, model: m, label });
        console.log(`    ${ICONS.bullet()} [${allModels.length}] ${label}`);
      }
    }

    const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
    if (config.defaultModel) {
      const current = config.defaultProvider ? `${config.defaultProvider}/${config.defaultModel}` : config.defaultModel;
      console.log(c("gray", `\n  Current default: ${current}`));
    }

    const choice = await prompt("\n  Enter number or provider/model: ");
    if (!choice) {
      console.log(c("yellow", `${ICONS.warn()} Cancelled.`));
      return;
    }

    const idx = parseInt(choice, 10);
    let provider: string | undefined;
    let model: string;

    if (!isNaN(idx) && idx >= 1 && idx <= allModels.length) {
      const selected = allModels[idx - 1];
      provider = selected.provider;
      model = selected.model;
    } else if (choice.includes("/")) {
      const parts = choice.split("/");
      provider = parts[0];
      model = parts.slice(1).join("/");
    } else {
      model = choice;
    }

    const update: any = { ...config, defaultModel: model };
    if (provider) update.defaultProvider = provider;
    await apiRequest("PUT", "/api/config/llm", update);
    console.log(c("green", `${ICONS.ok()} Default model set to ${c("cyan", provider ? `${provider}/${model}` : model)}`));
  } catch (err: any) {
    console.log(c("red", `${ICONS.error()} Failed to configure model: ${err.message}`));
  }
}

async function configureChannel(): Promise<void> {
  const alive = await checkServer();
  if (!alive) { serverRequired(); return; }

  try {
    const { data: config } = await apiRequest<ChannelConfig>("GET", "/api/config/channels");
    const channels = config.channels || {};
    const channelKeys = Object.keys(channels);

    console.log(section("Configure Channels"));
    if (channelKeys.length === 0) {
      console.log(c("gray", "  No channels configured yet."));
    } else {
      for (const key of channelKeys) {
        const ch = channels[key];
        const statusIcon = ch.enabled !== false ? ICONS.ok() : ICONS.warn();
        console.log(`  ${statusIcon} ${c("cyan", key)} ${ch.type ? c("gray", `(${ch.type})`) : ""}`);
      }
    }

    const name = await prompt("\n  Channel name to edit (or 'new' to add): ");
    if (!name) {
      console.log(c("yellow", `${ICONS.warn()} Cancelled.`));
      return;
    }

    const existing = channels[name] || {};
    const type = await prompt(`  Channel type [${existing.type || "whatsapp"}]: `) || existing.type || "whatsapp";
    const enabled = await prompt(`  Enabled? (y/n) [${existing.enabled !== false ? "y" : "n"}]: `);
    const webhook = await prompt(`  Webhook URL [${existing.webhook || ""}]: `) || existing.webhook || "";

    const updated = {
      ...config,
      channels: {
        ...channels,
        [name]: {
          ...existing,
          type,
          enabled: enabled ? enabled.toLowerCase() === "y" : existing.enabled !== false,
          ...(webhook ? { webhook } : {}),
        },
      },
    };

    await apiRequest("PUT", "/api/config/channels", updated);
    console.log(c("green", `${ICONS.ok()} Channel ${c("cyan", name)} configured.`));
  } catch (err: any) {
    console.log(c("red", `${ICONS.error()} Failed to configure channel: ${err.message}`));
  }
}

async function configureAuth(): Promise<void> {
  const alive = await checkServer();
  if (!alive) { serverRequired(); return; }

  try {
    const { data: providersData } = await apiRequest<ProviderInfo[] | { providers: ProviderInfo[] }>("GET", "/api/system/providers");
    const providers = Array.isArray(providersData) ? providersData : (providersData?.providers || []);

    if (providers.length === 0) {
      console.log(c("yellow", `${ICONS.warn()} No providers found.`));
      return;
    }

    console.log(section("Configure API Keys"));
    for (const p of providers) {
      const keyIcon = p.apiKeySet ? ICONS.ok() : ICONS.warn();
      console.log(`  ${keyIcon} ${c("cyan", p.name || p.id)} ${p.apiKeySet ? c("green", "(key set)") : c("red", "(key missing)")}`);
    }

    const providerId = await prompt("\n  Provider to configure: ");
    if (!providerId) {
      console.log(c("yellow", `${ICONS.warn()} Cancelled.`));
      return;
    }

    const apiKey = await prompt(`  Enter API key for ${providerId}: `);
    if (!apiKey) {
      console.log(c("red", `${ICONS.error()} No API key provided.`));
      return;
    }

    const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
    const update = { ...config };
    if (!update.providers) update.providers = {} as any;
    (update.providers as any)[providerId] = { ...(update.providers as any)?.[providerId], apiKey };
    await apiRequest("PUT", "/api/config/llm", update);
    console.log(c("green", `${ICONS.ok()} API key for ${c("cyan", providerId)} saved.`));
  } catch (err: any) {
    console.log(c("red", `${ICONS.error()} Failed to configure auth: ${err.message}`));
  }
}

async function configureGateway(): Promise<void> {
  const alive = await checkServer();

  console.log(section("Gateway Configuration"));
  if (alive) {
    try {
      const { data: health } = await apiRequest<Record<string, unknown>>("GET", "/health");
      console.log(`  ${ICONS.arrow()} Status:     ${c("green", "running")}`);
      console.log(`  ${ICONS.arrow()} Port:       ${health.port || "N/A"}`);
      console.log(`  ${ICONS.arrow()} Version:    ${health.version || "N/A"}`);
      console.log(`  ${ICONS.arrow()} Uptime:     ${health.uptime || 0}s`);
      console.log(`  ${ICONS.arrow()} Mode:       ${health.mode || "production"}`);
    } catch {
      console.log(`  ${ICONS.arrow()} Status:     ${c("yellow", "reachable but error fetching details")}`);
    }
  } else {
    console.log(`  ${ICONS.arrow()} Status:     ${c("red", "not running")}`);
  }

  const action = await prompt("\n  Edit gateway config? (port/mode/none): ");
  if (!action || action.toLowerCase() === "none") return;

  if (action.toLowerCase() === "port") {
    const newPort = await prompt("  New port: ");
    const port = parseInt(newPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.log(c("red", `${ICONS.error()} Invalid port number.`));
      return;
    }
    if (alive) {
      try {
        await apiRequest("PUT", "/api/config/llm", { gatewayPort: port });
        console.log(c("green", `${ICONS.ok()} Gateway port set to ${port}. Restart required.`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to update: ${err.message}`));
      }
    } else {
      console.log(c("yellow", `${ICONS.warn()} Server not running. Set EvoClaw_PORT in .env manually.`));
    }
  } else if (action.toLowerCase() === "mode") {
    const newMode = await prompt("  Mode (production/development): ");
    if (newMode !== "production" && newMode !== "development") {
      console.log(c("red", `${ICONS.error()} Invalid mode. Use 'production' or 'development'.`));
      return;
    }
    if (alive) {
      try {
        await apiRequest("PUT", "/api/config/llm", { gatewayMode: newMode });
        console.log(c("green", `${ICONS.ok()} Gateway mode set to ${newMode}. Restart required.`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to update: ${err.message}`));
      }
    } else {
      console.log(c("yellow", `${ICONS.warn()} Server not running. Set EvoClaw_MODE in .env manually.`));
    }
  }
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const cfg = program
    .command("configure")
    .description("Interactive configuration (OpenClaw compatible)");

  cfg
    .command("model")
    .description("Interactively select default model")
    .action(async () => {
      await configureModel();
    });

  cfg
    .command("channel")
    .description("Interactively configure channels")
    .action(async () => {
      await configureChannel();
    });

  cfg
    .command("auth")
    .description("Interactively configure API keys")
    .action(async () => {
      await configureAuth();
    });

  cfg
    .command("gateway")
    .description("Display or modify gateway configuration")
    .action(async () => {
      await configureGateway();
    });
}
