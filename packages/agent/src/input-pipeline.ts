// EvoClaw Input Pipeline -- Sequential stage-based input processing
// Inspired by OpenClaw's pipeline pattern

// -- PipelineContext -----------------------------------------------------------

export interface PipelineContext {
  /** The user's raw, unmodified message */
  message: string;
  /** The message after modifications by pipeline stages */
  effectiveMessage: string;
  /** Session identifier */
  sessionId: string;
  /** Channel the message arrived on (e.g. "web", "api", "cli") */
  channel: string;
  /** Peer / user identifier */
  peerId: string;
  /** Agent identifier that will process this input */
  agentId: string;
  /** Optional file attachments */
  attachments?: Array<{
    name: string;
    type: string;
    size: number;
    data?: string | null;
  }>;
  /** Extensible metadata bag for stages to communicate */
  metadata: Record<string, unknown>;
  /** Set to true by a stage to stop the pipeline early */
  shortCircuit: boolean;
  /** When shortCircuit is true, this is the reply to send back */
  shortCircuitReply?: string;
  /** Accumulated warnings from stages */
  warnings: string[];
}

// -- PipelineStage ------------------------------------------------------------

export interface PipelineStage {
  /** Unique name for this stage (used for identification and removal) */
  name: string;
  /** Execute the stage; must return the (possibly modified) context */
  execute(context: PipelineContext): Promise<PipelineContext>;
}

// -- PipelineRunner -----------------------------------------------------------

export class PipelineRunner {
  private readonly stages: PipelineStage[] = [];

  constructor(stages: PipelineStage[] = []) {
    this.stages.push(...stages);
  }

