/** agent — Run agent with a message */
import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("agent")
    .description("Send a message to the Agent and get a response")
    .option("-m, --message <text>", "Message to send to the agent")
    .option("--to <dest>", "Target session or destination")
    .option("--model <id>", "Model to use for this request")
    .option("--deliver", "Deliver via active channel")
    .option("--session-id <id>", "Session ID to use")
    .option("--json", "Output as JSON")
    .argument("[message]", "Message text (alternative to -m)")
    .action(async (messageArg: string | undefined, opts: Record<string, unknown>) => {
      const message = (opts.message || opts.m || messageArg) as string | undefined;
      if (!message) {
        console.log(c("red", "❌ Usage: EvoClaw agent -m <message> [--model <id>] [--json]"));
        console.log(c("gray", "  Example: EvoClaw agent -m \"What is the weather?\""));
        return;
      }

      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("red", "❌ Server not running. Start with: EvoClaw gateway start"));
        return;
      }

      try {
        const body: Record<string, unknown> = { message, sessionId: opts.sessionId || opts.to || "cli-default" };
        if (opts.model) body.model = opts.model;
        const r = await apiRequest<Record<string, unknown>>("POST", "/api/chat", body);

        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
        } else {
          console.log(`\n${c("cyan", "Agent Response:")}`);
          console.log(`  ${r.data.reply || r.data.output || JSON.stringify(r.data)}`);
          if (r.data.tokensUsed) console.log(c("gray", `  Tokens: ${r.data.tokensUsed}`));
          console.log();
        }
      } catch (err) {
        console.log(c("red", `❌ Agent request failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
}