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
  publish<K extends keyof EventMap>(eventType: K, data: EventMap[K], source: string): Promise<void>;
  publish(eventType: string, data: unknown, source: string): Promise<void>;
  subscribe<K extends keyof EventMap>(eventType: K, handler: EventHandler<EventMap[K]>): EventSubscription;
  subscribe<T>(eventType: string, handler: EventHandler<T>): EventSubscription;
  unsubscribe(subscriptionId: string): void;
  once<K extends keyof EventMap>(eventType: K, handler: EventHandler<EventMap[K]>): EventSubscription;
  once<T>(eventType: string, handler: EventHandler<T>): EventSubscription;
}

/**
 * Typed event map — maps event type strings to their payload types.
 * Add new event types here to get compile-time safety on publish/subscribe.
 */
export interface EventMap {
  "skill.installed": { skillId: string; name: string; version: string };
  "skill.updated": { skillId: string; name: string; fromVersion: string; toVersion: string };
  "skill.uninstalled": { skillId: string; name: string };
  "skill.executed": { skillId: string; name: string; duration: number; success: boolean };
  "skill.failed": { skillId: string; name: string; error: string };

  "task.created": { id: string; type: string; priority: string };
  "task.started": { id: string; type: string };
  "task.completed": { id: string; type: string; duration: number };
  "task.failed": { id: string; type: string; error: string };
  "task.cancelled": { id: string; type: string };
  "task.retrying": { id: string; type: string; attempt: number };

  "agent.registered": { agentId: string; role: string };
  "agent.terminated": { agentId: string; reason: string };
  "agent.error": { agentId: string; error: string };

  "evolution.started": { cycleId: string };
  "evolution.candidate_generated": { candidateId: string; cycleId: string };
  "evolution.published": { candidateId: string; version: string };
  "evolution.rollback": { candidateId: string; reason: string };

  "security.alert": { severity: string; message: string; source: string };
  "security.breach": { severity: string; message: string; source: string };
  "security.rate_limit_exceeded": { source: string; limit: number };

  "memory.stored": { key: string; type: string };
  "memory.retrieved": { key: string; type: string };
  "memory.expired": { key: string };

  "system.starting": { version: string };
  "system.ready": { port: number; host: string };
  "system.shutting_down": { reason: string };
  "system.error": { error: string };

  "learning.entry_created": { entryId: string; category: string };
  "learning.entry_resolved": { entryId: string; resolution: string };
  "learning.session_started": { sessionId: string };
  "learning.session_completed": { sessionId: string; entriesCount: number };
  "learning.journal_updated": { totalEntries: number };

  "progress.reported": { taskId: string; progress: number; message: string };
  "progress.phase_changed": { taskId: string; phase: string };
  "progress.completed": { taskId: string; result: unknown };

  "user.correction_received": { sessionId: string; correction: string };
  "capability.gap_detected": { capability: string; description: string };
  "external.failure_detected": { service: string; error: string };
  "knowledge.improvement_found": { topic: string; improvement: string };
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