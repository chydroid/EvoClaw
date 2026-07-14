import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { atomicWriteFileSync } from "@evoclaw/core";
import { c, ICONS, section } from "../utils/colors";
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

interface SessionDetail {
  agentId: string;
  sessionId: string;
  turnCount: number;
  tokenEstimate: number;
  compactionCount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  messages?: any[];
  history?: any[];
  [key: string]: unknown;
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const transcripts = program
    .command("transcripts")
    .description("Manage session transcripts (OpenClaw compatible)");

  transcripts
    .command("list")
    .description("List all session transcripts")
    .option("--agent <id>", "Filter by agent ID")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }

      try {
        const { data: rawData } = await apiRequest<SessionEntry[] | { sessions: SessionEntry[]; success?: boolean }>("GET", "/api/sessions");
        let sessions: SessionEntry[] = Array.isArray(rawData) ? rawData : (rawData?.sessions || []);

        if (opts.agent) {
          sessions = sessions.filter(s => s.agentId === opts.agent);
        }

        if (opts.json) {
          console.log(JSON.stringify(sessions, null, 2));
          return;
        }

        console.log(section("Session Transcripts"));
        if (sessions.length === 0) {
          console.log(c("gray", "  No transcripts found."));
          return;
        }

        for (const s of sessions) {
          const statusIcon = s.status === "active" ? ICONS.ok() : s.status === "expired" ? ICONS.warn() : ICONS.bullet();
          console.log(`  ${statusIcon} ${c("cyan", s.sessionId)}  agent: ${s.agentId}  turns: ${s.turnCount}  tokens: ${s.tokenEstimate}`);
          console.log(c("gray", `     created: ${s.createdAt}  updated: ${s.updatedAt}`));
        }
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to list transcripts: ${err.message}`));
      }
    });

  transcripts
    .command("show <sessionId>")
    .description("Show full session transcript")
    .option("--agent <id>", "Agent ID (default: default)")
    .option("--json", "Output as JSON")
    .action(async (sessionId: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }

      const agentId = (opts.agent as string) || "default";

      try {
        const { data } = await apiRequest<SessionDetail>("GET", `/api/sessions/${agentId}/${sessionId}`);

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        console.log(section(`Transcript: ${sessionId}`));
        console.log(`  ${ICONS.arrow()} Agent:         ${c("cyan", data.agentId)}`);
        console.log(`  ${ICONS.arrow()} Status:         ${data.status}`);
        console.log(`  ${ICONS.arrow()} Turns:          ${data.turnCount}`);
        console.log(`  ${ICONS.arrow()} Tokens:         ${data.tokenEstimate}`);
        console.log(`  ${ICONS.arrow()} Compactions:    ${data.compactionCount}`);
        console.log(`  ${ICONS.arrow()} Created:        ${data.createdAt}`);
        console.log(`  ${ICONS.arrow()} Updated:        ${data.updatedAt}`);
        console.log();

        const messages = data.messages || data.history || [];
        if (messages.length === 0) {
          console.log(c("gray", "  No messages in this transcript."));
          return;
        }

        for (const msg of messages) {
          const role = msg.role || msg.sender || "unknown";
          const content = msg.content || msg.text || "";
          const roleColor: "cyan" | "green" | "gray" = role === "user" ? "cyan" : role === "assistant" || role === "agent" ? "green" : "gray";
          console.log(`  ${c(roleColor, `[${role}]`)} ${content}`);
        }
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to show transcript: ${err.message}`));
      }
    });

  transcripts
    .command("export <sessionId>")
    .description("Export session transcript as JSON file")
    .option("--agent <id>", "Agent ID (default: default)")
    .option("--output <path>", "Output file path")
    .action(async (sessionId: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }

      const agentId = (opts.agent as string) || "default";

      try {
        const { data } = await apiRequest<SessionDetail>("GET", `/api/sessions/${agentId}/${sessionId}`);

        const outputPath = (opts.output as string) || `transcript-${sessionId}.json`;
        const resolvedOutputPath = path.resolve(outputPath);
        const allowedBase = path.resolve(process.cwd());
        const withinBase = (p: string, base: string) => p === base || p.startsWith(base + path.sep);
        if (!withinBase(resolvedOutputPath, allowedBase)) {
          throw new Error(`Output path must be within ${allowedBase}`);
        }
        let realOutputPath: string;
        try {
          realOutputPath = fs.realpathSync(resolvedOutputPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            realOutputPath = resolvedOutputPath;
          } else {
            throw err;
          }
        }
        if (!withinBase(realOutputPath, allowedBase)) {
          throw new Error(`Output path must be within ${allowedBase}`);
        }

        const exportData = {
          ...data,
          exportedAt: new Date().toISOString(),
          sessionId,
          agentId,
        };

        atomicWriteFileSync(resolvedOutputPath, JSON.stringify(exportData, null, 2), { encoding: "utf-8" });
        console.log(c("green", `${ICONS.ok()} Transcript exported to ${c("cyan", resolvedOutputPath)}`));
      } catch (err: any) {
        console.log(c("red", `${ICONS.error()} Failed to export transcript: ${err.message}`));
      }
    });
}
