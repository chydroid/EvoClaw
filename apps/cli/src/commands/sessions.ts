import { Command } from "commander";
import { c, ICONS, divider, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired } from "../utils/api";

interface SessionEntry {
  agentId: string;
  sessionId: string;
  turnCount: number;
  tokenEstimate: number;
  compactionCount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface AggregatedSession {
  id: string;
  messageCount: number;
  lastActive: string;
  compactionCount: number;
  tokensUsed: number;
}

async function listSessions(opts: Record<string, unknown>): Promise<void> {
  const alive = await checkServer();
  if (!alive) { serverRequired(); return; }

  try {
    if (opts.allAgents) {
      const { data } = await apiRequest<AggregatedSession[]>("GET", "/api/system/sessions");
      if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
      console.log(section("Sessions (All Agents)"));
      if (!data || data.length === 0) {
        console.log(c("gray", "  No sessions found."));
        return;
      }
      for (const s of data) {
        console.log(`  ${ICONS.bullet()} ${c("cyan", s.id)}  messages: ${s.messageCount}  tokens: ${s.tokensUsed}  last: ${s.lastActive}`);
      }
      return;
    }

    const { data } = await apiRequest<SessionEntry[]>("GET", "/api/sessions");
    let sessions = data || [];

    if (opts.agent) {
      sessions = sessions.filter(s => s.agentId === opts.agent);
    }

    if (opts.active) {
      const minutes = parseInt(opts.active as string, 10);
      const cutoff = Date.now() - minutes * 60 * 1000;
      sessions = sessions.filter(s => new Date(s.updatedAt).getTime() >= cutoff);
    }

    if (opts.json) { console.log(JSON.stringify(sessions, null, 2)); return; }

    if (opts.cleanup) {
      const expired = sessions.filter(s => s.status === "expired" || s.status === "inactive");
      if (opts.dryRun) {
        console.log(c("yellow", `${ICONS.warn()} Dry run — would clean up ${expired.length} expired session(s):`));
        for (const s of expired) {
          console.log(c("gray", `  ${s.agentId}/${s.sessionId}  status: ${s.status}`));
        }
        return;
      }
      let deleted = 0;
      for (const s of expired) {
        try {
          await apiRequest("DELETE", `/api/sessions/${s.agentId}/${s.sessionId}`);
          deleted++;
        } catch {
          console.log(c("red", `  ${ICONS.error()} Failed to delete ${s.sessionId}`));
        }
      }
      console.log(c("green", `${ICONS.ok()} Cleaned up ${deleted} expired session(s)`));
      return;
    }

    console.log(section("Sessions"));
    if (sessions.length === 0) {
      console.log(c("gray", "  No sessions found."));
      return;
    }
    for (const s of sessions) {
      const statusIcon = s.status === "active" ? ICONS.ok() : s.status === "expired" ? ICONS.warn() : ICONS.bullet();
      console.log(`  ${statusIcon} ${c("cyan", s.sessionId)}  agent: ${s.agentId}  turns: ${s.turnCount}  tokens: ${s.tokenEstimate}  status: ${s.status}`);
      console.log(c("gray", `     created: ${s.createdAt}  updated: ${s.updatedAt}`));
    }
  } catch (err: any) {
    console.log(c("red", `${ICONS.error()} Failed to list sessions: ${err.message}`));
  }
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const cmd = program
    .command("sessions")
    .description("Manage chat sessions")
    .option("--cleanup", "Clean up expired sessions")
    .option("--dry-run", "Preview cleanup without executing")
    .option("--active <minutes>", "Show sessions active within N minutes")
    .option("--agent <id>", "Filter sessions by agent ID")
    .option("--all-agents", "Show sessions across all agents")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      await listSessions(opts);
    });

  cmd
    .command("list")
    .description("List all sessions")
    .option("--active <minutes>", "Show sessions active within N minutes")
    .option("--agent <id>", "Filter sessions by agent ID")
    .option("--all-agents", "Show sessions across all agents")
    .option("--json", "Output as JSON")
    .option("--cleanup", "Clean up expired sessions")
    .option("--dry-run", "Preview cleanup without executing")
    .action(async (opts: Record<string, unknown>) => {
      await listSessions(opts);
    });

  cmd
    .command("show <sessionId>")
    .description("Show session details")
    .option("--agent <id>", "Agent ID (default: default)")
    .option("--json", "Output as JSON")
    .action(async (sessionId: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      const agentId = (opts.agent as string) || "default";
      try {
        const { data } = await apiRequest<SessionEntry>("GET", `/api/sessions/${agentId}/${sessionId}`);
        if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
        console.log(section(`Session: ${sessionId}`));
        console.log(`  ${ICONS.arrow()} Agent:         ${c("cyan", data.agentId)}`);
        console.log(`  ${ICONS.arrow()} Status:         ${data.status}`);
        console.log(`  ${ICONS.arrow()} Turns:          ${data.turnCount}`);
        console.log(`  ${ICONS.arrow()} Tokens:         ${data.tokenEstimate}`);
        console.log(`  ${ICONS.arrow()} Compactions:    ${data.compactionCount}`);
        console.log(`  ${ICONS.arrow()} Created:        ${data.createdAt}`);
        console.log(`  ${ICONS.arrow()} Updated:        ${data.updatedAt}`);
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to get session: ${err.message}`));
      }
    });

  cmd
    .command("delete <sessionId>")
    .description("Delete a session")
    .option("--agent <id>", "Agent ID (default: default)")
    .action(async (sessionId: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      const agentId = (opts.agent as string) || "default";
      try {
        await apiRequest("DELETE", `/api/sessions/${agentId}/${sessionId}`);
        console.log(c("green", `${ICONS.ok()} Session ${c("cyan", sessionId)} deleted (agent: ${agentId})`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to delete session: ${err.message}`));
      }
    });

  cmd
    .command("history <sessionId>")
    .description("Show session message history")
    .option("--agent <id>", "Agent ID (default: default)")
    .option("--json", "Output as JSON")
    .action(async (sessionId: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      const agentId = (opts.agent as string) || "default";
      try {
        const { data } = await apiRequest<any>("GET", `/api/sessions/${agentId}/${sessionId}`);
        if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
        console.log(section(`History: ${sessionId}`));
        const messages = data.messages || data.history || [];
        if (messages.length === 0) {
          console.log(c("gray", "  No messages in this session."));
          return;
        }
        for (const msg of messages) {
          const role = msg.role || msg.sender || "unknown";
          const content = msg.content || msg.text || "";
          const roleColor = role === "user" ? "cyan" : role === "assistant" || role === "agent" ? "green" : "gray";
          console.log(`  ${c(roleColor as any, `[${role}]`)} ${content.slice(0, 200)}`);
        }
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to get history: ${err.message}`));
      }
    });
}
