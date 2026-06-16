// EvoClaw Context Pruning Module
// Inspired by OpenClaw's context pruning extension
// Provides soft trim (truncate large tool results) and hard clear (replace old results with placeholders)

export interface ContextPruningConfig {
  /** Maximum characters for tool results before soft trim */
  softTrimThreshold: number;
  /** Number of turns to keep full tool results for hard clear */
  hardClearTurnThreshold: number;
  /** Enable soft trim */
  enableSoftTrim: boolean;
  /** Enable hard clear */
  enableHardClear: boolean;
}

export interface PruningResult {
  prunedMessages: Array<{ role: string; content: string | unknown[] | null; tool_calls?: any[] }>;
  stats: {
    softTrimmed: number;
    hardCleared: number;
    charsSaved: number;
  };
}

const DEFAULT_CONFIG: ContextPruningConfig = {
  softTrimThreshold: 4000,
  hardClearTurnThreshold: 10,
  enableSoftTrim: true,
  enableHardClear: true,
};

/**
 * Context Pruning Manager
 * Reduces context size by trimming large tool results and clearing old ones
 */
export class ContextPruningManager {
  private config: ContextPruningConfig;

  constructor(config?: Partial<ContextPruningConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Prune conversation messages to reduce context size
   */
  prune(messages: Array<{ role: string; content: string | unknown[] | null; tool_calls?: any[] }>): PruningResult {
    const stats = {
      softTrimmed: 0,
      hardCleared: 0,
      charsSaved: 0,
    };

    let prunedMessages = [...messages];

    // Soft trim: truncate large tool results
    if (this.config.enableSoftTrim) {
      prunedMessages = prunedMessages.map((msg, idx) => {
        if (msg.role === "tool" && typeof msg.content === "string") {
          const originalLength = msg.content.length;
          if (originalLength > this.config.softTrimThreshold) {
            stats.softTrimmed++;
            stats.charsSaved += originalLength - this.config.softTrimThreshold;
            
            // Keep head and tail
            const headSize = Math.floor(this.config.softTrimThreshold * 0.7);
            const tailSize = this.config.softTrimThreshold - headSize - 50;
            const head = msg.content.slice(0, headSize);
            const tail = msg.content.slice(-tailSize);
            
            return {
              ...msg,
              content: `${head}\n\n... [${originalLength - this.config.softTrimThreshold} chars truncated] ...\n\n${tail}`,
            };
          }
        }
        return msg;
      });
    }

    // Hard clear: replace very old tool results with placeholders
    if (this.config.enableHardClear && prunedMessages.length > this.config.hardClearTurnThreshold * 2) {
      const cutoffIndex = prunedMessages.length - this.config.hardClearTurnThreshold * 2;
      
      prunedMessages = prunedMessages.map((msg, idx) => {
        if (idx < cutoffIndex && msg.role === "tool") {
          const originalLength = typeof msg.content === "string" ? msg.content.length : 0;
          stats.hardCleared++;
          stats.charsSaved += originalLength;
          
          return {
            ...msg,
            content: "[Tool result cleared to save context space]",
          };
        }
        return msg;
      });
    }

    return { prunedMessages, stats };
  }

  /**
   * Check if pruning is needed based on message count
   */
  shouldPrune(messageCount: number): boolean {
    return messageCount > this.config.hardClearTurnThreshold * 2;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ContextPruningConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): ContextPruningConfig {
    return { ...this.config };
  }
}

/**
 * Create a context pruning stage for the input pipeline
 */
export function createContextPruningStage(pruningManager: ContextPruningManager): {
  name: string;
  execute: (ctx: any) => Promise<any>;
} {
  return {
    name: "context-pruning",
    async execute(ctx: any) {
      // Context pruning is applied to conversation history, not the current message
      // This stage is a placeholder for pipeline integration
      // Actual pruning happens in the LLM caller when assembling messages
      return ctx;
    },
  };
}
