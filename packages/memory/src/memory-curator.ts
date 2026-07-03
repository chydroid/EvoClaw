import { createHash } from "crypto";
import type { MemoryEntry } from "@evoclaw/core";
import { inferCognitiveLayer, type CognitiveLayer } from "@evoclaw/core";
import { FTS5SearchEngine } from "./fts5-search";

export interface CurationDecision {
  shouldPersist: boolean;
  category: "user_preference" | "environment_fact" | "experience_lesson" | "task_pattern" | "none";
  importance: number;
  reason: string;
  /**
   * 认知层级（episodic/semantic/procedural）。
   * 由 category 推断：user_preference→semantic，environment_fact→semantic，
   * experience_lesson→episodic，task_pattern→procedural，none→episodic（默认）。
   */
  cognitiveLayer: CognitiveLayer;
}

export interface MemorySnapshot {
  memoryMd: string;
  userProfileMd: string;
  frozenAt: Date;
  hash: string;
}

const USER_PREFERENCE_PATTERNS = [
  /我喜欢/i, /我偏好/i, /我习惯/i, /我想要/i,
  /I prefer/i, /I like/i, /I always/i, /I never/i,
  /always use/i, /never use/i, /I want/i,
  /prefer\s+to/i, /rather\s+than/i, /instead\s+of/i,
];

const ENVIRONMENT_FACT_PATTERNS = [
  /\/[\w.-]+\/[\w.-]+/,
  /\bversion\b/i, /\bv\d+\.\d+/i,
  /\bconfig/i, /\bsetting/i,
  /\bpath\s*(?:is|=)\s*/i,
  /\bport\s*\d+\b/i,
  /\b(?:npm|yarn|pnpm|pip|cargo)\s/i,
  /\b(?:typescript|javascript|python|rust|go|java)\b/i,
];

const EXPERIENCE_LESSON_PATTERNS = [
  /don'?t forget/i, /important/i, /note that/i, /make sure/i,
  /注意/i, /切记/i, /重要/i, /务必/i, /小心/i,
  /workaround/i, /gotcha/i, /pitfall/i,
  /error/i, /failed/i, /fix/i, /bug/i,
  /lesson/i, /learned/i, /经验/i, /教训/i,
];

const TASK_PATTERN_PATTERNS = [
  /step\s+\d/i, /first.*then/i, /after.*before/i,
  /第一步/i, /第二步/i, /首先.*然后/i,
  /workflow/i, /pipeline/i, /流程/i,
];

const INJECTION_PATTERNS = [
  /ignore\s+previous/i, /disregard/i, /you\s+are\s+now/i,
  /new\s+instructions/i, /^system:/i, /forget\s+everything/i,
  /override/i, /jailbreak/i, /prompt\s+injection/i,
  /忽略.*之前/i, /你是/i, /新指令/i,
];

const SENSITIVE_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bAIza[a-zA-Z0-9_-]{35}\b/,
  /\bghp_[a-zA-Z0-9]{36}\b/,
  /\bpassword\s*[:=]\s*\S+/i,
  /\bsecret\s*[:=]\s*\S+/i,
  /\bapi[_-]?key\s*[:=]\s*\S+/i,
  /\btoken\s*[:=]\s*\S+/i,
  /\bBearer\s+[a-zA-Z0-9._-]+\b/i,
];

const CATEGORY_IMPORTANCE: Record<CurationDecision["category"], number> = {
  user_preference: 0.9,
  experience_lesson: 0.75,
  environment_fact: 0.6,
  task_pattern: 0.45,
  none: 0,
};

/**
 * category → cognitiveLayer 映射（认知科学三层记忆）。
 *
 * - user_preference → semantic（用户偏好是稳定的语义属性）
 * - environment_fact → semantic（环境事实是脱离上下文仍成立的语义知识）
 * - experience_lesson → episodic（经验教训是特定事件中习得的情景记忆）
 * - task_pattern → procedural（任务流程是"如何做"的程序记忆）
 * - none → episodic（默认归入情景层）
 */
