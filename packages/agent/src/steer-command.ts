/**
 * /steer Command — inject real-time instructions while the agent is running
 * Inspired by OpenClaw 2026.5.4: "/steer command for real-time agent control"
 *
 * Allows users to modify agent behavior mid-execution without stopping it.
 */

import * as crypto from "crypto";

export interface SteerInstruction {
  id: string;
  sessionId: string;
  instruction: string;
  priority: "low" | "normal" | "high" | "critical";
  category: "redirect" | "constraint" | "emphasis" | "cancel" | "info";
  createdAt: number;
  consumed: boolean;
  consumedAt?: number;
}

export interface SteerResult {
  accepted: boolean;
  instructionId: string;
  message: string;
  pendingCount: number;
}

export class SteerManager {
  private static readonly MAX_INSTRUCTIONS = 10000;
  private instructions: Map<string, SteerInstruction> = new Map();
  private sessionInstructions: Map<string, string[]> = new Map(); // sessionId -> instructionIds

  /**
   * Inject a steer instruction for a running agent session
   */
  steer(sessionId: string, instruction: string, options?: {
    priority?: SteerInstruction["priority"];
    category?: SteerInstruction["category"];
  }): SteerResult {
    const id = `steer-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
    const steerInstruction: SteerInstruction = {
      id,
      sessionId,
      instruction,
      priority: options?.priority ?? "normal",
      category: options?.category ?? "redirect",
      createdAt: Date.now(),
      consumed: false,
    };

    this.instructions.set(id, steerInstruction);
    this.enforceInstructionLimit();

    const sessionIds = this.sessionInstructions.get(sessionId) || [];
    sessionIds.push(id);
    this.sessionInstructions.set(sessionId, sessionIds);

    return {
      accepted: true,
      instructionId: id,
      message: `Instruction injected: "${instruction.slice(0, 50)}${instruction.length > 50 ? "..." : ""}"`,
      pendingCount: sessionIds.filter(sid => !this.instructions.get(sid)?.consumed).length,
    };
  }

  private enforceInstructionLimit(): void {
    while (this.instructions.size > SteerManager.MAX_INSTRUCTIONS) {
      const firstKey = this.instructions.keys().next().value;
      if (!firstKey) break;
      const instruction = this.instructions.get(firstKey);
      this.instructions.delete(firstKey);
      if (instruction) {
        const ids = this.sessionInstructions.get(instruction.sessionId);
        if (ids) {
          const idx = ids.indexOf(firstKey);
          if (idx >= 0) ids.splice(idx, 1);
          if (ids.length === 0) this.sessionInstructions.delete(instruction.sessionId);
        }
      }
    }
  }

  /**
   * Get pending (unconsumed) steer instructions for a session
   * Called by the agent loop to check for new instructions
   */
  getPendingInstructions(sessionId: string): SteerInstruction[] {
    const ids = this.sessionInstructions.get(sessionId) || [];
    return ids
      .map(id => this.instructions.get(id))
      .filter((i): i is SteerInstruction => i != null && !i.consumed)
      .sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
  }

  /**
   * Format pending instructions as a system message to inject into conversation
   */
  formatSteerMessage(sessionId: string): string | null {
    const pending = this.getPendingInstructions(sessionId);
    if (pending.length === 0) return null;

    const lines = pending.map(i => {
      const prefix = i.category === "cancel" ? "⛔" : i.priority === "critical" ? "🔴" : i.category === "constraint" ? "⚠️" : "🔵";
      return `${prefix} [${i.category.toUpperCase()}] ${i.instruction}`;
    });

    // Mark as consumed
    for (const i of pending) {
      i.consumed = true;
      i.consumedAt = Date.now();
    }

    return `[实时指令] 用户在执行过程中注入了以下指令，请优先遵循：\n${lines.join("\n")}`;
  }

  /**
   * Cancel a specific steer instruction
   */
  cancelInstruction(instructionId: string): boolean {
    const instruction = this.instructions.get(instructionId);
    if (!instruction) return false;
    instruction.consumed = true;
    instruction.consumedAt = Date.now();
    return true;
  }

  /**
   * Get instruction history for a session
   */
  getHistory(sessionId: string, includeConsumed?: boolean): SteerInstruction[] {
    const ids = this.sessionInstructions.get(sessionId) || [];
    return ids
      .map(id => this.instructions.get(id))
      .filter((i): i is SteerInstruction => i != null && (includeConsumed || !i.consumed));
  }

  /**
   * Clear all instructions for a session
   */
  clearSession(sessionId: string): void {
    const ids = this.sessionInstructions.get(sessionId) || [];
    for (const id of ids) {
      this.instructions.delete(id);
    }
    this.sessionInstructions.delete(sessionId);
  }

  /**
   * Get stats
   */
  getStats(): { totalInjected: number; pendingCount: number; consumedCount: number } {
    const all = Array.from(this.instructions.values());
    return {
      totalInjected: all.length,
      pendingCount: all.filter(i => !i.consumed).length,
      consumedCount: all.filter(i => i.consumed).length,
    };
  }
}
