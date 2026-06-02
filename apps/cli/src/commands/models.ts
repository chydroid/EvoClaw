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
  [key: string]: unknown;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const models = program
    .command("models")
    .description("Manage LLM model configurations");

  models
    .command("list [provider]")
    .description("List available models")
    .option("--json", "Output as JSON")
    .action(async (provider: string | undefined, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data } = await apiRequest<{ providers: ProviderInfo[] }>("GET", "/api/system/providers");
        const providers = data.providers || [];
        const filtered = provider ? providers.filter(p => p.id === provider) : providers;
        if (opts.json) { console.log(JSON.stringify(filtered, null, 2)); return; }
        console.log(section("Available Models"));
        if (filtered.length === 0) {
          console.log(c("gray", "  No providers found."));
          return;
        }
        for (const p of filtered) {
          const statusIcon = p.apiKeySet ? ICONS.ok() : ICONS.warn();
          console.log(`  ${statusIcon} ${c("cyan", p.name || p.id)} ${p.enabled ? c("green", "(enabled)") : c("gray", "(disabled)")}`);
          for (const m of p.models) {
            console.log(`    ${ICONS.bullet()} ${m}`);
          }
        }
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to list models: ${err.message}`));
      }
    });

  models
    .command("status")
    .description("Show model configuration status")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data: providers } = await apiRequest<{ providers: ProviderInfo[] }>("GET", "/api/system/providers");
        const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
        if (opts.json) { console.log(JSON.stringify({ providers: providers.providers, config }, null, 2)); return; }
        console.log(section("Model Status"));
        console.log(`  Default Model:   ${config.defaultModel ? c("green", config.defaultModel) : c("gray", "not set")}`);
        console.log(`  Default Provider: ${config.defaultProvider ? c("green", config.defaultProvider) : c("gray", "not set")}`);
        console.log(`  Fallbacks:       ${config.fallbacks && config.fallbacks.length > 0 ? config.fallbacks.join(" → ") : c("gray", "none")}`);
        console.log(`  Provider Order:  ${config.providerOrder && config.providerOrder.length > 0 ? config.providerOrder.join(", ") : c("gray", "default")}`);
        console.log();
        const provList = providers.providers || [];
        for (const p of provList) {
          const keyIcon = p.apiKeySet ? c("green", "API key set") : c("red", "API key missing");
          const enabledIcon = p.enabled ? c("green", "enabled") : c("gray", "disabled");
          console.log(`  ${ICONS.bullet()} ${c("cyan", p.name || p.id)}  ${keyIcon}  ${enabledIcon}  models: ${p.models.length}`);
        }
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to get status: ${err.message}`));
      }
    });

  models
    .command("set <providerModel>")
    .description("Set default model (format: provider/model)")
    .action(async (providerModel: string) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
        const parts = providerModel.split("/");
        let provider: string | undefined;
        let model: string;
        if (parts.length >= 2) {
          provider = parts[0];
          model = parts.slice(1).join("/");
        } else {
          model = parts[0];
        }
        const update: any = { ...config, defaultModel: model };
        if (provider) update.defaultProvider = provider;
        await apiRequest("PUT", "/api/config/llm", update);
        console.log(c("green", `${ICONS.ok()} Default model set to ${c("cyan", providerModel)}`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to set model: ${err.message}`));
      }
    });

  models
    .command("scan")
    .description("Scan for available models via API")
    .action(async () => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data } = await apiRequest<{ providers: ProviderInfo[] }>("GET", "/api/system/providers");
        const providers = data.providers || [];
        console.log(section("Scanned Models"));
        if (providers.length === 0) {
          console.log(c("gray", "  No providers found. Configure API keys first."));
          return;
        }
        for (const p of providers) {
          const keyIcon = p.apiKeySet ? ICONS.ok() : ICONS.warn();
          console.log(`  ${keyIcon} ${c("cyan", p.name || p.id)} — ${p.models.length} model(s)`);
          for (const m of p.models) {
            console.log(`    ${ICONS.bullet()} ${m}`);
          }
          if (!p.apiKeySet) {
            console.log(c("gray", `    Run ${c("bold", `models auth add ${p.id}`)} to configure`));
          }
        }
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to scan: ${err.message}`));
      }
    });

  const auth = models.command("auth").description("Manage provider authentication");

  auth
    .command("add <provider>")
    .description("Add API key for a provider")
    .action(async (provider: string) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const apiKey = await prompt(`Enter API key for ${provider}: `);
        if (!apiKey) {
          console.log(c("red", `${ICONS.error()} No API key provided.`));
          return;
        }
        const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
        const update = { ...config };
        if (!update.providers) update.providers = {} as any;
        (update.providers as any)[provider] = { ...(update.providers as any)?.[provider], apiKey };
        await apiRequest("PUT", "/api/config/llm", update);
        console.log(c("green", `${ICONS.ok()} API key for ${c("cyan", provider)} saved.`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to add API key: ${err.message}`));
      }
    });

  const authOrder = auth.command("order").description("Manage authentication order");

  authOrder
    .command("get")
    .description("Show current auth order")
    .action(async () => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
        const order = config.providerOrder || [];
        if (order.length === 0) {
          console.log(c("gray", "  No custom auth order set (using default)."));
          return;
        }
        console.log("  Auth order:");
        order.forEach((p, i) => console.log(`    ${i + 1}. ${c("cyan", p)}`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to get auth order: ${err.message}`));
      }
    });

  authOrder
    .command("set <order...>")
    .description("Set auth order (space-separated provider IDs)")
    .action(async (order: string[]) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
        await apiRequest("PUT", "/api/config/llm", { ...config, providerOrder: order });
        console.log(c("green", `${ICONS.ok()} Auth order set: ${order.map(p => c("cyan", p)).join(" → ")}`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to set auth order: ${err.message}`));
      }
    });

  authOrder
    .command("clear")
    .description("Clear custom auth order")
    .action(async () => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
        const update = { ...config };
        delete update.providerOrder;
        await apiRequest("PUT", "/api/config/llm", update);
        console.log(c("green", `${ICONS.ok()} Auth order cleared (using default).`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to clear auth order: ${err.message}`));
      }
    });

  const fallbacks = models.command("fallbacks").description("Manage model fallback chain");

  fallbacks
    .command("list")
    .description("Show current fallback chain")
    .action(async () => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
        const chain = config.fallbacks || [];
        if (chain.length === 0) {
          console.log(c("gray", "  No fallback chain configured."));
          return;
        }
        console.log("  Fallback chain:");
        chain.forEach((m, i) => console.log(`    ${i + 1}. ${c("cyan", m)}`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to list fallbacks: ${err.message}`));
      }
    });

  fallbacks
    .command("add <model>")
    .description("Add a model to the fallback chain")
    .action(async (model: string) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
        const chain = [...(config.fallbacks || [])];
        if (chain.includes(model)) {
          console.log(c("yellow", `${ICONS.warn()} Model "${model}" already in fallback chain.`));
          return;
        }
        chain.push(model);
        await apiRequest("PUT", "/api/config/llm", { ...config, fallbacks: chain });
        console.log(c("green", `${ICONS.ok()} Fallback ${c("cyan", model)} added.`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to add fallback: ${err.message}`));
      }
    });

  fallbacks
    .command("remove <model>")
    .description("Remove a model from the fallback chain")
    .action(async (model: string) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
        const chain = [...(config.fallbacks || [])];
        const idx = chain.indexOf(model);
        if (idx === -1) {
          console.log(c("yellow", `${ICONS.warn()} Model "${model}" not in fallback chain.`));
          return;
        }
        chain.splice(idx, 1);
        await apiRequest("PUT", "/api/config/llm", { ...config, fallbacks: chain });
        console.log(c("green", `${ICONS.ok()} Fallback ${c("cyan", model)} removed.`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to remove fallback: ${err.message}`));
      }
    });

  fallbacks
    .command("clear")
    .description("Clear the fallback chain")
    .action(async () => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data: config } = await apiRequest<LlmConfig>("GET", "/api/config/llm");
        const update = { ...config };
        delete update.fallbacks;
        await apiRequest("PUT", "/api/config/llm", update);
        console.log(c("green", `${ICONS.ok()} Fallback chain cleared.`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to clear fallbacks: ${err.message}`));
      }
    });
}
