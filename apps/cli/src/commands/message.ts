import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer, serverRequired } from "../utils/api";

interface ChatResponse {
  reply?: string;
  message?: string;
  response?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const cmd = program
    .command("message")
    .description("Send messages through communication channels");

  cmd
    .command("send")
    .description("Send a message to a channel")
    .requiredOption("-c, --channel <channel>", "Channel name (e.g. whatsapp, telegram)")
    .requiredOption("-t, --target <target>", "Target recipient (number, ID, or group)")
    .requiredOption("-m, --message <text>", "Message content")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }

      const channel = opts.channel as string;
      const target = opts.target as string;
      const message = opts.message as string;

      try {
        const { data, status } = await apiRequest<ChatResponse>("POST", "/api/chat", {
          message,
          channel,
          target,
        });

        if (status >= 400) {
          console.log(c("red", `${ICONS.error()} Failed to send message (HTTP ${status})`));
          if (data && (data as any).error) {
            console.log(c("red", `  ${(data as any).error}`));
          }
          return;
        }

        console.log(c("green", `${ICONS.ok()} Message sent to ${c("cyan", channel)}:${c("cyan", target)}`));
        console.log(c("gray", `   "${message.slice(0, 80)}${message.length > 80 ? "..." : ""}"`));

        const reply = data.reply || data.message || data.response;
        if (reply) {
          console.log();
          console.log(`  ${ICONS.arrow()} ${c("bold", "Response:")}`);
          console.log(`  ${reply}`);
        }
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to send message: ${err.message}`));
      }
    });

  cmd
    .command("chat")
    .description("Chat directly with the agent")
    .requiredOption("-m, --message <text>", "Message content")
    .option("--thinking <level>", "Thinking level (e.g. low, medium, high)")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }

      const message = opts.message as string;
      const thinking = opts.thinking as string | undefined;

      try {
        const body: any = { message };
        if (thinking) body.thinking = thinking;

        const { data, status } = await apiRequest<ChatResponse>("POST", "/api/chat", body);

        if (status >= 400) {
          console.log(c("red", `${ICONS.error()} Chat request failed (HTTP ${status})`));
          if (data && (data as any).error) {
            console.log(c("red", `  ${(data as any).error}`));
          }
          return;
        }

        const reply = data.reply || data.message || data.response || JSON.stringify(data);
        if (data.sessionId) {
          console.log(c("gray", `Session: ${data.sessionId}`));
        }
        console.log();
        console.log(`  ${c("green", "Agent:")}`, reply);
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Chat failed: ${err.message}`));
      }
    });
}
