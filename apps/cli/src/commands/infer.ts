import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired } from "../utils/api";

interface ChatResponse {
  reply?: string;
  message?: string;
  response?: string;
  sessionId?: string;
  thinking?: string;
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  [key: string]: unknown;
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const infer = program
    .command("infer")
    .alias("capability")
    .description("Send a prompt to LLM and display the response");

  infer
    .argument("<prompt>", "The prompt to send to the LLM")
    .option("--model <provider/model>", "Specify model (format: provider/model)")
    .option("--thinking <level>", "Thinking level (low/medium/high)")
    .option("--json", "Output as JSON")
    .action(async (prompt: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }

      try {
        const body: any = { message: prompt };

        if (opts.model) {
          const parts = (opts.model as string).split("/");
          if (parts.length >= 2) {
            body.provider = parts[0];
            body.model = parts.slice(1).join("/");
          } else {
            body.model = opts.model;
          }
        }

        if (opts.thinking) {
          const level = (opts.thinking as string).toLowerCase();
          if (!["low", "medium", "high"].includes(level)) {
            console.log(c("yellow", `${ICONS.warn()} Invalid thinking level "${opts.thinking}". Use: low, medium, high`));
            return;
          }
          body.thinking = level;
        }

        const { data, status } = await apiRequest<ChatResponse>("POST", "/api/chat", body);

        if (status >= 400) {
          console.log(c("red", `${ICONS.error()} Inference failed (HTTP ${status})`));
          if ((data as any).error) {
            console.log(c("red", `  ${(data as any).error}`));
          }
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        const reply = data.reply || data.message || data.response || JSON.stringify(data);

        if (data.sessionId) {
          console.log(c("gray", `Session: ${data.sessionId}`));
        }
        if (data.model) {
          console.log(c("gray", `Model: ${data.model}`));
        }
        if (data.thinking) {
          console.log(c("dim", `Thinking: ${data.thinking}`));
        }

        console.log();
        console.log(reply);

        if (data.usage) {
          console.log();
          console.log(c("gray", `Tokens — prompt: ${data.usage.promptTokens ?? "?"}  completion: ${data.usage.completionTokens ?? "?"}  total: ${data.usage.totalTokens ?? "?"}`));
        }
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Inference failed: ${err.message}`));
      }
    });
}
