export interface EvoEvent<T = unknown> {
  id: string;
  type: string;
  source: string;
  timestamp: Date;
  data: T;
  correlationId?: string;
  causationId?: string;
  metadata: Record<string, unknown>;
}

export type EventHandler<T = unknown> = (event: EvoEvent<T>) => Promise<void>;

export interface EventSubscription {
  id: string;
  eventType: string;
  handler: EventHandler;
  filter?: (event: EvoEvent) => boolean;
}

export interface IEventBus {
  publish<T>(eventType: string, data: T, source: string): Promise<void>;
  subscribe<T>(eventType: string, handler: EventHandler<T>): EventSubscription;
  unsubscribe(subscriptionId: string): void;
  once<T>(eventType: string, handler: EventHandler<T>): EventSubscription;
}

export const SystemEvents = {
  SKILL_INSTALLED: "skill.installed",
  SKILL_UPDATED: "skill.updated",
  SKILL_UNINSTALLED: "skill.uninstalled",
  SKILL_EXECUTED: "skill.executed",
  SKILL_FAILED: "skill.failed",

  TASK_CREATED: "task.created",
  TASK_STARTED: "task.started",
  TASK_COMPLETED: "task.completed",
  TASK_FAILED: "task.failed",
  TASK_CANCELLED: "task.cancelled",
  TASK_RETRYING: "task.retrying",

  AGENT_REGISTERED: "agent.registered",
  AGENT_TERMINATED: "agent.terminated",
  AGENT_ERROR: "agent.error",

  EVOLUTION_STARTED: "evolution.started",
  EVOLUTION_CANDIDATE_GENERATED: "evolution.candidate_generated",
  EVOLUTION_PUBLISHED: "evolution.published",
  EVOLUTION_ROLLBACK: "evolution.rollback",

  SECURITY_ALERT: "security.alert",
  SECURITY_BREACH: "security.breach",
  RATE_LIMIT_EXCEEDED: "security.rate_limit_exceeded",

  MEMORY_STORED: "memory.stored",
  MEMORY_RETRIEVED: "memory.retrieved",
  MEMORY_EXPIRED: "memory.expired",

  SYSTEM_STARTING: "system.starting",
  SYSTEM_READY: "system.ready",
  SYSTEM_SHUTTING_DOWN: "system.shutting_down",
  SYSTEM_ERROR: "system.error",

  LEARNING_ENTRY_CREATED: "learning.entry_created",
  LEARNING_ENTRY_RESOLVED: "learning.entry_resolved",
  LEARNING_SESSION_STARTED: "learning.session_started",
  LEARNING_SESSION_COMPLETED: "learning.session_completed",
  LEARNING_JOURNAL_UPDATED: "learning.journal_updated",

  PROGRESS_REPORTED: "progress.reported",
  PROGRESS_PHASE_CHANGED: "progress.phase_changed",
  PROGRESS_COMPLETED: "progress.completed",

  USER_CORRECTION_RECEIVED: "user.correction_received",
  CAPABILITY_GAP_DETECTED: "capability.gap_detected",
  EXTERNAL_FAILURE_DETECTED: "external.failure_detected",
  KNOWLEDGE_IMPROVEMENT_FOUND: "knowledge.improvement_found",
} as const;