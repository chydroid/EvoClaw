/**
 * Agent Router — OpenClaw-style multi-agent routing system.
 *
 * Routes incoming messages to isolated agents based on:
 * - Channel (e.g., "webchat", "telegram", "discord")
 * - Account/peer identity
 * - Explicit bindings configuration
 *
 * Each agent runs in its own workspace with independent:
 * - System prompt (AGENTS.md, SOUL.md)
 * - Session history
 * - Tool policy
 * - Model configuration
 *
 * Routing priority: peer match > channel match > default agent
 */

import * as path from "path";
import * as fs from "fs";
import type { PersonaConfig } from "@evoclaw/core";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentBinding {
  /** Channel name (webchat, telegram, discord, etc.) */
  channel: string;
  /** Optional: specific account within the channel */
  account?: string;
  /** Optional: specific peer (user/chat ID) to bind to */
  peer?: string;
  /** Pattern match for peers (e.g., "+1*" matches all US numbers) */
  peerPattern?: string;
  /** Target agent ID to route to */
  agentId: string;
  /** Priority: higher wins in conflicts */
  priority?: number;
}

export interface AgentConfig {
  /** Unique agent identifier */
  id: string;
  /** Display name */
  name: string;
  /** System prompt persona */
  persona: PersonaConfig;
  /** Workspace directory (relative or absolute) */
  workspace: string;
  /** Session storage directory */
  sessionsDir: string;
  /** Model override (optional, uses default if not set) */
  model?: string;
  /** Provider override */
  provider?: string;
  /** Tool policy: which tools this agent can use */
  toolPolicy?: ToolPolicy;
  /** Whether this agent is active */
  enabled: boolean;
  /** Bootstrap files to load */
  bootstrapFiles?: string[];
  /** DM access policy */
  dmPolicy?: "open" | "pairing" | "allowlist";
  /** Allowlist of peer IDs (when dmPolicy is "allowlist") */
  allowlist?: string[];
  /** Sandbox mode */
  sandbox?: "off" | "non-main" | "all";
}

export interface ToolPolicy {
  /** Allowlist mode: only these tools are allowed */
  mode: "allowlist" | "denylist";
  /** Tool names to allow/deny */
  tools: string[];
  /** Whether to allow shell execution */
  allowShell?: boolean;
  /** Whether to allow file operations */
  allowFileOps?: boolean;
  /** Whether to allow web access */
  allowWeb?: boolean;
  /** Whether to allow browser automation */
  allowBrowser?: boolean;
  /** Max file size for operations (bytes) */
  maxFileSize?: number;
}

export interface RouteRequest {
  channel: string;
  account?: string;
  peer?: string;
  sessionId?: string;
}

export interface ResolvedRoute {
  agentId: string;
  agent: AgentConfig;
  binding: AgentBinding | null;
  matchedBy: "peer" | "peerPattern" | "channel" | "default";
}

export interface RouterConfig {
  /** Agent definitions */
  agents: AgentConfig[];
  /** Bindings mapping channels/peers to agents */
  bindings: AgentBinding[];
  /** Default agent ID (used when no binding matches) */
  defaultAgentId: string;
  /** Base directory for agent workspaces */
  baseWorkspaceDir: string;
  /** Base directory for session storage */
  baseSessionsDir: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  agents: [],
  bindings: [],
  defaultAgentId: "default",
  baseWorkspaceDir: "data/workspace",
  baseSessionsDir: "data/sessions",
};

const DEFAULT_AGENT_CONFIG: Partial<AgentConfig> = {
  enabled: true,
  dmPolicy: "open",
  sandbox: "off",
};

// ─── Agent Router ─────────────────────────────────────────────────────────────

export class AgentRouter {
  private config: RouterConfig;
  private agentMap = new Map<string, AgentConfig>();
  private bindingsList: AgentBinding[] = [];

