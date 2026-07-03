import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export type PromptLayer = "frozen" | "ephemeral";

export interface PromptSection {
  content: string;
  layer: PromptLayer;
  name: string;
  tokenBudget?: number;
}

export interface FrozenPromptState {
  content: string;
  hash: string;
  sections: string[];
  builtAt: number;
}

export interface ContextConfig {
  workspacePath: string;
  maxContextTokens: number;
  reserveTokens: number;
  bootstrapFiles: string[];
  maxBootstrapFileChars: number;
  maxTotalBootstrapChars: number;
  promptMode: "full" | "minimal" | "none";
  timezone?: string;
  timeFormat?: "12" | "24";
  heartbeatEnabled?: boolean;
  heartbeatPrompt?: string;
  platformHint?: string;
}

export interface ContextAssemblyInput {
  conversationHistory: Array<{
    role: string;
    content: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
    name?: string;
  }>;
  systemPrompt: string;
  skillsContext?: string;
  memoryContext?: string;
  compactionSummary?: string;
  pluginAppendContext?: string;
  pluginPrependContext?: string;
  currentTask?: string;
}

export interface ContextAssemblyResult {
  messages: Array<{ role: string; content: string | null }>;
  tokenEstimate: number;
  truncated: boolean;
  loadedBootstrapFiles: string[];
  warnings: string[];
}

export interface LayeredContextResult extends ContextAssemblyResult {
  frozenContent: string;
  ephemeralContent: string;
  frozenHash: string;
  cacheControlAnnotations: Array<{
    role: string;
    index: number;
    cache_control: { type: string };
  }>;
}

const DEFAULT_CONFIG: ContextConfig = {
  workspacePath: "data/workspace",
  maxContextTokens: 128000,
  reserveTokens: 4000,
  bootstrapFiles: ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md"],
  maxBootstrapFileChars: 12000,
  maxTotalBootstrapChars: 60000,
  promptMode: "full",
};

