import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { A2AAgentCard, A2ATask, A2ATaskResult, A2AServerConfig, A2ACapability } from "./types";
import type { ToolDefinition } from "../types";

/** 从根 package.json 动态读取版本号 */
function readVersionFromPackageJson(): string {
  try {
    const candidates = [
      path.resolve(__dirname, "../../../../package.json"),
      path.resolve(__dirname, "../../../package.json"),
      path.resolve(process.cwd(), "package.json"),
    ];
    for (const pkgPath of candidates) {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.version && pkg.name === "evoclaw") return pkg.version;
      }
    }
  } catch { /* version detection failed */ }
  return "0.0.0-unknown";
}

export class A2AServer {
  private config: A2AServerConfig;
  private capabilities: A2ACapability[] = [];
  private taskHandler: ((task: A2ATask) => Promise<unknown>) | null = null;
  private version: string;

  constructor(config?: Partial<A2AServerConfig>) {
    this.config = {
      publicUrl: config?.publicUrl ?? "http://localhost:27788",
      enabled: config?.enabled ?? false,
      authType: config?.authType ?? "none",
      validApiKeys: config?.validApiKeys,
    };
    this.version = config?.version ?? readVersionFromPackageJson();
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
      version: this.version,
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
      if (!apiKey) return false;
      const validKeys = this.config.validApiKeys ?? [];
      // 安全：使用恒定时间比较防止时序攻击
      return validKeys.some((validKey) => {
        const a = Buffer.from(apiKey, "utf8");
        const b = Buffer.from(validKey, "utf8");
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      });
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
