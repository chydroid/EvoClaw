/**
 * AgentLifecycleManager — OpenClaw-style agent lifecycle events with streaming status.
 *
 * Publishes lifecycle events (thinking, tool calls, responses, errors, etc.) via
 * the EventBus so that the WebUI can display real-time streaming status updates.
 */

import type { EventBus } from "@evoclaw/core";

/** Agent lifecycle event types */
export enum AgentLifecycleEvent {
  /** Agent received a new message and is starting to process */
  MESSAGE_RECEIVED = "agent.message.received",
  /** Agent is thinking (between tool calls or before response) */
  THINKING = "agent.thinking",
  /** A tool call was initiated */
  TOOL_CALL_START = "agent.tool_call.start",
  /** A tool call completed */
  TOOL_CALL_END = "agent.tool_call.end",
  /** A tool call failed */
  TOOL_CALL_ERROR = "agent.tool_call.error",
  /** Agent generated a response */
  RESPONSE = "agent.response",
  /** Agent encountered an error */
  ERROR = "agent.error",
  /** Session was compacted */
  COMPACTED = "agent.compacted",
  /** Agent is idle (waiting for input) */
  IDLE = "agent.idle",
  /** Periodic heartbeat check-in */
  HEARTBEAT = "agent.heartbeat",
  /** Permission was requested */
  PERMISSION_REQUESTED = "agent.permission.requested",
  /** Permission was resolved */
  PERMISSION_RESOLVED = "agent.permission.resolved",
  /** Agent loop iteration started */
  LOOP_START = "agent.loop.start",
  /** Agent loop iteration ended */
  LOOP_END = "agent.loop.end",
  /** Agent run started */
  RUN_START = "agent.run.start",
  /** Agent run ended */
  RUN_END = "agent.run.end",
}

/** Status state for streaming display */
export interface AgentStatus {
  sessionId: string;
  state: "idle" | "thinking" | "executing" | "responding" | "error" | "waiting_permission";
  currentAction: string;
  toolCalls: ToolCallStatus[];
  lastActivity: string;
  tokensUsed: number;
  duration: number;
  runId: number;
  progress?: {
    current: number;
    total: number;
    label: string;
  };
}

export interface ToolCallStatus {
  name: string;
  status: "pending" | "running" | "done" | "error";
  result?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
}

export interface LifecycleEventData {
  sessionId: string;
  runId: number;
  timestamp: string;
  [key: string]: unknown;
}

export interface ErrorEvent extends LifecycleEventData {
  error: string;
  errorType?: string;
  recoverable: boolean;
}

export interface ToolCallEvent extends LifecycleEventData {
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  duration?: number;
}

export interface CompactionEvent extends LifecycleEventData {
  compactedTurns: number;
  successorSessionId: string;
}

export interface PermissionEvent extends LifecycleEventData {
  requestId: string;
  operation?: string;
  target?: string;
  description?: string;
  resolved?: boolean;
  approved?: boolean;
}

export class AgentLifecycleManager {
  private statuses = new Map<string, AgentStatus>();
  private runIdCounter = 0;

  constructor(private eventBus: EventBus) {}

  // ====== Run Management ======

  /** Start a new agent run */
  startRun(sessionId: string): number {
    const runId = ++this.runIdCounter;
    const status: AgentStatus = {
      sessionId,
      state: "thinking",
      currentAction: "Initializing...",
      toolCalls: [],
      lastActivity: new Date().toISOString(),
      tokensUsed: 0,
      duration: 0,
      runId,
    };
    this.statuses.set(sessionId, status);

    this.eventBus.publish(
      AgentLifecycleEvent.RUN_START,
      { sessionId, runId, timestamp: new Date().toISOString() },
      "agent-lifecycle",
    );

    return runId;
  }

  /** End an agent run */
  endRun(sessionId: string, runId: number, success: boolean): void {
    const status = this.statuses.get(sessionId);
    if (status) {
      status.state = "idle";
      status.currentAction = success ? "Completed" : "Ended with errors";
    }

    this.eventBus.publish(
      AgentLifecycleEvent.RUN_END,
      {
        sessionId,
        runId,
        success,
        timestamp: new Date().toISOString(),
      },
      "agent-lifecycle",
    );
  }