export class ContextEngine {
  private config: ContextConfig;
  private frozenState: FrozenPromptState | null = null;
  private lastLoadedBootstrapFiles: string[] = [];

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

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
            break;
          }
        }

        files.push({ path: fileName, content });
        totalChars += content.length;
      } catch (err) {
        process.stderr.write(`[ContextEngine] Failed to read bootstrap file ${filePath}:` + " " + err + "\n");
      }
    }

    return files;
  }

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

  buildFrozenPrefix(input: ContextAssemblyInput): FrozenPromptState {
    const sectionNames: string[] = [];
    let content = input.systemPrompt;
    sectionNames.push("systemPrompt");

    const bootstrapFiles = this.loadBootstrapFiles();
    this.lastLoadedBootstrapFiles = bootstrapFiles.map((f) => f.path);

    if (bootstrapFiles.length > 0 && this.config.promptMode !== "none") {
      const bootstrapCtx = this.buildBootstrapContext(bootstrapFiles);
      content += "\n\n" + bootstrapCtx;
      sectionNames.push("bootstrap");
    }

    if (input.compactionSummary) {
      content += "\n\n## Previous Conversation Summary (Compacted)\n\n" + input.compactionSummary;
      sectionNames.push("compaction");
    }

    if (input.skillsContext) {
      content += "\n\n## Available Skills\n\n" + input.skillsContext;
      sectionNames.push("skills");
    }

    if (input.memoryContext) {
      content += "\n\n## Relevant Memories\n\n" + input.memoryContext;
      sectionNames.push("memory");
    }

    if (input.pluginPrependContext) {
      content = input.pluginPrependContext + "\n\n" + content;
      sectionNames.unshift("pluginPrepend");
    }

    if (input.pluginAppendContext) {
      content += "\n\n" + input.pluginAppendContext;
      sectionNames.push("pluginAppend");
    }

    const hash = crypto.createHash("sha256").update(content).digest("hex");

    if (this.frozenState && this.frozenState.hash === hash) {
      return this.frozenState;
    }

    const state: FrozenPromptState = {
      content,
      hash,
      sections: sectionNames,
      builtAt: Date.now(),
    };

    this.frozenState = state;
    return state;
  }

  buildEphemeralSuffix(input: ContextAssemblyInput): string {
    const parts: string[] = [];

    if (this.config.timezone) {
      parts.push(`Current timezone: ${this.config.timezone} (${this.config.timeFormat ?? "24"}h format)`);
    }

    if (this.config.platformHint) {
      parts.push(`Platform: ${this.config.platformHint}`);
    }

    if (this.config.heartbeatEnabled && this.config.heartbeatPrompt) {
      parts.push(this.config.heartbeatPrompt);
    }

    if (input.currentTask) {
      parts.push(`Current task: ${input.currentTask}`);
    }

    return parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
  }

  invalidateFrozen(): void {
    this.frozenState = null;
  }

  getFrozenHash(): string | null {
    return this.frozenState ? this.frozenState.hash : null;
  }

  assembleContext(input: ContextAssemblyInput): LayeredContextResult {
    const messages: Array<{ role: string; content: string | null }> = [];
    const warnings: string[] = [];
    let truncated = false;

    const frozen = this.buildFrozenPrefix(input);
    const ephemeralContent = this.buildEphemeralSuffix(input);
    const systemContent = frozen.content + ephemeralContent;

    messages.push({ role: "system", content: systemContent });

    let historyTokens = 0;
    const availableTokens = this.config.maxContextTokens - this.estimateTokens(systemContent) - this.config.reserveTokens;

    const reversedHistory: typeof input.conversationHistory = [];

    for (let i = input.conversationHistory.length - 1; i >= 0; i--) {
      const msg = input.conversationHistory[i];
      const msgTokens = this.estimateTokens(msg.content ?? "") +
        this.estimateTokens(JSON.stringify(msg.tool_calls ?? {}));

      if (historyTokens + msgTokens > availableTokens) {
        if (reversedHistory.length === 0) {
          reversedHistory.push(msg);
          warnings.push("Context limit reached — some history was truncated");
          truncated = true;
        }
        break;
      }

      reversedHistory.push(msg);
      historyTokens += msgTokens;
    }

    for (let i = reversedHistory.length - 1; i >= 0; i--) {
      messages.push(reversedHistory[i]);
    }

    if (input.currentTask) {
      messages.push({ role: "user", content: input.currentTask });
    }

    const tokenEstimate = this.estimateTokens(
      messages.map((m) => m.content ?? "").join(""),
    );

    const maxTokens = this.config.maxContextTokens;
    if (maxTokens > 0 && tokenEstimate > maxTokens * 0.8) {
      const pct = Math.min(999, Math.round((tokenEstimate / maxTokens) * 100));
      warnings.push(
        `Context at ${pct}% of limit — consider compacting`,
      );
    }

    // Anthropic prompt caching: system_and_3 策略
    // 借鉴 hermes-agent agent/prompt_caching.py apply_anthropic_cache_control：
    //   Anthropic 最多支持 4 个 cache_control 断点。最佳策略是：
    //   1 个 system prompt 断点 + 3 个最后的非 system 消息断点。
    //   这样可以缓存 ~75% 的输入 token，大幅降低成本。
    //   之前只用了 1/4 断点（仅 system），命中率远低于最优。
    const cacheControlAnnotations: Array<{
      role: string;
      index: number;
      cache_control: { type: string };
    }> = [];

    // 断点 1: system prompt（如果存在）
    if (messages.length > 0 && messages[0].role === "system") {
      cacheControlAnnotations.push({
        role: "system",
        index: 0,
        cache_control: { type: "ephemeral" },
      });
    }

    // 断点 2-4: 最后 3 条非 system 消息
    const remainingBreakpoints = 4 - cacheControlAnnotations.length;
    const nonSysIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "system") {
        nonSysIndices.push(i);
      }
    }
    for (const idx of nonSysIndices.slice(-remainingBreakpoints)) {
      cacheControlAnnotations.push({
        role: messages[idx].role,
        index: idx,
        cache_control: { type: "ephemeral" },
      });
    }

    return {
      messages,
      tokenEstimate,
      truncated,
      loadedBootstrapFiles: this.lastLoadedBootstrapFiles,
      warnings,
      frozenContent: frozen.content,
      ephemeralContent,
      frozenHash: frozen.hash,
      cacheControlAnnotations,
    };
  }

  /**
   * CJK 感知的 Token 估算。
   *
   * 英文约 4 字符/token，中文约 1.5 字符/token，日韩文约 2 字符/token。
   * 通过统计 CJK 字符数量动态调整比例，比固定 chars/4 更准确。
   * 参考：GPT-4 tokenizer 中 "你好" = 2 tokens（2 chars → 2 tokens，而非 0.5）
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    let cjkCount = 0;
    let otherCount = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      // CJK 统一表意文字 + 扩展A + 日文假名 + 韩文音节
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||   // CJK 统一表意
        (code >= 0x3400 && code <= 0x4dbf) ||   // CJK 扩展A
        (code >= 0x3040 && code <= 0x30ff) ||   // 日文假名
        (code >= 0xac00 && code <= 0xd7af)      // 韩文音节
      ) {
        cjkCount++;
      } else {
        otherCount++;
      }
    }
    // CJK: ~1.5 chars/token; 其他: ~4 chars/token
    return Math.ceil(cjkCount / 1.5 + otherCount / 4);
  }

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

  getAvailableTokens(currentContext: string): number {
    const used = this.estimateTokens(currentContext);
    return Math.max(0, this.config.maxContextTokens - used - this.config.reserveTokens);
  }

  estimateMessagesTokens(
    messages: Array<{ role: string; content: string | null }>,
  ): number {
    return messages.reduce((sum, m) => {
      let tokens = this.estimateTokens(m.content ?? "");
      tokens += 4;
      return sum + tokens;
    }, 0);
  }

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