const CATEGORY_COGNITIVE_LAYER: Record<CurationDecision["category"], CognitiveLayer> = {
  user_preference: "semantic",
  environment_fact: "semantic",
  experience_lesson: "episodic",
  task_pattern: "procedural",
  none: "episodic",
};

export class MemoryCurator {
  private fts5: FTS5SearchEngine;
  private snapshot: MemorySnapshot | null = null;
  private maxSnapshotChars: number;

  constructor(fts5: FTS5SearchEngine, maxSnapshotChars?: number) {
    this.fts5 = fts5;
    this.maxSnapshotChars = maxSnapshotChars ?? 2200;
  }

  evaluateForPersistence(
    userMessage: string,
    agentResponse: string,
    context: Record<string, unknown>
  ): CurationDecision {
    const combined = `${userMessage} ${agentResponse}`;

    if (this.scanForInjection(combined)) {
      return {
        shouldPersist: false,
        category: "none",
        importance: 0,
        reason: "Potential prompt injection detected",
        cognitiveLayer: CATEGORY_COGNITIVE_LAYER.none,
      };
    }

    if (this.scanForSensitiveInfo(combined)) {
      return {
        shouldPersist: false,
        category: "none",
        importance: 0,
        reason: "Sensitive information detected",
        cognitiveLayer: CATEGORY_COGNITIVE_LAYER.none,
      };
    }

    for (const pattern of USER_PREFERENCE_PATTERNS) {
      if (pattern.test(userMessage)) {
        return {
          shouldPersist: true,
          category: "user_preference",
          importance: CATEGORY_IMPORTANCE.user_preference,
          reason: "User preference indicator detected",
          cognitiveLayer: CATEGORY_COGNITIVE_LAYER.user_preference,
        };
      }
    }

    for (const pattern of EXPERIENCE_LESSON_PATTERNS) {
      if (pattern.test(combined)) {
        return {
          shouldPersist: true,
          category: "experience_lesson",
          importance: CATEGORY_IMPORTANCE.experience_lesson,
          reason: "Experience lesson indicator detected",
          cognitiveLayer: CATEGORY_COGNITIVE_LAYER.experience_lesson,
        };
      }
    }

    for (const pattern of ENVIRONMENT_FACT_PATTERNS) {
      if (pattern.test(combined)) {
        return {
          shouldPersist: true,
          category: "environment_fact",
          importance: CATEGORY_IMPORTANCE.environment_fact,
          reason: "Environment fact indicator detected",
          cognitiveLayer: CATEGORY_COGNITIVE_LAYER.environment_fact,
        };
      }
    }

    for (const pattern of TASK_PATTERN_PATTERNS) {
      if (pattern.test(combined)) {
        return {
          shouldPersist: true,
          category: "task_pattern",
          importance: CATEGORY_IMPORTANCE.task_pattern,
          reason: "Task pattern indicator detected",
          cognitiveLayer: CATEGORY_COGNITIVE_LAYER.task_pattern,
        };
      }
    }

    return {
      shouldPersist: false,
      category: "none",
      importance: 0,
      reason: "No persistable information detected",
      cognitiveLayer: CATEGORY_COGNITIVE_LAYER.none,
    };
  }

