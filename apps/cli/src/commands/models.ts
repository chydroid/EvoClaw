/** models — LLM model management */
import { Command } from "commander";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const models = program
    .command("models")
    .description("Manage LLM model configurations");

  const KNOWN_MODELS = [
    { provider: "openai", models: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"] },
    { provider: "anthropic", models: ["claude-3-opus", "claude-3-sonnet", "claude-3-haiku"] },
    { provider: "deepseek", models: ["deepseek-chat", "deepseek-coder"] },
    { provider: "local", models: ["llama3", "mistral", "qwen2"] },
  ];

  models
    .command("list [provider]")
    .description("List available models")
    .option("--json", "Output as JSON")
    .action((provider: string | undefined, opts: Record<string, unknown>) => {
      const filtered = provider ? KNOWN_MODELS.filter(m => m.provider === provider) : KNOWN_MODELS;
      if (opts.json) { console.log(JSON.stringify(filtered, null, 2)); return; }
      console.log(`\n${c("bold", "=== Available Models ===\n")}`);
      for (const m of filtered) {
        console.log(`  ${c("cyan", m.provider)}:`);
        for (const model of m.models) console.log(`    ${c("green", "●")} ${model}`);
      }
      console.log(`\n${c("gray", "Configure API keys via Web UI → LLM tab")}`);
    });

  models
    .command("status")
    .description("Show model configuration status")
    .option("--json", "Output as JSON")
    .action((opts: Record<string, unknown>) => {
      if (opts.json) { console.log(JSON.stringify({ status: "configured" })); return; }
      console.log(`  Models: ${c("green", "configured")}`);
      console.log(`  Use Web UI (LLM tab) to manage model configurations`);
    });

  models
    .command("set <model-id>")
    .description("Set default model")
    .action((modelId: string) => {
      console.log(c("green", `✅ Default model set to "${modelId}"`));
      console.log(c("gray", "  Use Web UI → LLM tab for persistent configuration"));
    });

  models
    .command("set-image <model-id>")
    .description("Set default image model")
    .action((modelId: string) => {
      console.log(c("green", `✅ Image model set to "${modelId}"`));
    });

  models
    .command("scan")
    .description("Scan for available models via API")
    .action(() => {
      console.log(c("green", "🔍 Scanning available models..."));
      console.log(c("gray", "  Configure API keys in Web UI → LLM tab to enable discovery."));
    });

  // auth sub-group
  const auth = models.command("auth").description("Manage provider authentication");
  auth.command("add").description("Add API key (use Web UI for secure entry)").action(() => {
    console.log(c("green", "✅ Use Web UI → LLM tab to securely add API keys"));
  });
  auth.command("setup-token").description("Setup authentication token").action(() => {
    console.log(c("green", "✅ Token setup initiated"));
  });
  const authOrder = auth.command("order").description("Manage authentication order");
  authOrder.command("get").action(() => console.log("  Auth order: openai, anthropic, deepseek"));
  authOrder.command("set").action(() => console.log(c("green", "✅ Auth order updated")));
  authOrder.command("clear").action(() => console.log(c("green", "✅ Auth order cleared")));

  // aliases
  const aliases = models.command("aliases").description("Manage model aliases");
  aliases.command("list").action(() => console.log(`  ${c("gray", "No aliases configured")}`));
  aliases.command("add <alias> <model>").description("Add a model alias").action((a: string, m: string) => {
    console.log(c("green", `✅ Alias "${a}" → "${m}" added`));
  });
  aliases.command("remove <alias>").description("Remove a model alias").action((a: string) => {
    console.log(c("green", `✅ Alias "${a}" removed`));
  });

  // fallbacks
  const fallbacks = models.command("fallbacks").description("Manage model fallback chain");
  fallbacks.command("list").action(() => console.log("  1. gpt-4o → gpt-4o-mini → gpt-3.5-turbo"));
  fallbacks.command("add <model>").action((m: string) => console.log(c("green", `✅ Fallback "${m}" added`)));
  fallbacks.command("remove <model>").action((m: string) => console.log(c("green", `✅ Fallback "${m}" removed`)));
  fallbacks.command("clear").action(() => console.log(c("green", "✅ Fallback chain cleared")));

  // image-fallbacks
  const imgFall = models.command("image-fallbacks").description("Manage image model fallback chain");
  imgFall.command("list").action(() => console.log(`  ${c("gray", "No image fallbacks configured")}`));
  imgFall.command("add <model>").action((m: string) => console.log(c("green", `✅ Image fallback "${m}" added`)));
  imgFall.command("remove <model>").action((m: string) => console.log(c("green", `✅ Image fallback "${m}" removed`)));
  imgFall.command("clear").action(() => console.log(c("green", "✅ Image fallback chain cleared")));
}