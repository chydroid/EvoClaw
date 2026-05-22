/**
 * ContextEngine — OpenClaw-style context assembly pipeline.
 *
 * Assembles the full context for every agent turn by combining:
 * - Bootstrap files (AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md)
 * - Skills context (loaded skills prompts)
 * - Memory context (relevant facts from long-term memory)
 * - System prompt
 * - Conversation history
 * - Compaction summaries
 *
 * The engine supports plugin hooks for context injection (prepend/append).
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContextConfig {
  /** Workspace directory */
  workspacePath: string;
  /** Max total context tokens */
  maxContextTokens: number;
  /** Reserve tokens for model response */
  reserveTokens: number;
  /** Bootstrap file names to load */
  bootstrapFiles: string[];
  /** Max chars per bootstrap file */
  maxBootstrapFileChars: number;
  /** Max total bootstrap chars */
  maxTotalBootstrapChars: number;
  /** System prompt mode */
  promptMode: "full" | "minimal" | "none";
  /** User timezone */
  timezone?: string;
  /** Time format (12 or 24 hour) */
  timeFormat?: "12" | "24";
  /** Enable heartbeat reminders */
  heartbeatEnabled?: boolean;
  /** Heartbeat prompt text */
  heartbeatPrompt?: string;
}

export interface ContextAssemblyInput {
  /** Session conversation history */
  conversationHistory: Array<{
    role: string;
    content: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
    name?: string;
  }>;
  /** System prompt builder */
  systemPrompt: string;
  /** Available skill names/prompts */
  skillsContext?: string;
  /** Recent memory entries to inject */
  memoryContext?: string;
  /** Compaction summary (if session was compacted) */
  compactionSummary?: string;
  /** Plugin-injected extra content */
  pluginAppendContext?: string;
  pluginPrependContext?: string;
  /** Current task/instruction */
  currentTask?: string;
}

export interface ContextAssemblyResult {
  /** Full assembled messages for the LLM */
  messages: Array<{ role: string; content: string | null }>;
  /** Token estimate for the assembled context */
  tokenEstimate: number;
  /** Whether any files were truncated */
  truncated: boolean;
  /** Loaded bootstrap file paths */
  loadedBootstrapFiles: string[];
  /** Warnings about context size */
  warnings: string[];
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ContextConfig = {
  workspacePath: "data/workspace",
  maxContextTokens: 60000,
  reserveTokens: 4000,
  bootstrapFiles: ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md"],
  maxBootstrapFileChars: 12000,
  maxTotalBootstrapChars: 60000,
  promptMode: "full",
};

// ─── Context Engine ───────────────────────────────────────────────────────────

export class ContextEngine {
  private config: ContextConfig;

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Bootstrap File Loading ──────────────────────────────────────────────

  /** Load all bootstrap files from the workspace */
  loadBootstrapFiles(extraFiles?: string[]): Array<{ path: string; content: string }> {
    const files: Array<{ path: string; content: string }> = [];
    const fileNames = extraFiles
      ? [...new Set([...this.config.bootstrapFiles, ...extraFiles])]
      : this.config.bootstrapFiles;
    let totalChars = 0;

    for (const fileName of fileNames) {
      const filePath = path.join(this.config.workspacePath, fileName);
      if (!fs.existsSync(filePath)) continue;

      try {
        let content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) continue;

        if (content.length > this.config.maxBootstrapFileChars) {
          content = content.slice(0, this.config.maxBootstrapFileChars) +
            `\n\n[Content truncated — read ${filePath} for full content]`;
        }

        if (totalChars + content.length > this.config.maxTotalBootstrapChars) {
          const remaining = this.config.maxTotalBootstrapChars - totalChars;
          if (remaining > 100) {
            content = content.slice(0, remaining) +
              `\n\n[Content truncated due to total bootstrap limit]`;
          } else {
            break; // Stop loading more files
          }
        }

        files.push({ path: fileName, content });
        totalChars += content.length;
      } catch (err) {
        console.warn(`[ContextEngine] Failed to read bootstrap file ${filePath}:`, err);
      }
    }

    return files;
  }

  /** Build the bootstrap context section for injection into system prompt */
  buildBootstrapContext(bootstrapFiles: Array<{ path: string; content: string }>): string {
    if (bootstrapFiles.length === 0) {
      return "[No bootstrap files loaded. Run setup to create initial configuration.]";
    }

    const sections: string[] = [];
    sections.push("## Project Context (from workspace bootstrap files)");
    sections.push("");

    for (const file of bootstrapFiles) {
      sections.push(`### ${file.path}`);
      sections.push("");
      sections.push(file.content);
      sections.push("");
    }

    return sections.join("\n");
  }

  // ─── Context Assembly ────────────────────────────────────────────────────

