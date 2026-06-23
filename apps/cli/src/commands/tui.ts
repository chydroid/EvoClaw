import * as readline from "readline";
import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired } from "../utils/api";

interface ChatResponse {
  reply?: string;
  message?: string;
  response?: string;
  sessionId?: string;
  model?: string;
  [key: string]: unknown;
}

interface SessionEntry {
  agentId: string;
  sessionId: string;
  turnCount: number;
  status: string;
  updatedAt: string;
}

async function startTui(opts: Record<string, unknown>): Promise<void> {
  const alive = await checkServer();
  if (!alive) { serverRequired(); return; }

  let sessionId = opts.session as string | undefined;

  if (sessionId) {
    try {
      const agentId = (opts.agent as string) || "default";
      await apiRequest("GET", `/api/sessions/${agentId}/${sessionId}`);
      console.log(c("green", `${ICONS.ok()} Resumed session: ${c("cyan", sessionId)}`));
    } catch (err: any) {
      console.log(c("yellow", `${ICONS.warn()} Session ${sessionId} not found. Starting new session.`));
      sessionId = undefined;
    }
  }

  if (!sessionId) {
    try {
      const { data } = await apiRequest<ChatResponse>("POST", "/api/chat", { message: "" });
      if (data.sessionId) {
        sessionId = data.sessionId;
        console.log(c("green", `${ICONS.ok()} New session: ${c("cyan", sessionId)}`));
      }
    } catch {
      console.log(c("gray", "  Starting without session tracking..."));
    }
  }

  console.log(section("EvoClaw TUI Chat"));
  console.log(c("gray", "  Type your message and press Enter. Type /quit or /exit to leave."));
  console.log(c("gray", "  Commands: /clear, /history, /sessions, /help"));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c("cyan", "you> "),
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "/quit" || input === "/exit") {
      console.log(c("gray", "Goodbye!"));
      rl.close();
      return;
    }

    if (input === "/clear") {
      console.clear();
      rl.prompt();
      return;
    }

    if (input === "/help") {
      console.log(c("gray", "  /quit, /exit  — Leave the chat"));
      console.log(c("gray", "  /clear        — Clear screen"));
      console.log(c("gray", "  /history      — Show session history"));
      console.log(c("gray", "  /sessions     — List sessions"));
      rl.prompt();
      return;
    }

    if (input === "/sessions") {
      try {
        const { data: rawData } = await apiRequest<SessionEntry[] | { sessions: SessionEntry[]; success?: boolean }>("GET", "/api/sessions");
        const sessions: SessionEntry[] = Array.isArray(rawData) ? rawData : (rawData?.sessions || []);
        if (sessions.length === 0) {
          console.log(c("gray", "  No sessions found."));
        } else {
          for (const s of sessions.slice(0, 10)) {
            const icon = s.status === "active" ? ICONS.ok() : ICONS.bullet();
            console.log(`  ${icon} ${c("cyan", s.sessionId)}  agent: ${s.agentId}  turns: ${s.turnCount}`);
          }
        }
      } catch (err: any) {
        console.log(c("red", `  ${ICONS.error()} ${err.message}`));
      }
      rl.prompt();
      return;
    }

    if (input === "/history") {
      if (!sessionId) {
        console.log(c("gray", "  No active session."));
        rl.prompt();
        return;
      }
      try {
        const agentId = (opts.agent as string) || "default";
        const { data } = await apiRequest<any>("GET", `/api/sessions/${agentId}/${sessionId}`);
        const messages = data.messages || data.history || [];
        if (messages.length === 0) {
          console.log(c("gray", "  No messages in this session."));
        } else {
          for (const msg of messages) {
            const role = msg.role || msg.sender || "unknown";
            const content = msg.content || msg.text || "";
            const roleColor: "cyan" | "green" | "gray" = role === "user" ? "cyan" : role === "assistant" || role === "agent" ? "green" : "gray";
            console.log(`  ${c(roleColor, `[${role}]`)} ${content.slice(0, 200)}`);
          }
        }
      } catch (err: any) {
        console.log(c("red", `  ${ICONS.error()} ${err.message}`));
      }
      rl.prompt();
      return;
    }

    try {
      const body: any = { message: input };
      if (sessionId) body.sessionId = sessionId;

      process.stdout.write(c("green", "agent> "));
      const { data, status } = await apiRequest<ChatResponse>("POST", "/api/chat", body);

      if (status >= 400) {
        console.log(c("red", `${ICONS.error()} Request failed (HTTP ${status})`));
        if ((data as any).error) {
          console.log(c("red", `  ${(data as any).error}`));
        }
      } else {
        const reply = data.reply || data.message || data.response || JSON.stringify(data);
        if (data.sessionId && !sessionId) {
          sessionId = data.sessionId;
        }
        console.log(reply);
      }
    } catch (err: any) {
      console.log(c("red", `${ICONS.error()} ${err.message}`));
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const tui = program
    .command("tui")
    .alias("chat")
    .alias("terminal")
    .description("Interactive terminal chat interface");

  tui
    .option("--local", "Local mode (default)")
    .option("--session <id>", "Resume an existing session")
    .option("--agent <id>", "Agent ID for session (default: default)")
    .action(async (opts: Record<string, unknown>) => {
      await startTui(opts);
    });
}