  /** Run all stages in order; stops early if shortCircuit is true */
  async run(initialContext: PipelineContext): Promise<PipelineContext> {
    let ctx = initialContext;
    for (const stage of this.stages) {
      if (ctx.shortCircuit) {
        break;
      }
      try {
        ctx = await stage.execute(ctx);
      } catch (error) {
        ctx.warnings.push(
          `Stage "${stage.name}" threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return ctx;
  }

  /** Append a stage to the pipeline */
  addStage(stage: PipelineStage): void {
    this.stages.push(stage);
  }

  /** Remove a stage by name; returns true if a stage was removed */
  removeStage(name: string): boolean {
    const idx = this.stages.findIndex((s) => s.name === name);
    if (idx === -1) return false;
    this.stages.splice(idx, 1);
    return true;
  }
}

// -- Pre-built Stage Implementations ------------------------------------------

/**
 * Strips common XSS patterns from the effective message.
 * Removes <script>, event handler attributes, and javascript: URIs.
 */
export function createXssSanitizeStage(): PipelineStage {
  return {
    name: "xss-sanitize",
    async execute(ctx: PipelineContext): Promise<PipelineContext> {
      let msg = ctx.effectiveMessage;
      // Remove <script>...</script> blocks
      msg = msg.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
      // Remove on* event handler attributes
      msg = msg.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "");
      msg = msg.replace(/\bon\w+\s*=\s*[^\s>]+/gi, "");
      // Remove javascript: URIs
      msg = msg.replace(/javascript\s*:\s*[^\s"')>]+/gi, "");
      // Remove data: URIs with script-like content
      msg = msg.replace(/data\s*:\s*text\/html[^"')\s>]*/gi, "");
      // Remove <iframe>, <object>, <embed> tags
      msg = msg.replace(/<(?:iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed)>/gi, "");
      msg = msg.replace(/<(?:iframe|object|embed)\b[^>]*\/?>/gi, "");
      ctx.effectiveMessage = msg;
      return ctx;
    },
  };
}

/**
 * Truncates messages that exceed the given maximum length.
 * Adds a warning when truncation occurs.
 */
export function createLengthGuardStage(maxLength: number): PipelineStage {
  return {
    name: "length-guard",
    async execute(ctx: PipelineContext): Promise<PipelineContext> {
      if (ctx.effectiveMessage.length <= maxLength) {
        return ctx;
      }
      const truncated = ctx.effectiveMessage.slice(0, maxLength);
      ctx.effectiveMessage = truncated;
      ctx.warnings.push(
        `Message truncated from ${ctx.message.length} to ${maxLength} characters`,
      );
      return ctx;
    },
  };
}

/**
 * Injects attachment content into the effective message.
 * For text-based attachments, the data is appended; for others, a summary line is added.
 */
export function createAttachmentInjectionStage(): PipelineStage {
  return {
    name: "attachment-injection",
    async execute(ctx: PipelineContext): Promise<PipelineContext> {
      if (!ctx.attachments || ctx.attachments.length === 0) {
        return ctx;
      }

      const parts: string[] = [ctx.effectiveMessage];

      for (const att of ctx.attachments) {
        if (att.data && att.type.startsWith("text/")) {
          parts.push(`\n--- Attachment: ${att.name} ---\n${att.data}`);
        } else if (att.data) {
          // Non-text attachment with data: include a truncated preview
          const preview = att.data.length > 500
            ? att.data.slice(0, 500) + "...[truncated]"
            : att.data;
          parts.push(`\n--- Attachment: ${att.name} (${att.type}, ${att.size} bytes) ---\n${preview}`);
        } else {
          parts.push(`\n--- Attachment: ${att.name} (${att.type}, ${att.size} bytes, content not available) ---`);
        }
      }

      ctx.effectiveMessage = parts.join("");
      return ctx;
    },
  };
}

/**
 * Checks input safety using the GuardrailsManager.
 * If the guardrail blocks the input, the pipeline short-circuits with a reply.
 * If the guardrail sanitizes the input, the sanitized version replaces the effective message.
 */
export function createGuardrailsStage(guardrailsManager: any): PipelineStage {
  return {
    name: "guardrails",
    async execute(ctx: PipelineContext): Promise<PipelineContext> {
      if (!guardrailsManager || typeof guardrailsManager.checkInput !== "function") {
        return ctx;
      }

      const result = guardrailsManager.checkInput(ctx.effectiveMessage);

      if (!result.passed) {
        ctx.shortCircuit = true;
        ctx.shortCircuitReply = result.reason ?? "Input blocked by safety guardrails";
        return ctx;
      }

      if (result.sanitizedInput) {
        ctx.effectiveMessage = result.sanitizedInput;
        if (result.reason) {
          ctx.warnings.push(result.reason);
        }
      }

      return ctx;
    },
  };
}

/**
 * Runs before_agent_start plugin hooks via the plugin manager.
 * Allows plugins to inspect and modify the input before the agent processes it.
 */
export function createPluginPreProcessStage(pluginManager: any): PipelineStage {
  return {
    name: "plugin-pre-process",
    async execute(ctx: PipelineContext): Promise<PipelineContext> {
      if (!pluginManager || typeof pluginManager.runHook !== "function") {
        return ctx;
      }

      try {
        const hookResult = await pluginManager.runHook("before_agent_start", {
          message: ctx.effectiveMessage,
          sessionId: ctx.sessionId,
          channel: ctx.channel,
          peerId: ctx.peerId,
          agentId: ctx.agentId,
          attachments: ctx.attachments,
          metadata: ctx.metadata,
        });

        // If a plugin returns a modified message, apply it
        if (hookResult && typeof hookResult === "object") {
          if (typeof hookResult.message === "string") {
            ctx.effectiveMessage = hookResult.message;
          }
          if (typeof hookResult.shortCircuit === "boolean" && hookResult.shortCircuit) {
            ctx.shortCircuit = true;
            ctx.shortCircuitReply = hookResult.reply ?? hookResult.shortCircuitReply;
          }
          if (Array.isArray(hookResult.warnings)) {
            ctx.warnings.push(...hookResult.warnings);
          }
          if (hookResult.metadata && typeof hookResult.metadata === "object") {
            Object.assign(ctx.metadata, hookResult.metadata);
          }
        }
      } catch (error) {
        ctx.warnings.push(
          `Plugin pre-process hook error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return ctx;
    },
  };
}
