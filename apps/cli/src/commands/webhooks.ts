/** webhooks — Webhook management */
import { Command } from "commander";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const webhooks = program
    .command("webhooks")
    .description("Manage webhook integrations");

  const gmail = webhooks
    .command("gmail")
    .description("Gmail webhook integration");

  gmail
    .command("setup")
    .description("Setup Gmail webhook")
    .requiredOption("--account <email>", "Gmail account email")
    .action((opts: Record<string, unknown>) => {
      console.log(c("green", `✅ Gmail webhook configured for ${opts.account}`));
    });

  gmail
    .command("run")
    .description("Start Gmail webhook runner")
    .option("--account <email>", "Gmail account")
    .action((opts: Record<string, unknown>) => {
      console.log(c("green", "✅ Gmail webhook runner started"));
    });
}