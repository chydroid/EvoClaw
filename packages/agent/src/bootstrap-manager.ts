import * as fs from "fs";
import * as path from "path";

const BOOTSTRAP_FILES = [
  { name: "AGENTS.md", description: "Operating instructions + memory", required: true },
  { name: "SOUL.md", description: "Persona, boundaries, tone", required: false },
  { name: "TOOLS.md", description: "User-maintained tool notes", required: false },
  { name: "IDENTITY.md", description: "Agent name/vibe/emoji", required: false },
  { name: "USER.md", description: "User profile + preferred address", required: false },
  { name: "HEARTBEAT.md", description: "Periodic check-in instructions", required: false },
];

const DEFAULT_TEMPLATES: Record<string, string> = {
  "AGENTS.md": `# EvoClaw Operating Instructions

## Who You Are
You are EvoClaw, a helpful and intelligent personal AI assistant. You run on the user's own device.

## Core Rules
1. Be helpful, accurate, and concise.
2. When you don't know something, say so honestly.
3. Use tools when they help solve the task — prefer skills over raw tools for complex operations.
4. NEVER give up on a task. If one approach fails, try another. If all fail, explain why and ask the user.
5. Keep the user informed of your progress — send updates when actions are taking time.
6. For web/search tasks, use skills (skill_search -> skill_execute), not browser tools directly.
7. Respect the user's privacy and security — never share data externally without asking.
8. Save important learnings and user preferences to memory files.

## Memory
- Use the AGENTS.md as your long-term memory store.
- After important interactions, update this file with what you learned.
`,

  "SOUL.md": `# EvoClaw Soul

## Personality
- Warm, helpful, and professional
- Concise but never cold
- Proactive — anticipate needs before being asked
- Persistent — don't give up easily
- Honest about limitations

## Boundaries
- Never impersonate the user
- Never make financial decisions
- Never share private information
- Never execute destructive commands without explicit confirmation

## Tone
- Default: Friendly and efficient
- Technical topics: Precise and clear
- Sensitive topics: Empathetic and careful
`,

  "TOOLS.md": `# Tool Notes

## web_search
Uses DuckDuckGo for web searches. No API key needed. Results include title, URL, and snippet. Best for general queries.

## web_fetch
Fetches and extracts readable text from any URL. Supports HTML, plain text, and JSON parsing. Good for reading articles, getting API data, or checking website content.

## browser_*
Browser-based tools for interactive web browsing. Use for complex web tasks that need clicking, scrolling, or form interaction.

## skill_*
Skill management tools: search, install, execute skills. Skills are reusable task packages. Always search for a relevant skill before writing new code.
`,

  "IDENTITY.md": `# Agent Identity

- Name: EvoClaw
- Emoji: 🧬
- Style: Modern, friendly AI assistant
- Language: Match user's language (default: Chinese)
`,

  "USER.md": `# User Profile

- Preferred name: (not set)
- Language: Chinese
- Timezone: Asia/Singapore
- Communication style: Direct, technical

(Edit this file to customize how EvoClaw addresses you)
`,

  "HEARTBEAT.md": `# Heartbeat Check-in

## When
Every 6 hours of inactivity, check in with the user.

## What to do
1. Review recent conversation history
2. Summarize any pending items or follow-ups
3. Send a brief check-in message
4. Keep it light and optional — don't be intrusive
`,
};

export interface BootstrapContext {
  /** AGENTS.md content */
  agentsMd: string;
  /** SOUL.md content */
  soulMd: string;
  /** TOOLS.md content */
  toolsMd: string;
  /** IDENTITY.md content */
  identityMd: string;
  /** USER.md content */
  userMd: string;
  /** HEARTBEAT.md content */
  heartbeatMd: string;
  /** Whether BOOTSTRAP.md exists and hasn't been completed */
  bootstrapPending: boolean;
  /** BOOTSTRAP.md content (only when pending) */
  bootstrapMd?: string;
  /** Missing required files */
  missingFiles: string[];
}

export class BootstrapManager {
  private workspacePath: string;

  constructor(private configManager?: { get(key: string): unknown }) {
    this.workspacePath = path.join(process.cwd(), "data", "workspace");
  }

  /** Set custom workspace path */
  setWorkspacePath(p: string): void {
    this.workspacePath = p;
  }

  /** Get the workspace path */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /** Ensure workspace and bootstrap files exist */
  async initialize(): Promise<BootstrapContext> {
    this.ensureDir(this.workspacePath);

    // Check which files exist and create defaults for missing ones
    let createdAny = false;
    for (const file of BOOTSTRAP_FILES) {
      const filePath = path.join(this.workspacePath, file.name);
      if (!fs.existsSync(filePath)) {
        const template = DEFAULT_TEMPLATES[file.name] || "";
        this.writeFile(filePath, template.trim() + "\n");
        if (file.name === "AGENTS.md" || file.name === "SOUL.md") {
          createdAny = true;
        }
      }
    }

    // Handle BOOTSTRAP.md — only create for brand new workspace
    const hasAnyBootstrap = BOOTSTRAP_FILES.slice(0, 3).some((f) =>
      fs.existsSync(path.join(this.workspacePath, f.name))
    );
    const bootstrapPath = path.join(this.workspacePath, "BOOTSTRAP.md");
    if (!hasAnyBootstrap && !fs.existsSync(bootstrapPath)) {
      const bootstrapTemplate = DEFAULT_TEMPLATES["BOOTSTRAP.md"];
      this.writeFile(bootstrapPath, bootstrapTemplate ? bootstrapTemplate.trim() + "\n" : "");
    }

    if (createdAny) {
      process.stdout.write(`[BootstrapManager] Created default bootstrap files in ${this.workspacePath}\n`);
    }

    return this.getContext();
  }