  async curateFromTurn(
    userMessage: string,
    agentResponse: string,
    context: Record<string, unknown>,
    memoryStore: { store(entry: MemoryEntry): Promise<MemoryEntry> }
  ): Promise<MemoryEntry | null> {
    const decision = this.evaluateForPersistence(userMessage, agentResponse, context);
    if (!decision.shouldPersist) return null;

    const content = `[${decision.category}] ${userMessage}`;
    const entry: MemoryEntry = {
      id: "",
      type: this.mapCategoryToType(decision.category),
      content,
      embedding: null,
      metadata: {
        source: "memory-curator",
        sessionId: (context.sessionId as string) ?? "",
        userId: (context.userId as string) ?? "",
        tags: [decision.category],
        importance: decision.importance,
        associations: [],
        entities: [],
      },
      ttl: 0,
      createdAt: new Date(),
      accessedAt: new Date(),
      // 明确设置认知层级，便于分层检索与衰减
      cognitiveLayer: decision.cognitiveLayer,
    };

    // 双重保险：若未设置 cognitiveLayer，由 type + metadata 推断
    if (!entry.cognitiveLayer) {
      entry.cognitiveLayer = inferCognitiveLayer(entry);
    }

    const stored = await memoryStore.store(entry);

    this.fts5.indexEntry(stored.id, stored.content, {
      sessionId: stored.metadata.sessionId,
      type: stored.type,
      createdAt: stored.createdAt,
    });

    this.invalidateSnapshot();

    return stored;
  }

  freezeSnapshot(allMemories: MemoryEntry[]): MemorySnapshot {
    const memoryMd = this.buildMemoryMd(allMemories);
    const userProfileMd = this.buildUserProfileMd(allMemories);
    const truncatedMemoryMd = memoryMd.length > this.maxSnapshotChars
      ? memoryMd.slice(0, this.maxSnapshotChars)
      : memoryMd;
    const truncatedUserProfileMd = userProfileMd.length > this.maxSnapshotChars
      ? userProfileMd.slice(0, this.maxSnapshotChars)
      : userProfileMd;
    const combined = truncatedMemoryMd + "\n" + truncatedUserProfileMd;
    const hash = createHash("sha256").update(combined).digest("hex");

    this.snapshot = {
      memoryMd: truncatedMemoryMd,
      userProfileMd: truncatedUserProfileMd,
      frozenAt: new Date(),
      hash,
    };

    return this.snapshot;
  }

  getSnapshot(): MemorySnapshot | null {
    return this.snapshot;
  }

  invalidateSnapshot(): void {
    this.snapshot = null;
  }

  private scanForInjection(content: string): boolean {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(content)) return true;
    }
    return false;
  }

  private scanForSensitiveInfo(content: string): boolean {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(content)) return true;
    }
    return false;
  }

  private mapCategoryToType(
    category: CurationDecision["category"]
  ): MemoryEntry["type"] {
    switch (category) {
      case "user_preference":
        return "feedback";
      case "environment_fact":
        return "knowledge";
      case "experience_lesson":
        return "experience";
      case "task_pattern":
        return "experience";
      default:
        return "conversation";
    }
  }

  private buildMemoryMd(allMemories: MemoryEntry[]): string {
    const sections: string[] = ["# Memory\n"];
    const byType = new Map<string, MemoryEntry[]>();
    for (const m of allMemories) {
      const list = byType.get(m.type) ?? [];
      list.push(m);
      byType.set(m.type, list);
    }
    for (const [type, entries] of byType) {
      sections.push(`## ${type}\n`);
      for (const e of entries) {
        sections.push(`- ${e.content}`);
      }
      sections.push("");
    }
    return sections.join("\n");
  }

  private buildUserProfileMd(allMemories: MemoryEntry[]): string {
    const sections: string[] = ["# User Profile\n"];
    const preferences = allMemories.filter(
      (m) => m.metadata.tags?.includes("user_preference")
    );
    if (preferences.length > 0) {
      sections.push("## Preferences\n");
      for (const p of preferences) {
        sections.push(`- ${p.content}`);
      }
      sections.push("");
    }
    const facts = allMemories.filter(
      (m) => m.metadata.tags?.includes("environment_fact")
    );
    if (facts.length > 0) {
      sections.push("## Environment\n");
      for (const f of facts) {
        sections.push(`- ${f.content}`);
      }
      sections.push("");
    }
    return sections.join("\n");
  }
}
