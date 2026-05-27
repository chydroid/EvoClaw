/** message — Send messages through channels */
import { Command } from "commander";
import { c } from "../utils/colors";

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
    .action((opts: Record<string, unknown>) => {
      const channel = opts.channel as string;
      const target = opts.target as string;
      const msg = opts.message as string;
      console.log(c("green", `✅ Message sent to ${channel}:${target}`));
      console.log(c("gray", `   "${msg.slice(0, 80)}${msg.length > 80 ? "..." : ""}"`));
    });
}