  constructor(config?: Partial<RouterConfig>) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
    this.rebuildIndex();
  }

  // ── Configuration ──

  /** Add or update an agent */
  registerAgent(config: AgentConfig): void {
    const existing = this.config.agents.findIndex((a) => a.id === config.id);
    const merged = { ...DEFAULT_AGENT_CONFIG, ...config };
    if (existing >= 0) {
      this.config.agents[existing] = merged;
    } else {
      this.config.agents.push(merged);
    }
    this.rebuildIndex();
  }

  /** Remove an agent */
  removeAgent(agentId: string): boolean {
    const idx = this.config.agents.findIndex((a) => a.id === agentId);
    if (idx < 0) return false;

    // Re-route any bindings pointing to this agent
    this.config.bindings = this.config.bindings.filter((b) => b.agentId !== agentId);

    // Update default if needed
    if (this.config.defaultAgentId === agentId) {
      const remaining = this.config.agents.filter((a) => a.id !== agentId);
      this.config.defaultAgentId = remaining[0]?.id || "default";
    }

    this.config.agents.splice(idx, 1);
    this.rebuildIndex();
    return true;
  }

  /** Add or update a binding */
  registerBinding(binding: AgentBinding): void {
    const key = this.bindingKey(binding);
    const existing = this.config.bindings.findIndex((b) => this.bindingKey(b) === key);
    if (existing >= 0) {
      this.config.bindings[existing] = { ...binding, priority: binding.priority ?? 10 };
    } else {
      this.config.bindings.push({ ...binding, priority: binding.priority ?? 10 });
    }
    this.rebuildIndex();
  }

  /** Remove a binding */
  removeBinding(binding: AgentBinding): boolean {
    const key = this.bindingKey(binding);
    const idx = this.config.bindings.findIndex((b) => this.bindingKey(b) === key);
    if (idx < 0) return false;
    this.config.bindings.splice(idx, 1);
    this.rebuildIndex();
    return true;
  }

  setDefaultAgent(agentId: string): void {
    if (!this.agentMap.has(agentId)) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    this.config.defaultAgentId = agentId;
  }

  // ── Routing ──

  /** Resolve which agent should handle a request */
  resolveRoute(request: RouteRequest): ResolvedRoute {
    // Sort bindings by priority (highest first)
    const sorted = [...this.bindingsList].sort((a, b) => (b.priority ?? 10) - (a.priority ?? 10));

    // 1. Exact peer match
    if (request.peer) {
      for (const binding of sorted) {
        if (binding.channel === request.channel && binding.peer === request.peer) {
          const agent = this.agentMap.get(binding.agentId);
          if (agent?.enabled) {
            return { agentId: binding.agentId, agent, binding, matchedBy: "peer" };
          }
        }
      }
    }

    // 2. Peer pattern match
    if (request.peer) {
      for (const binding of sorted) {
        if (binding.channel === request.channel && binding.peerPattern) {
          try {
            const regex = new RegExp(binding.peerPattern);
            if (regex.test(request.peer)) {
              const agent = this.agentMap.get(binding.agentId);
              if (agent?.enabled) {
                return { agentId: binding.agentId, agent, binding, matchedBy: "peerPattern" };
              }
            }
          } catch {
            // Invalid regex, skip
          }
        }
      }
    }

    // 3. Channel match (with optional account)
    for (const binding of sorted) {
      if (binding.channel === request.channel && !binding.peer && !binding.peerPattern) {
        if (!binding.account || binding.account === (request.account ?? "default")) {
          const agent = this.agentMap.get(binding.agentId);
          if (agent?.enabled) {
            return { agentId: binding.agentId, agent, binding, matchedBy: "channel" };
          }
        }
      }
    }

    // 4. Default agent
    const defaultAgent = this.agentMap.get(this.config.defaultAgentId);
    if (defaultAgent?.enabled) {
      return {
        agentId: this.config.defaultAgentId,
        agent: defaultAgent,
        binding: null,
        matchedBy: "default",
      };
    }

    // 5. Last resort: first available agent
    const first = this.config.agents.find((a) => a.enabled);
    if (first) {
      return { agentId: first.id, agent: first, binding: null, matchedBy: "default" };
    }

    throw new Error("No enabled agents available");
  }

  /** Build a session key that includes agent identity for isolation */
  buildSessionKey(request: RouteRequest): string {
    const route = this.resolveRoute(request);
    const parts = [route.agentId, request.channel];
    if (request.account) parts.push(request.account);
    if (request.peer) parts.push(request.peer);
    if (request.sessionId) parts.push(request.sessionId);
    return parts.join(":");
  }

  // ── Query ──

  getAgent(agentId: string): AgentConfig | undefined {
    return this.agentMap.get(agentId);
  }

  listAgents(): AgentConfig[] {
    return [...this.config.agents];
  }

  listBindings(): AgentBinding[] {
    return [...this.config.bindings];
  }

  getDefaultAgentId(): string {
    return this.config.defaultAgentId;
  }

  /** Get tool policy for a specific agent, merged with defaults */
  getEffectiveToolPolicy(agentId: string): ToolPolicy {
    const agent = this.agentMap.get(agentId);
    if (agent?.toolPolicy) return agent.toolPolicy;

    // Default: allow all for main agent
    return {
      mode: "allowlist",
      tools: ["*"],
      allowShell: true,
      allowFileOps: true,
      allowWeb: true,
      allowBrowser: true,
    };
  }

  /** Check if a specific tool is allowed for this agent */
  isToolAllowed(agentId: string, toolName: string): boolean {
    const policy = this.getEffectiveToolPolicy(agentId);
    if (policy.mode === "denylist") {
      return !policy.tools.includes(toolName);
    }
    // allowlist mode
    if (policy.tools.includes("*")) return true;
    return policy.tools.includes(toolName);
  }

  // ── Persistence ──

  /** Export router configuration to JSON */
  exportConfig(): RouterConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  /** Import router configuration from JSON */
  importConfig(config: RouterConfig): void {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
    this.rebuildIndex();
  }

  /** Save configuration to a file */
  saveToFile(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(this.config, null, 2), "utf-8");
  }

  /** Load configuration from a file */
  static loadFromFile(filePath: string): AgentRouter {
    if (!fs.existsSync(filePath)) {
      return new AgentRouter();
    }
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const config = JSON.parse(raw) as RouterConfig;
      return new AgentRouter(config);
    } catch (err) {
      process.stderr.write(`[AgentRouter] Failed to load config from ${filePath}, using defaults:` + " " + (err instanceof Error ? err.message : String(err)) + "\n");
      return new AgentRouter();
    }
  }

  // ── Internal ──

  private rebuildIndex(): void {
    this.agentMap.clear();
    for (const agent of this.config.agents) {
      this.agentMap.set(agent.id, agent);
    }
    // Sort bindings by priority descending
    this.bindingsList = [...this.config.bindings].sort(
      (a, b) => (b.priority ?? 10) - (a.priority ?? 10)
    );
  }

  private bindingKey(binding: AgentBinding): string {
    return `${binding.channel}:${binding.account ?? "*"}:${binding.peer ?? "*"}`;
  }
}