  // ====== Thinking ======

  /** Agent started thinking/processing */
  thinking(sessionId: string, runId: number, about: string): void {
    const status = this.statuses.get(sessionId);
    if (status) {
      status.state = "thinking";
      status.currentAction = about;
      status.lastActivity = new Date().toISOString();
    }

    this.eventBus.publish(
      AgentLifecycleEvent.THINKING,
      { sessionId, runId, about, timestamp: new Date().toISOString() },
      "agent-lifecycle",
    );
  }

  // ====== Tool Calls ======

  /** Tool call started */
  toolCallStart(
    sessionId: string,
    runId: number,
    toolName: string,
    toolCallId: string,
    args?: Record<string, unknown>,
  ): void {
    const status = this.statuses.get(sessionId);
    const now = new Date().toISOString();

    const tcStatus: ToolCallStatus = {
      name: toolName,
      status: "running",
      startedAt: now,
    };

    if (status) {
      status.state = "executing";
      status.currentAction = `Calling tool: ${toolName}`;
      status.toolCalls.push(tcStatus);
      status.lastActivity = now;
    }

    this.eventBus.publish(
      AgentLifecycleEvent.TOOL_CALL_START,
      {
        sessionId,
        runId,
        toolName,
        toolCallId,
        args,
        timestamp: now,
      } satisfies ToolCallEvent,
      "agent-lifecycle",
    );
  }

  /** Tool call completed successfully */
  toolCallEnd(
    sessionId: string,
    runId: number,
    toolName: string,
    toolCallId: string,
    result?: unknown,
    duration?: number,
  ): void {
    const status = this.statuses.get(sessionId);
    const now = new Date().toISOString();

    if (status) {
      const tc = status.toolCalls.find(
        (t) => t.name === toolName && t.status === "running",
      );
      if (tc) {
        tc.status = "done";
        tc.endedAt = now;
        tc.result = typeof result === "string" ? result.slice(0, 500) : "OK";
      }
      status.lastActivity = now;
    }

    this.eventBus.publish(
      AgentLifecycleEvent.TOOL_CALL_END,
      {
        sessionId,
        runId,
        toolName,
        toolCallId,
        result: typeof result === "string" ? result.slice(0, 500) : undefined,
        duration,
        timestamp: now,
      } satisfies ToolCallEvent,
      "agent-lifecycle",
    );
  }

  /** Tool call failed */
  toolCallError(
    sessionId: string,
    runId: number,
    toolName: string,
    toolCallId: string,
    error: string,
  ): void {
    const status = this.statuses.get(sessionId);
    const now = new Date().toISOString();

    if (status) {
      const tc = status.toolCalls.find(
        (t) => t.name === toolName && t.status === "running",
      );
      if (tc) {
        tc.status = "error";
        tc.endedAt = now;
        tc.error = error;
      }
      status.lastActivity = now;
    }

    this.eventBus.publish(
      AgentLifecycleEvent.TOOL_CALL_ERROR,
      {
        sessionId,
        runId,
        toolName,
        toolCallId,
        error,
        timestamp: now,
      } satisfies ToolCallEvent,
      "agent-lifecycle",
    );
  }

  // ====== Response & Error ======

  /** Agent generated response */
  response(
    sessionId: string,
    runId: number,
    tokensUsed: number,
    duration: number,
    hasPermissions: boolean,
  ): void {
    const status = this.statuses.get(sessionId);
    if (status) {
      status.state = hasPermissions ? "waiting_permission" : "responding";
      status.currentAction = hasPermissions
        ? "Waiting for permission..."
        : "Responded";
      status.tokensUsed += tokensUsed;
      status.duration += duration;
      status.lastActivity = new Date().toISOString();
    }

    this.eventBus.publish(
      AgentLifecycleEvent.RESPONSE,
      {
        sessionId,
        runId,
        tokensUsed,
        duration,
        hasPermissions,
        timestamp: new Date().toISOString(),
      },
      "agent-lifecycle",
    );
  }

