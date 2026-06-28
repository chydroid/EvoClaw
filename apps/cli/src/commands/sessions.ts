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

    const { data: rawData } = await apiRequest<SessionEntry[] | { sessions: SessionEntry[]; success?: boolean }>("GET", "/api/sessions");
    let sessions: SessionEntry[] = Array.isArray(rawData) ? rawData : (rawData?.sessions || []);

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

  // ── sessions cleanup ────────────────────────────────────────────
  // openclaw 兼容：显式 cleanup 子命令（除了顶层 --cleanup flag）
  cmd
    .command("cleanup")
    .description("Clean up expired or inactive sessions")
    .option("--agent <id>", "Only clean up sessions for a specific agent")
    .option("--status <status>", "Clean up sessions with this status (default: expired|inactive)")
    .option("--dry-run", "Preview without deleting")
    .option("--force", "Skip confirmation prompt")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const { data: rawData } = await apiRequest<SessionEntry[] | { sessions: SessionEntry[] }>("GET", "/api/sessions");
        let sessions: SessionEntry[] = Array.isArray(rawData) ? rawData : (rawData?.sessions || []);
        if (opts.agent) sessions = sessions.filter((s) => s.agentId === opts.agent);

        const statusFilter = opts.status ? String(opts.status) : null;
        const expired = statusFilter
          ? sessions.filter((s) => s.status === statusFilter)
          : sessions.filter((s) => s.status === "expired" || s.status === "inactive");

        if (opts.dryRun) {
          if (opts.json) {
            console.log(JSON.stringify({ dryRun: true, count: expired.length, sessions: expired }, null, 2));
            return;
          }
          console.log(c("yellow", `${ICONS.warn()} Dry run — would clean up ${expired.length} session(s):`));
          for (const s of expired) {
            console.log(c("gray", `  ${s.agentId}/${s.sessionId}  status: ${s.status}`));
          }
          return;
        }

        if (!opts.force && expired.length > 0) {
          const { confirmPrompt } = require("../utils/shared");
          const ok = await confirmPrompt(`Delete ${expired.length} session(s)?`, false);
          if (!ok) {
            console.log(c("gray", "Cleanup cancelled."));
            return;
          }
        }

        const failed: Array<{ id: string; reason: string }> = [];
        let deleted = 0;
        for (const s of expired) {
          try {
            await apiRequest("DELETE", `/api/sessions/${s.agentId}/${s.sessionId}`);
            deleted++;
          } catch (err) {
            failed.push({
              id: `${s.agentId}/${s.sessionId}`,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (opts.json) {
          console.log(JSON.stringify({ deleted, failed, total: expired.length }, null, 2));
          return;
        }
        console.log(c("green", `${ICONS.ok()} Cleaned up ${deleted}/${expired.length} session(s)`));
        if (failed.length > 0) {
          console.log(c("red", `${ICONS.error()} ${failed.length} failed:`));
          for (const f of failed) console.log(c("gray", `  ${f.id}: ${f.reason}`));
        }
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Cleanup failed: ${err.message}`));
      }
    });

  // ── sessions tail ───────────────────────────────────────────────
  // 实时跟踪会话最新消息（轮询实现，openclaw 风格）
  cmd
    .command("tail <sessionId>")
    .description("Tail the latest messages of a session (polls every N seconds)")
    .option("--agent <id>", "Agent ID (default: default)")
    .option("--n <count>", "Number of recent messages to show", "10")
    .option("--interval <sec>", "Poll interval in seconds", "3")
    .option("--once", "Print once and exit (no polling)")
    .action(async (sessionId: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      const agentId = (opts.agent as string) || "default";
      const n = parseInt(String(opts.n || "10"), 10);
      const intervalSec = parseInt(String(opts.interval || "3"), 10);
      const once = Boolean(opts.once);

      let lastSig: string = "";
      const poll = async (): Promise<void> => {
        try {
          const { data } = await apiRequest<any>("GET", `/api/sessions/${agentId}/${sessionId}`);
          const messages = data.messages || data.history || [];
          const tail = messages.slice(-n);
          const sig = JSON.stringify(tail);
          if (sig === lastSig) return;
          lastSig = sig;
          console.log(c("gray", `— ${new Date().toLocaleTimeString()} —`));
          for (const msg of tail) {
            const role = msg.role || msg.sender || "unknown";
            const content = msg.content || msg.text || "";
            const roleColor = role === "user" ? "cyan" : role === "assistant" || role === "agent" ? "green" : "gray";
            console.log(`  ${c(roleColor as any, `[${role}]`)} ${content.slice(0, 200)}`);
          }
          console.log();
        } catch (err) {
          process.stderr.write(c("red", `tail error: ${err instanceof Error ? err.message : String(err)}\n`));
        }
      };

      await poll();
      if (once) return;

      console.log(c("gray", `Tailing ${sessionId} (Ctrl+C to stop, interval=${intervalSec}s)…\n`));
      const timer = setInterval(poll, Math.max(1, intervalSec) * 1000);
      // 允许进程在 ctrl+c 时立即退出
      timer.unref?.();
      // 让 setInterval 持续运行
      process.stdin.resume();
      process.on("SIGINT", () => {
        clearInterval(timer);
        process.stdin.pause();
        console.log(c("gray", "\nStopped."));
        process.exit(0);
      });
      // 防止 Node 退出
      setInterval(() => {}, 1 << 30).unref?.();
    });

  // ── sessions export-trajectory ──────────────────────────────────
  // 导出会话轨迹（包含消息、agent 状态、token 等完整信息）
  cmd
    .command("export-trajectory <sessionId>")
    .description("Export full session trajectory as JSON")
    .option("--agent <id>", "Agent ID (default: default)")
    .option("--output <file>", "Write to file instead of stdout")
    .option("--include-metadata", "Include internal metadata fields")
    .action(async (sessionId: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      const agentId = (opts.agent as string) || "default";
      try {
        const { data } = await apiRequest<any>("GET", `/api/sessions/${agentId}/${sessionId}`);
        const trajectory: Record<string, unknown> = {
          sessionId,
          agentId,
          exportedAt: new Date().toISOString(),
          version: 1,
          session: data,
        };
        if (!opts.includeMetadata) {
          // 移除内部 metadata
          if (trajectory.session && typeof trajectory.session === "object") {
            const s = trajectory.session as Record<string, unknown>;
            delete s.metadata;
            delete s.internal;
          }
        }
        const json = JSON.stringify(trajectory, null, 2);
        if (opts.output) {
          const fs = require("fs");
          const path = require("path");
          const outPath = path.resolve(String(opts.output));
          fs.writeFileSync(outPath, json, "utf-8");
          console.log(c("green", `${ICONS.ok()} Trajectory exported to ${outPath} (${json.length} bytes)`));
        } else {
          console.log(json);
        }
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Export failed: ${err.message}`));
      }
    });
}
