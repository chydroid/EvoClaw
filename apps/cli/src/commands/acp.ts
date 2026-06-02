import { Command } from "commander";
import * as readline from "readline";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired, DEFAULT_PORT, VERSION } from "../utils/api";

interface ChatResponse {
  reply?: string;
  sessionId?: string;
  error?: string;
}

interface SessionEntry {
  agentId: string;
  sessionId: string;
  turnCount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

async function startInteractiveSession(sessionId: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c("cyan", "acp> "),
  });

  console.log(c("gray", `  Session: ${sessionId}`));
  console.log(c("gray", "  Type your message and press Enter. Type /quit to exit, /help for commands."));
  console.log();

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "/quit" || input === "/exit") {
      console.log(c("gray", "  Session ended."));
      rl.close();
      return;
    }

    if (input === "/help") {
      console.log(c("gray", "  /quit, /exit  — End session"));
      console.log(c("gray", "  /help         — Show this help"));
      console.log(c("gray", "  /status       — Show session status"));
      rl.prompt();
      return;
    }

    if (input === "/status") {
      try {
        const { data } = await apiRequest<Record<string, unknown>>("GET", `/api/sessions/default/${sessionId}`);
        console.log(c("gray", `  Turns: ${data.turnCount || 0}, Status: ${data.status || "active"}`));
      } catch {
        console.log(c("yellow", "  Could not fetch session status"));
      }
      rl.prompt();
      return;
    }

    try {
      const { data, status } = await apiRequest<ChatResponse>("POST", "/api/chat", {
        message: input,
        sessionId,
        agentId: "default",
      });

      if (status === 200 && data?.reply) {
        console.log(`${c("green", "agent>")} ${data.reply}`);
      } else if (data?.error) {
        console.log(c("red", `  Error: ${data.error}`));
      } else {
        console.log(c("yellow", "  No response received"));
      }
    } catch (err) {
      console.log(c("red", `  ${ICONS.error()} ${err instanceof Error ? err.message : String(err)}`));
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("acp")
    .description("Agent Communication Protocol bridge for IDE integration")
    .option("--session <id>", "Connect to an existing session")
    .option("--spawn", "Create a new session")
    .option("--list", "List available ACP sessions")
    .option("--reset-session", "Reset session on first connection")
    .action(async (opts: Record<string, unknown>) => {
      console.log(section("ACP Bridge"));

      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. ACP bridge requires active Gateway.`));
        console.log(c("gray", "  Start with: EvoClaw gateway start"));
        return;
      }

      if (opts.list) {
        try {
          const { data } = await apiRequest<Record<string, unknown>>("GET", "/api/sessions");
          const sessions = ((data as Record<string, unknown>)?.sessions || []) as SessionEntry[];

          console.log(c("bold", "Available Sessions:"));
          if (sessions.length === 0) {
            console.log(c("gray", "  No sessions found. Use --spawn to create one."));
          } else {
            for (const s of sessions) {
              const statusIcon = s.status === "active" ? ICONS.ok() : ICONS.bullet();
              console.log(`  ${statusIcon} ${c("cyan", s.sessionId)}  agent: ${s.agentId}  turns: ${s.turnCount}  status: ${s.status}`);
              console.log(c("gray", `     created: ${s.createdAt}  updated: ${s.updatedAt}`));
            }
          }
        } catch (err) {
          console.log(c("red", `${ICONS.error()} Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`));
        }
        return;
      }

      let sessionId = opts.session as string | undefined;

      if (opts.spawn) {
        try {
          const { data, status } = await apiRequest<Record<string, unknown>>("POST", "/api/sessions", {
            agentId: "default",
          });
          const newSession = data?.session as Record<string, unknown> | undefined;
          sessionId = (newSession?.sessionId as string) || (data?.sessionId as string) || sessionId;
          console.log(c("green", `${ICONS.ok()} New session created: ${c("cyan", sessionId || "unknown")}`));
        } catch (err) {
          console.log(c("red", `${ICONS.error()} Failed to create session: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
      }

      if (!sessionId) {
        try {
          const { data } = await apiRequest<Record<string, unknown>>("GET", "/api/sessions");
          const sessions = ((data as Record<string, unknown>)?.sessions || []) as SessionEntry[];
          const activeSessions = sessions.filter((s: SessionEntry) => s.status === "active");

          if (activeSessions.length > 0) {
            sessionId = activeSessions[0].sessionId;
            console.log(c("gray", `  Connecting to existing session: ${sessionId}`));
          } else {
            try {
              const { data: newData } = await apiRequest<Record<string, unknown>>("POST", "/api/sessions", {
                agentId: "default",
              });
              const newSession = newData?.session as Record<string, unknown> | undefined;
              sessionId = (newSession?.sessionId as string) || (newData?.sessionId as string) || undefined;
              if (sessionId) {
                console.log(c("green", `${ICONS.ok()} Created new session: ${c("cyan", sessionId)}`));
              }
            } catch {
              sessionId = "default";
              console.log(c("gray", `  Using default session`));
            }
          }
        } catch {
          sessionId = "default";
          console.log(c("gray", `  Using default session`));
        }
      }

      console.log(c("green", `${ICONS.ok()} ACP bridge connected`));
      console.log(c("gray", `  URL: ws://localhost:${DEFAULT_PORT}/acp`));
      console.log(c("gray", `  Session: ${sessionId}`));
      if (opts.resetSession) {
        console.log(c("gray", "  Session will be reset on first connection"));
      }

      console.log();
      console.log(c("gray", "  Protocol bridge for IDE integration (VSCode, Cursor, etc.)"));
      console.log(c("gray", "  Entering interactive mode..."));
      console.log();

      await startInteractiveSession(sessionId || "default");
    });
}
