// Enhanced Agent Executor - Integrates tool planning, availability, and hooks
import type { ToolDescriptor, ToolResult } from './tool-types.js';
import { buildToolPlan, type ToolPlan } from './tool-planner.js';
import { toOpenAITools, toAnthropicTools } from './tool-protocol.js';
import { createHookRunner, type HookRunner, type HookRunnerRegistry } from './hook-runner.js';

/**
 * Configuration for the enhanced agent executor
 */
export interface EnhancedAgentConfig {
  /** Available tool descriptors */
  toolDescriptors: ToolDescriptor[];
  
  /** Hook runner registry */
  hookRegistry: HookRunnerRegistry;
  
  /** LLM provider (OpenAI, Anthropic, etc.) */
  llmProvider: 'openai' | 'anthropic' | 'generic';
  
  /** LLM client interface */
  llmClient: {
    complete(params: {
      messages: any[];
      tools?: Array<Record<string, unknown>>;
    }): Promise<{
      content: string;
      toolCalls?: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
      }>;
    }>;
  };
  
  /** Maximum iterations to prevent infinite loops */
  maxIterations?: number;
}

/**
 * Message types for the agent loop
 */
type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: any[] }
  | { role: 'tool'; content: string; toolCallId: string };

/**
 * Enhanced agent executor with tool planning and hooks
 */
export class EnhancedAgentExecutor {
  private config: EnhancedAgentConfig;
  private hookRunner: HookRunner;
  private maxIterations: number;

  constructor(config: EnhancedAgentConfig) {
    this.config = config;
    this.hookRunner = createHookRunner(config.hookRegistry);
    this.maxIterations = config.maxIterations ?? 20;
  }

  /**
   * Execute a user task through the complete agent loop
   */
  async execute(userMessage: string): Promise<string> {
    // 1. Plan: Build tool plan with availability evaluation
    const plan = buildToolPlan({
      descriptors: this.config.toolDescriptors,
      // Availability context can be passed here if needed
    });

    process.stdout.write(`[EnhancedAgent] Planned ${plan.visible.length} visible tools, ${plan.hidden.length} hidden\n`);

    // 2. Convert tools to LLM provider format
    const tools = this.config.llmProvider === 'openai'
      ? toOpenAITools(plan.visible)
      : this.config.llmProvider === 'anthropic'
      ? toAnthropicTools(plan.visible)
      : toOpenAITools(plan.visible); // fallback to OpenAI format

    // 3. Initialize message history
    const messages: Message[] = [
      { role: 'user', content: userMessage }
    ];

    // 4. Agent loop: LLM decides tools, execute, repeat
    let iterations = 0;
    while (iterations < this.maxIterations) {
      iterations++;

      // Run before:agent_turn hooks
      if (this.hookRunner.hasHooks('before:agent_turn')) {
        await this.hookRunner.runVoidHook('before:agent_turn', {
          iteration: iterations,
          messageCount: messages.length,
        });
      }

      // Call LLM
      const response = await this.config.llmClient.complete({
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      // If no tool calls, we're done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        // Run after:agent_turn hooks
        if (this.hookRunner.hasHooks('after:agent_turn')) {
          await this.hookRunner.runVoidHook('after:agent_turn', {
            finalContent: response.content,
            iterations,
          });
        }

        return response.content;
      }

      // Add assistant message with tool calls to history
      messages.push({
        role: 'assistant',
        content: response.content || '',
        toolCalls: response.toolCalls,
      });

      // Execute each tool call
      for (const toolCall of response.toolCalls) {
        const tool = plan.visible.find((t) => t.descriptor.name === toolCall.name);
        
        if (!tool) {
          process.stderr.write(`[EnhancedAgent] Tool not found in plan: ${toolCall.name}\n`);
          messages.push({
            role: 'tool',
            content: `Error: Tool ${toolCall.name} not found`,
            toolCallId: toolCall.id,
          });
          continue;
        }

        // Run before:tool_call hooks
        if (this.hookRunner.hasHooks('before:tool_call')) {
          await this.hookRunner.runVoidHook('before:tool_call', {
            toolName: toolCall.name,
            args: toolCall.args,
          });
        }

        // Execute the tool
        let result: ToolResult;
        try {
          result = await tool.executor(toolCall.args as any);
        } catch (error) {
          process.stderr.write(`[EnhancedAgent] Tool execution failed: ${toolCall.name}` + " " + error + "\n");
          result = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        // Run after:tool_call hooks
        if (this.hookRunner.hasHooks('after:tool_call')) {
          await this.hookRunner.runVoidHook('after:tool_call', {
            toolName: toolCall.name,
            args: toolCall.args,
            result,
          });
        }

        // Add tool result to message history
        // 注意：JSON.stringify(undefined) 返回 undefined（非字符串），会破坏 LLM API 的 content: string 契约
        const resultContent = result.success 
          ? JSON.stringify(result.output ?? null) 
          : `Error: ${result.error}`;
        messages.push({
          role: 'tool',
          content: resultContent,
          toolCallId: toolCall.id,
        });
      }
    }

    // Max iterations reached
    process.stderr.write(`[EnhancedAgent] Max iterations (${this.maxIterations}) reached\n`);
    return 'I apologize, but I was unable to complete the task within the maximum number of iterations.';
  }
}
