/** chat — Interactive chat REPL and one-shot messaging */
import * as readline from "readline";
import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired } from "../utils/api";

interface ChatResponse {
  reply?: string;
  output?: string;
  text?: string;
  message?: string;
  sessionId?: string;
  tokensUsed?: number;
  model?: string;
}

async function sendOneShot(
  message: string,
  opts: Record<string, unknown>
): Promise<void> {
  const sessionId = (opts.sessionId as string) || "cli-default";
  const body: Record<string, unknown> = { message, sessionId };
  if (opts.model) body.model = opts.model;

  try {
    const r = await apiRequest<ChatResponse>("POST", "/api/chat", body);
    const reply = r.data.reply || r.data.output || r.data.text || r.data.message || JSON.stringify(r.data);
    if (opts.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    console.log(`\n${c("cyan", `${ICONS.arrow()} Agent:`)} ${reply}`);
    if (r.data.tokensUsed) console.log(c("gray", `  Tokens: ${r.data.tokensUsed}`));
    if (r.data.model) console.log(c("gray", `  Model: ${r.data.model}`));
    console.log();
  } catch (err) {
    console.log(c("red", `${ICONS.error()} Chat request failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

async function chatREPL(opts: Record<string, unknown>): Promise<void> {
  const sessionId = (opts.sessionId as string) || `cli-${Date.now()}`;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c("cyan", "you> "),
  });

  console.log(section("EvoClaw Interactive Chat"));
  console.log(c("gray", `  Session: ${sessionId}`));
  console.log(c("gray", `  Type your message and press Enter. Commands: /exit, /clear, /model <id>, /help`));
  console.log();

  let model: string | undefined = opts.model as string | undefined;
  let turnCount = 0;

  rl.prompt();

  rl.on("line", async (input: string) => {
    const line = input.trim();
    if (!line) { rl.prompt(); return; }

    // Slash commands
    if (line.startsWith("/")) {
      const [cmd, ...args] = line.slice(1).split(/\s+/);
      switch (cmd) {
        case "exit":
        case "quit":
          console.log(c("gray", `  Session ended. ${turnCount} turn(s).`));
          rl.close();
          process.exit(0);
          break;
        case "clear":
          console.log("\x1b[2J\x1b[H");
          break;
        case "model":
          if (args.length > 0) {
            model = args.join(" ");
            console.log(c("green", `  ${ICONS.ok()} Model set to: ${c("cyan", model)}`));
          } else {
            console.log(c("gray", `  Current model: ${model || "default"}`));
          }
          break;
        case "help":
          console.log(c("gray", "  /exit     — Exit chat"));
          console.log(c("gray", "  /clear    — Clear screen"));
          console.log(c("gray", "  /model <id> — Set model for this session"));
          console.log(c("gray", "  /help     — Show this help"));
          break;
        default:
          console.log(c("yellow", `  Unknown command: /${cmd}`));
      }
      rl.prompt();
      return;
    }

    // Send message
    const body: Record<string, unknown> = { message: line, sessionId };
    if (model) body.model = model;

    process.stdout.write(c("gray", "  thinking...\r") + "\n");
    try {
      const r = await apiRequest<ChatResponse>("POST", "/api/chat", body);
      const reply = r.data.reply || r.data.output || r.data.text || r.data.message || JSON.stringify(r.data);
      turnCount++;
      process.stdout.write(" ".repeat(40) + "\r\n");
      console.log(`${c("green", "agent>")} ${reply}`);
      if (r.data.tokensUsed) {
        console.log(c("gray", `       tokens: ${r.data.tokensUsed}${r.data.model ? `  model: ${r.data.model}` : ""}`));
      }
    } catch (err) {
      process.stdout.write(" ".repeat(40) + "\r\n");
      console.log(c("red", `  ${ICONS.error()} ${err instanceof Error ? err.message : String(err)}`));
    }
    console.log();
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

export function register(program: Command, _shared: (cmd: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("chat")
    .description("Interactive chat with the agent (REPL mode) or one-shot message")
    .argument("[message]", "One-shot message (omit to enter interactive REPL)")
    .option("-m, --model <id>", "Model to use")
    .option("-s, --session-id <id>", "Session ID")
    .option("--json", "Output as JSON (one-shot mode only)")
    .action(async (messageArg: string | undefined, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }

      if (messageArg) {
        await sendOneShot(messageArg, opts);
      } else {
        await chatREPL(opts);
      }
    });
}