  /** Agent encountered an error */
  error(
    sessionId: string,
    runId: number,
    error: string,
    errorType?: string,
    recoverable = true,
  ): void {
    const status = this.statuses.get(sessionId);
    if (status) {
      status.state = "error";
      status.currentAction = `Error: ${error.slice(0, 100)}`;
      status.lastActivity = new Date().toISOString();
    }

    this.eventBus.publish(
      AgentLifecycleEvent.ERROR,
      {
        sessionId,
        runId,
        error,
        errorType,
        recoverable,
        timestamp: new Date().toISOString(),
      } satisfies ErrorEvent,
      "agent-lifecycle",
    );
  }

  // ====== Compaction ======

  /** Session was compacted */
  compacted(
    sessionId: string,
    compactedTurns: number,
    successorSessionId: string,
  ): void {
    this.eventBus.publish(
      AgentLifecycleEvent.COMPACTED,
      {
        sessionId,
        runId: 0,
        compactedTurns,
        successorSessionId,
        timestamp: new Date().toISOString(),
      } satisfies CompactionEvent,
      "agent-lifecycle",
    );
  }

  // ====== Permission ======

  /** Permission was requested */
  permissionRequested(
    sessionId: string,
    requestId: string,
    operation: string,
    target: string,
    description: string,
  ): void {
    const status = this.statuses.get(sessionId);
    if (status) {
      status.state = "waiting_permission";
      status.currentAction = `Permission needed: ${operation} ${target}`;
      status.lastActivity = new Date().toISOString();
    }

    this.eventBus.publish(
      AgentLifecycleEvent.PERMISSION_REQUESTED,
      {
        sessionId,
        runId: 0,
        requestId,
        operation,
        target,
        description,
        timestamp: new Date().toISOString(),
      } satisfies PermissionEvent,
      "agent-lifecycle",
    );
  }

  /** Permission was resolved */
  permissionResolved(
    sessionId: string,
    requestId: string,
    approved: boolean,
  ): void {
    const status = this.statuses.get(sessionId);
    if (status) {
      status.state = "thinking";
      status.currentAction = approved
        ? "Resuming after permission granted..."
        : "Permission denied, adjusting...";
      status.lastActivity = new Date().toISOString();
    }

    this.eventBus.publish(
      AgentLifecycleEvent.PERMISSION_RESOLVED,
      {
        sessionId,
        runId: 0,
        requestId,
        resolved: true,
        approved,
        timestamp: new Date().toISOString(),
      } satisfies PermissionEvent,
      "agent-lifecycle",
    );
  }

  // ====== Heartbeat ======

  /** Periodic heartbeat */
  heartbeat(sessionId: string): void {
    this.eventBus.publish(
      AgentLifecycleEvent.HEARTBEAT,
      {
        sessionId,
        runId: 0,
        timestamp: new Date().toISOString(),
      },
      "agent-lifecycle",
    );
  }

  // ====== Status Queries ======

  /** Set agent to idle */
  setIdle(sessionId: string): void {
    const status = this.statuses.get(sessionId);
    if (status) {
      status.state = "idle";
      status.currentAction = "Waiting for input";
      status.lastActivity = new Date().toISOString();
    }

    this.eventBus.publish(
      AgentLifecycleEvent.IDLE,
      {
        sessionId,
        runId: 0,
        timestamp: new Date().toISOString(),
      },
      "agent-lifecycle",
    );
  }

  /** Get current status for a session */
  getStatus(sessionId: string): AgentStatus | undefined {
    return this.statuses.get(sessionId);
  }

  /** Get all active statuses */
  getAllStatuses(): AgentStatus[] {
    return Array.from(this.statuses.values());
  }

  /** Update progress indicator */
  setProgress(
    sessionId: string,
    current: number,
    total: number,
    label: string,
  ): void {
    const status = this.statuses.get(sessionId);
    if (status) {
      status.progress = { current, total, label };
      status.lastActivity = new Date().toISOString();
    }
  }

  /** Clear status for a session */
  clearStatus(sessionId: string): void {
    this.statuses.delete(sessionId);
  }

  /** Clear all statuses */
  clearAll(): void {
    this.statuses.clear();
  }
}