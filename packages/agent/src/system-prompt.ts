export type PromptMode = "full" | "minimal" | "none";

export interface SystemPromptParams {
  promptMode: PromptMode;
  personaName: string;
  personaTitle: string;
  masterTerm: string;
  personaTone: string;
  registeredToolNames: string[];
  skillsPrompt?: string;
  workspacePath?: string;
  userTimezone?: string;
  timeFormat?: "12" | "24";
  docsPath?: string;
  sourceRepoUrl?: string;
  sandboxMode?: boolean;
  sandboxWorkspaceRoot?: string;
  ownerNumbers?: string[];
  ownerDisplayMode?: "raw" | "hash";
  ownerDisplaySecret?: string;
  bootstrapFiles?: Array<{ path: string; content: string }>;
  hasSessionsSpawn?: boolean;
  hasSubagents?: boolean;
  delegationMode?: "suggest" | "prefer";
  heartbeatEnabled?: boolean;
  heartbeatPrompt?: string;
  repoRoot?: string;
  hostInfo?: { os: string; arch: string; nodeVersion: string };
  appendSystemContext?: string;
  prependSystemContext?: string;
}

export function buildAgentSystemPrompt(params: SystemPromptParams): string {
  if (params.promptMode === "none") {
    return `You are ${params.personaName}, the ${params.personaTitle}.`;
  }

  const isMinimal = params.promptMode === "minimal";
  const sections: string[] = [];

  const toneText = params.personaTone === "warm" ? "温暖亲切" :
    params.personaTone === "professional" ? "专业严谨" :
    params.personaTone === "casual" ? "轻松随和" : "幽默风趣";

  sections.push(`You are ${params.personaName}, ${params.personaTitle}.`);
  sections.push(`Address the user as "${params.masterTerm}".`);
  sections.push(`Tone: ${toneText}.`);
  sections.push("Respond in Chinese, concisely and warmly.");
  sections.push("");

  if (params.prependSystemContext) {
    sections.push(params.prependSystemContext);
    sections.push("");
  }

  sections.push("## Tooling");
  sections.push(`Available tools: ${params.registeredToolNames.join(", ")}.`);
  sections.push(
    "Call tools when the user asks you to perform operations. " +
    "Do not describe what you will do — actually invoke the tool. " +
    "After a tool call, report the result based on the actual tool output."
  );
  sections.push(
    "You have web_search, web_fetch, and browser tools available. " +
    "You CAN access the internet in real-time. " +
    "NEVER claim you cannot access the internet, have network restrictions, or lack real-time data. " +
    "When asked about current events, latest information, or recent data, ALWAYS use web_search first. " +
    "If search results are insufficient, try different query terms or use web_fetch to read specific pages."
  );
  sections.push("");
  sections.push("## File Operations");
  sections.push(
    "When creating files for the user (documents, tutorials, reports, etc.):"
  );
  sections.push("1. Use `file_create` with the file path and content. Set `overwrite: true` if updating an existing file.");
  sections.push("2. Always save files to the `data/workspace/` directory (e.g., `data/workspace/macOS-tutorial.md`).");
  sections.push("3. After creating a file, tell the user: the file path, and that they can download it via the download link.");
  sections.push("4. Format: 📄 文件已保存: `{path}` | [点击下载](/api/files/download/{path})");
  sections.push("5. For large content, create the file directly — do NOT output the full content in your reply text. Just summarize what was created and provide the download link.");
  sections.push("");

  sections.push("## Execution Strategy (MANDATORY)");
  sections.push(
    "When the user asks you to perform ANY task (search news, browse web, send email, manage files, etc):"
  );
  sections.push("");
  sections.push("**STEP 1 — Search for a Skill FIRST**");
  sections.push("- Call the `skill_search` tool with the task description.");
  sections.push("- If a matching skill is found: call `skill_install` to install it, then call `skill_execute` to run it.");
  sections.push("- If NO matching skill exists → proceed to STEP 2.");
  sections.push("");
  sections.push("**STEP 2 — Search online / Create the Skill**");
  sections.push("- For search/web tasks: use the `web_search` tool or browser tools.");
  sections.push("- Consider calling `skill_create` to auto-generate a new Skill for this task.");
  sections.push("- If `skill_create` succeeds, install and run the new skill.");
  sections.push("");
  sections.push("**STEP 3 — NEVER give up**");
  sections.push("- If a tool fails: retry once with different parameters.");
  sections.push("- If still failing: try the NEXT available approach.");
  sections.push("- If truly stuck: clearly state what failed and ASK the user what to try next.");
  sections.push("- NEVER silently stop. Always produce a final status message.");
  sections.push("");
  sections.push("**Crucial: Do NOT skip STEP 1. 搜索类、上网类任务必须先用 skill_search，而不是直接调 browser 工具！**");
  sections.push("");

  if (params.delegationMode === "prefer" && params.hasSessionsSpawn && !isMinimal) {
    sections.push("## Sub-Agent Delegation");
    sections.push("Mode: prefer. You are the responsive coordinator.");
    sections.push("- Reply directly only for trivial chat or clarifying questions.");
    sections.push("- Delegate file/code inspection, shell commands, web/browser use, coding, debugging, analysis to sessions_spawn.");
    sections.push("- Give each child a clear objective and expected output.");
    sections.push("");
  }

  if (!isMinimal) {
    sections.push("## Safety");
    sections.push(
      "Do not seek power, bypass oversight, or take actions that could harm the user or their systems. " +
      "Be honest about your limitations. Do not fabricate information."
    );
    sections.push("");
  }

  if (params.skillsPrompt && params.skillsPrompt.trim()) {
    sections.push("## Skills");
    sections.push(
      'Scan <available_skills>. If one clearly applies, read its SKILL.md at the exact <location> with the read tool, then follow it.'
    );
    sections.push(
      "If several apply, choose the most specific. If none clearly apply, read none. " +
      "One skill up front max. Never guess or fabricate skill paths."
    );
    sections.push("External API writes: batch when safe, respect 429/Retry-After.");
    sections.push(params.skillsPrompt.trim());
    sections.push("");
  }

  if (!isMinimal) {
    sections.push("## OpenClaw Control");
    sections.push(
      "Prefer the gateway tool for config/restart work. Do not invent CLI commands. " +
      "Use config.schema.lookup for configuration field details."
    );
    sections.push("");

    sections.push("## OpenClaw Self-Update");
    sections.push(
      "Inspect config safely with config.schema.lookup. " +
      "Patch config with config.patch, replace full config with config.apply. " +
      "Run update only on explicit user request."
    );
    sections.push("");

    sections.push("## Workspace");
    sections.push(`Working directory: ${params.workspacePath || "~/.evoclaw/workspace"}`);
    sections.push("");
  }

  if (!isMinimal && params.docsPath) {
    sections.push("## Documentation");
    sections.push(`Local docs: ${params.docsPath}`);
    sections.push(
      "Consult docs first for behavior, commands, configuration, or architecture questions. " +
      "When docs are incomplete, review source code."
    );
    sections.push("");
  }

  if (params.bootstrapFiles && params.bootstrapFiles.length > 0) {
    sections.push("# Project Context");
    sections.push("The following project context files have been loaded:");
    sections.push("");

    for (const file of params.bootstrapFiles) {
      sections.push(`## ${file.path}`);
      sections.push("");
      sections.push(file.content);
      sections.push("");
    }
  }

  if (params.sandboxMode && !isMinimal) {
    sections.push("## Sandbox");
    sections.push("Sandbox mode is active.");
    if (params.sandboxWorkspaceRoot) {
      sections.push(`Sandbox workspace: ${params.sandboxWorkspaceRoot}`);
    }
    sections.push("");
  }

  if (!isMinimal && params.userTimezone) {
    sections.push("## Current Date & Time");
    sections.push(`Time zone: ${params.userTimezone}`);
    sections.push(`Time format: ${params.timeFormat === "24" ? "24-hour" : "12-hour"}`);
    sections.push("Use session_status for the current timestamp when needed.");
    sections.push("");
  }

  if (!isMinimal && params.ownerNumbers && params.ownerNumbers.length > 0) {
    sections.push("## Authorized Senders");
    sections.push(
      `Authorized senders: ${params.ownerNumbers.join(", ")}. ` +
      "These senders are allowlisted; do not assume they are the owner."
    );
    sections.push("");
  }

  if (!isMinimal && params.heartbeatEnabled && params.heartbeatPrompt) {
    sections.push("## Heartbeats");
    sections.push(
      "If the current user message is a heartbeat poll and nothing needs attention, reply exactly: HEARTBEAT_OK"
    );
    sections.push(
      'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.'
    );
    sections.push("");
  }

  sections.push("## Runtime");
  if (params.hostInfo) {
    sections.push(
      `Host: ${params.hostInfo.os} ${params.hostInfo.arch}, ` +
      `Node ${params.hostInfo.nodeVersion}`
    );
  }
  if (params.repoRoot) {
    sections.push(`Repo root: ${params.repoRoot}`);
  }
  sections.push("");

  if (params.appendSystemContext) {
    sections.push(params.appendSystemContext);
    sections.push("");
  }

  return sections.join("\n");
}

export function buildCompactSkillsPrompt(skills: Array<{
  name: string;
  description: string;
  location: string;
}>): string {
  if (skills.length === 0) return "";

  const entries = skills.map((s) =>
    `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.location}</location>\n  </skill>`
  ).join("\n");

  return `<available_skills>\n${entries}\n</available_skills>`;
}