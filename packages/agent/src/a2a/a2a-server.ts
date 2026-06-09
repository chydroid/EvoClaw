import type { A2AAgentCard, A2ATask, A2ATaskResult, A2AServerConfig, A2ACapability } from "./types";
import type { ToolDefinition } from "../types";

export class A2AServer {
  private config: A2AServerConfig;
  private capabilities: A2ACapability[] = [];
  private taskHandler: ((task: A2ATask) => Promise<unknown>) | null = null;

  constructor(config?: Partial<A2AServerConfig>) {
    this.config = {
      publicUrl: config?.publicUrl ?? "http://localhost:27788",
      enabled: config?.enabled ?? false,
      authType: config?.authType ?? "none",
      validApiKeys: config?.validApiKeys,
    };
  }

  /** Set a custom task handler for incoming A2A tasks */
  setTaskHandler(handler: (task: A2ATask) => Promise<unknown>): void {
    this.taskHandler = handler;
  }

  /** Build capabilities from registered tools */
  buildCapabilitiesFromTools(tools: ToolDefinition[]): void {
    this.capabilities = tools.map(tool => ({
      id: tool.name,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as Record<string, unknown>,
    }));
  }

  /** Get the agent card */
  getAgentCard(): A2AAgentCard {
    return {
      name: "EvoClaw",
      description: "Self-evolving Agent OS with multi-layer memory, evolution engine, and 9 channel support",
      url: this.config.publicUrl,
      version: "0.13.8",
      capabilities: this.capabilities,
      authentication: { type: this.config.authType },
    };
  }

  /** Handle an incoming A2A task */
  async handleTask(task: A2ATask): Promise<A2ATaskResult> {
    if (!this.taskHandler) {
      return { taskId: task.id, status: "failed", error: "No task handler registered" };
    }

    const startTime = Date.now();
    try {
      const result = await this.taskHandler(task);
      return {
        taskId: task.id,
        status: "completed",
        output: result,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        taskId: task.id,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /** Validate authentication */
  validateAuth(apiKey?: string): boolean {
    if (this.config.authType === "none") return true;
    if (this.config.authType === "api_key") {
      return !!apiKey && (this.config.validApiKeys?.includes(apiKey) ?? false);
    }
    return false;
  }

  /** Check if server is enabled */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Update server config */
  configure(config: Partial<A2AServerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Get current config */
  getConfig(): A2AServerConfig {
    return { ...this.config };
  }
}