  /** Assemble the full context for an agent turn */
  assembleContext(input: ContextAssemblyInput): ContextAssemblyResult {
    const messages: Array<{ role: string; content: string | null }> = [];
    const warnings: string[] = [];
    const loadedBootstrapFiles: string[] = [];
    let truncated = false;

    // 1. Build system message
    let systemContent = input.systemPrompt;

    // Add bootstrap context
    const bootstrapFiles = this.loadBootstrapFiles();
    loadedBootstrapFiles.push(...bootstrapFiles.map((f) => f.path));

    if (bootstrapFiles.length > 0 && this.config.promptMode !== "none") {
      const bootstrapCtx = this.buildBootstrapContext(bootstrapFiles);
      systemContent += "\n\n" + bootstrapCtx;
    }

    // Add compaction summary if available
    if (input.compactionSummary) {
      systemContent += "\n\n" +
        "## Previous Conversation Summary (Compacted)\n\n" +
        input.compactionSummary;
      truncated = true;
    }

    // Add skills context
    if (input.skillsContext) {
      systemContent += "\n\n## Available Skills\n\n" + input.skillsContext;
    }

    // Add memory context (relevant facts)
    if (input.memoryContext) {
      systemContent += "\n\n## Relevant Memories\n\n" + input.memoryContext;
    }

    // Plugin prepend (before system prompt)
    if (input.pluginPrependContext) {
      systemContent = input.pluginPrependContext + "\n\n" + systemContent;
    }

    // Plugin append (after system prompt)
    if (input.pluginAppendContext) {
      systemContent += "\n\n" + input.pluginAppendContext;
    }

    // Heartbeat reminder
    if (this.config.heartbeatEnabled && this.config.heartbeatPrompt) {
      systemContent += "\n\n" + this.config.heartbeatPrompt;
    }

    // Add timezone info
    if (this.config.timezone) {
      systemContent += `\n\nCurrent timezone: ${this.config.timezone} (${this.config.timeFormat ?? "24"}h format)`;
    }

    messages.push({ role: "system", content: systemContent });

    // 2. Add conversation history
    let historyTokens = 0;
    const availableTokens = this.config.maxContextTokens - this.estimateTokens(systemContent) - this.config.reserveTokens;

    // Add messages from newest to oldest (we'll reverse at the end)
    const reversedHistory: typeof input.conversationHistory = [];

    for (let i = input.conversationHistory.length - 1; i >= 0; i--) {
      const msg = input.conversationHistory[i];
      const msgTokens = this.estimateTokens(msg.content ?? "") +
        this.estimateTokens(JSON.stringify(msg.tool_calls ?? {}));

      if (historyTokens + msgTokens > availableTokens) {
        if (reversedHistory.length === 0) {
          // Always include at least one message to avoid empty context
          reversedHistory.push(msg);
          warnings.push("Context limit reached — some history was truncated");
          truncated = true;
        }
        break;
      }

      reversedHistory.push(msg);
      historyTokens += msgTokens;
    }

    // Reverse back to chronological order
    for (let i = reversedHistory.length - 1; i >= 0; i--) {
      messages.push(reversedHistory[i]);
    }

    // 3. Add current task if provided
    if (input.currentTask) {
      messages.push({ role: "user", content: input.currentTask });
    }

    // 4. Estimate total tokens
    const tokenEstimate = this.estimateTokens(
      messages.map((m) => m.content ?? "").join(""),
    );

    // 5. Context size warning
    if (tokenEstimate > this.config.maxContextTokens * 0.8) {
      warnings.push(
        `Context at ${Math.round((tokenEstimate / this.config.maxContextTokens) * 100)}% of limit — consider compacting`,
      );
    }

    return {
      messages,
      tokenEstimate,
      truncated,
      loadedBootstrapFiles,
      warnings,
    };
  }

  // ─── Context Size Utilities ───────────────────────────────────────────────

  /** Estimate token count for text (simple heuristic: ~4 chars per token) */
  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /** Check if context needs compaction */
  needsCompaction(
    conversationHistory: Array<{ role: string; content: string | null }>,
    systemPrompt: string,
  ): boolean {
    const historyTokens = conversationHistory.reduce(
      (sum, m) => sum + this.estimateTokens(m.content ?? ""),
      0,
    );
    const systemTokens = this.estimateTokens(systemPrompt);
    const totalEstimate = systemTokens + historyTokens;

    return totalEstimate > this.config.maxContextTokens * 0.75;
  }

  /** Get available tokens for a response */
  getAvailableTokens(currentContext: string): number {
    const used = this.estimateTokens(currentContext);
    return Math.max(0, this.config.maxContextTokens - used - this.config.reserveTokens);
  }

  /** Quick token estimate for a batch of messages */
  estimateMessagesTokens(
    messages: Array<{ role: string; content: string | null }>,
  ): number {
    return messages.reduce((sum, m) => {
      let tokens = this.estimateTokens(m.content ?? "");
      // Role names add a small overhead
      tokens += 4;
      return sum + tokens;
    }, 0);
  }

  // ─── Configuration ───────────────────────────────────────────────────────

  updateConfig(updates: Partial<ContextConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  getConfig(): Readonly<ContextConfig> {
    return this.config;
  }

  setWorkspacePath(workspacePath: string): void {
    this.config.workspacePath = workspacePath;
    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }
  }
}