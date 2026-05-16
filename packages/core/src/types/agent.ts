export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  state: AgentState;
  capabilities: AgentCapability[];
  config: AgentConfig;
  metrics: AgentMetrics;
}

export type AgentRole = "orchestrator" | "executor" | "analyst" | "observer" | "custom";

export interface AgentState {
  activeTaskId: string | null;
  status: AgentStatus;
  memoryContext: Record<string, unknown>;
  lastHeartbeat: Date;
  errorCount: number;
}

export type AgentStatus = "idle" | "busy" | "error" | "terminated" | "awaiting_input";

export interface AgentCapability {
  name: string;
  version: string;
  schema: Record<string, unknown>;
}

export interface AgentConfig {
  maxConcurrency: number;
  maxRetries: number;
  defaultTimeout: number;
  allowCodeExecution: boolean;
  allowedSkills: string[];
  temperature: number;
  maxTokens: number;
}

export interface AgentMetrics {
  tasksCompleted: number;
  tasksFailed: number;
  averageResponseTime: number;
  tokenUsage: number;
  costEstimate: number;
}

export interface AgentPool {
  acquire(role?: AgentRole): Promise<Agent | null>;
  release(agentId: string): Promise<void>;
  scale(delta: number): Promise<void>;
  terminate(agentId: string): Promise<void>;
  getMetrics(): Promise<PoolMetrics>;
  healthCheck(): Promise<HealthStatus[]>;
}

export interface PoolMetrics {
  totalAgents: number;
  activeAgents: number;
  idleAgents: number;
  queuedTasks: number;
  averageUtilization: number;
}

export interface HealthStatus {
  agentId: string;
  healthy: boolean;
  issues: string[];
}

export interface ActorMessage {
  type: string;
  sender: string;
  recipient: string;
  payload: unknown;
  correlationId: string;
  timestamp: Date;
  replyTo?: string;
}

export interface ActorRef {
  send(message: ActorMessage): Promise<void>;
  ask(message: ActorMessage): Promise<ActorMessage>;
  stop(): Promise<void>;
}