  /** Get all bootstrap context for system prompt injection */
  getContext(): BootstrapContext {
    const missingFiles: string[] = [];
    const ctx: BootstrapContext = {
      agentsMd: "",
      soulMd: "",
      toolsMd: "",
      identityMd: "",
      userMd: "",
      heartbeatMd: "",
      bootstrapPending: false,
      missingFiles: [],
    };

    for (const file of BOOTSTRAP_FILES) {
      const filePath = path.join(this.workspacePath, file.name);
      if (fs.existsSync(filePath)) {
        const content = this.readFile(filePath);
        if (content.trim()) {
          const key = file.name.replace(".md", "").toLowerCase() as keyof BootstrapContext;
          (ctx as unknown as Record<string, unknown>)[key] = content.slice(0, 8000); // Trim large files
        }
      } else if (file.required) {
        missingFiles.push(file.name);
      }
    }

    // BOOTSTRAP.md is only injected when pending (new workspace)
    const bootstrapPath = path.join(this.workspacePath, "BOOTSTRAP.md");
    if (fs.existsSync(bootstrapPath)) {
      ctx.bootstrapPending = true;
      ctx.bootstrapMd = this.readFile(bootstrapPath).slice(0, 4000);
    }

    ctx.missingFiles = missingFiles;
    return ctx;
  }

  /** Read a bootstrap file */
  readBootstrapFile(filename: string): string | null {
    // 防止路径穿越：仅取 basename
    const safeName = path.basename(filename);
    const filePath = path.join(this.workspacePath, safeName);
    if (fs.existsSync(filePath)) {
      return this.readFile(filePath);
    }
    return null;
  }

  /** Write a bootstrap file */
  writeBootstrapFile(filename: string, content: string): void {
    const filePath = path.join(this.workspacePath, filename);
    this.writeFile(filePath, content);
  }

  /** Delete a bootstrap file */
  deleteBootstrapFile(filename: string): void {
    const filePath = path.join(this.workspacePath, filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        process.stderr.write(`[BootstrapManager] Failed to delete ${filePath}: ${e}\n`);
      }
    }
  }

  /** Complete bootstrap ritual — delete BOOTSTRAP.md */
  completeBootstrap(): void {
    const bootstrapPath = path.join(this.workspacePath, "BOOTSTRAP.md");
    if (fs.existsSync(bootstrapPath)) {
      this.deleteBootstrapFile("BOOTSTRAP.md");
      process.stdout.write("[BootstrapManager] Bootstrap ritual completed — BOOTSTRAP.md deleted\n");
    }
  }

  /** List all bootstrap files with their contents */
  listFiles(): { name: string; description: string; content: string; exists: boolean }[] {
    return BOOTSTRAP_FILES.map((f) => {
      const filePath = path.join(this.workspacePath, f.name);
      return {
        name: f.name,
        description: f.description,
        exists: fs.existsSync(filePath),
        content: fs.existsSync(filePath) ? this.readFile(filePath) : "",
      };
    });
  }

  /** Build system prompt injection from bootstrap context */
  buildSystemPromptInjection(ctx: BootstrapContext): string {
    const parts: string[] = [];

    if (ctx.identityMd.trim()) {
      parts.push(`## Your Identity\n\n${ctx.identityMd.trim()}`);
    }

    if (ctx.soulMd.trim()) {
      parts.push(`## Your Soul / Personality\n\n${ctx.soulMd.trim()}`);
    }

    if (ctx.userMd.trim()) {
      parts.push(`## User Profile\n\n${ctx.userMd.trim()}`);
    }

    if (ctx.agentsMd.trim()) {
      parts.push(`## Operating Instructions\n\n${ctx.agentsMd.trim()}`);
    }

    if (ctx.toolsMd.trim()) {
      parts.push(`## Tool Notes\n\n${ctx.toolsMd.trim()}`);
    }

    if (ctx.heartbeatMd.trim()) {
      parts.push(`## Heartbeat Instructions\n\n${ctx.heartbeatMd.trim()}`);
    }

    if (ctx.bootstrapPending && ctx.bootstrapMd) {
      parts.push(`## Initial Bootstrap Ritual (FIRST RUN)\n\n${ctx.bootstrapMd}\n\nAfter completing the bootstrap ritual, call \`complete_bootstrap\` to finalize.`);
    }

    if (ctx.missingFiles.length > 0) {
      parts.push(`(Missing files: ${ctx.missingFiles.join(", ")}. Run 'evoclaw setup' to create defaults.)`);
    }

    return parts.join("\n\n");
  }

  // ======= File I/O helpers =======

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        process.stderr.write(`[BootstrapManager] Failed to create dir ${dir}: ${e}\n`);
      }
    }
  }

  private readFile(filePath: string): string {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      process.stderr.write(`[BootstrapManager] Failed to read ${filePath}: ${err}\n`);
      return "";
    }
  }

  private writeFile(filePath: string, content: string): void {
    try {
      fs.writeFileSync(filePath, content, "utf-8");
    } catch (e) {
      process.stderr.write(`[BootstrapManager] Failed to write ${filePath}: ${e}\n`);
    }
  }
}