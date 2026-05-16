export interface Task {
  id: string;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  context: TaskContext;
  dag: DAGNode[];
  executionPlan: ExecutionStep[];
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  retryCount: number;
  maxRetries: number;
}

export type TaskType = "chat" | "skill_execution" | "automation" | "analysis" | "evolution" | "system";

export type TaskPriority = "critical" | "high" | "normal" | "low" | "background";

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "paused"
  | "waiting_dependency"
  | "completed"
  | "failed"
  | "cancelled"
  | "rolled_back";

export interface TaskContext {
  sessionId: string;
  userId: string;
  parentTaskId?: string;
  workspace: string;
  variables: Record<string, unknown>;
  tags: string[];
  traceId: string;
}

export interface DAGNode {
  id: string;
  action: string;
  skill?: string;
  dependencies: string[];
  params: Record<string, unknown>;
  timeout: number;
  condition?: string;
}

export interface ExecutionStep {
  nodeId: string;
  status: TaskStatus;
  startedAt?: Date;
  completedAt?: Date;
  attempt: number;
  result: StepResult | null;
  error?: string;
}

export interface StepResult {
  success: boolean;
  data: unknown;
  artifacts: Artifact[];
  metrics: StepMetrics;
}

export interface Artifact {
  name: string;
  type: string;
  path: string;
  size: number;
  metadata: Record<string, unknown>;
}

export interface StepMetrics {
  startTime: Date;
  endTime: Date;
  durationMs: number;
  cpuUsage: number;
  memoryUsageMB: number;
}

export interface TaskQueue {
  enqueue(task: Task): Promise<void>;
  dequeue(): Promise<Task | null>;
  peek(): Promise<Task | null>;
  size(): Promise<number>;
  remove(taskId: string): Promise<boolean>;
  reorder(taskId: string, priority: TaskPriority): Promise<void>;
}

export interface ITaskExecutor {
  execute(task: Task): Promise<Task>;
  cancel(taskId: string): Promise<void>;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  getStatus(taskId: string): Promise<TaskStatus>;
  getProgress(taskId: string): Promise<number>;
}