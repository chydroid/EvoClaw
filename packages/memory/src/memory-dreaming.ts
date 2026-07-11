/**
 * Memory Dreaming System for EvoClaw
 *
 * Inspired by OpenClaw 2026.4.5's Dreaming GA feature. During idle periods,
 * the agent replays conversation history to extract durable facts and
 * consolidate them into long-term memory — much like how human sleep
 * consolidates experiences into lasting memories.
 *
 * Three dream phases mirror human sleep stages:
 * - Light: quick scan of recent memories, extract obvious facts
 * - Deep: thorough analysis of all memories, extract patterns and preferences
 * - REM: consolidation — deduplicate, merge, and write to long-term memory
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dream phases, mirroring human sleep stages. */
export enum DreamPhase {
  /** Quick scan of recent memories (last 24 h). */
  Light = "light",
  /** Thorough analysis of all memories. */
  Deep = "deep",
  /** Consolidation — deduplicate, merge, write to long-term memory. */
  REM = "rem",
}

/** A single fact extracted during a dream session. */
export interface DreamFact {
  /** The extracted fact. */
  content: string;
  /** Which conversation / memory entry it came from. */
  source: string;
  /** Confidence score 0–1. */
  confidence: number;
  /** Semantic category of the fact. */
  category: "preference" | "fact" | "pattern" | "procedure";
  /** When the fact was extracted. */
  timestamp: number;
}

/** A single dream session. */
export interface DreamSession {
  id: string;
  startedAt: number;
  completedAt?: number;
  phase: DreamPhase;
  /** How many memory entries were processed. */
  sourceEntries: number;
  extractedFacts: DreamFact[];
  status: "running" | "completed" | "failed";
}

/** Cumulative diary of all dream sessions. */
export interface DreamDiary {
  sessions: DreamSession[];
  totalFactsExtracted: number;
  lastDreamAt?: number;
}

/** Configuration for the dreaming system. */
export interface DreamingConfig {
  enabled: boolean;
  /** Idle time (ms) before dreaming is considered. Default: 30 min. */
  idleThresholdMs: number;
  /** Maximum facts extracted per session. Default: 50. */
  maxFactsPerSession: number;
  /** Minimum confidence to keep an extracted fact. Default: 0.6. */
  minConfidence: number;
  /** Interval between light-phase dreams. Default: 1 h. */
  lightPhaseIntervalMs: number;
  /** Interval between deep-phase dreams. Default: 6 h. */
  deepPhaseIntervalMs: number;
  /** Interval between REM-phase dreams. Default: 24 h. */
  remPhaseIntervalMs: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DreamingConfig = {
  enabled: true,
  idleThresholdMs: 30 * 60 * 1000,
  maxFactsPerSession: 50,
  minConfidence: 0.6,
  lightPhaseIntervalMs: 60 * 60 * 1000,
  deepPhaseIntervalMs: 6 * 60 * 60 * 1000,
  remPhaseIntervalMs: 24 * 60 * 60 * 1000,
};

/** diary.sessions 最大保留条数，防止无界增长。 */
const MAX_SESSIONS = 100;

// ---------------------------------------------------------------------------
// Heuristic patterns
// ---------------------------------------------------------------------------

/** Preference indicator patterns (bilingual EN/ZH). */
const PREFERENCE_PATTERNS: ReadonlyArray<{ regex: RegExp; confidence: number }> = [
  { regex: /I (?:always|never|usually|typically)\s/gi, confidence: 0.85 },
  { regex: /I (?:like|love|enjoy|prefer|want|hate|dislike)\b/gi, confidence: 0.9 },
  { regex: /prefer\s+to\s/gi, confidence: 0.85 },
  { regex: /rather\s+than\s/gi, confidence: 0.75 },
  { regex: /instead\s+of\s/gi, confidence: 0.7 },
  { regex: /always use\s/gi, confidence: 0.8 },
  { regex: /never use\s/gi, confidence: 0.8 },
  { regex: /my (?:favorite|preferred|default)\b/gi, confidence: 0.85 },
  { regex: /我喜欢|我偏好|我习惯|我想要|我爱|我讨厌|我不喜欢/g, confidence: 0.9 },
  { regex: /总是|从不|通常|一般/g, confidence: 0.8 },
  { regex: /偏好|首选|默认/g, confidence: 0.85 },
];

/** Factual entity patterns. */
const FACT_PATTERNS: ReadonlyArray<{ regex: RegExp; confidence: number }> = [
  // Named entities — Capitalised words (2+ consecutive)
  { regex: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g, confidence: 0.6 },
  // Dates
  { regex: /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, confidence: 0.75 },
  { regex: /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s*\d{4}\b/gi, confidence: 0.75 },
  // Numbers with units
  { regex: /\b\d+(?:\.\d+)?\s*(?:px|em|rem|%|ms|s|MB|GB|TB|KB|km|m|cm|mm|kg|g|lb|ft|in)\b/gi, confidence: 0.7 },
  // Versions
  { regex: /\bv?\d+\.\d+(?:\.\d+)?\b/g, confidence: 0.65 },
  // Paths
  { regex: /(?:\/[\w.-]+){2,}/g, confidence: 0.6 },
  // Ports / IPs
  { regex: /\bport\s+\d+\b/gi, confidence: 0.7 },
  { regex: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, confidence: 0.65 },
  // Tech keywords
  { regex: /\b(?:TypeScript|JavaScript|Python|Rust|Go|Java|React|Vue|Angular|Node|Docker|Kubernetes)\b/g, confidence: 0.55 },
];

/** Repeated-action / pattern patterns. */
const PATTERN_PATTERNS: ReadonlyArray<{ regex: RegExp; confidence: number }> = [
  { regex: /(?:every|each)\s+(?:time|day|week|month)\b/gi, confidence: 0.75 },
  { regex: /(?:when|whenever)\s+.+?,\s*(?:I|we|they)\b/gi, confidence: 0.7 },
  { regex: /(?:tends?|usually|often|frequently)\s+(?:to\s+)?/gi, confidence: 0.65 },
  { regex: /每次|经常|通常|往往|总是/g, confidence: 0.7 },
  { regex: /当.*时(?:,|，)/g, confidence: 0.65 },
];

/** Procedure / step-by-step patterns. */
const PROCEDURE_PATTERNS: ReadonlyArray<{ regex: RegExp; confidence: number }> = [
  { regex: /first\s*[,.]?\s*then\s*[,.]?\s*(?:finally|lastly)?/gi, confidence: 0.85 },
  { regex: /step\s+\d/gi, confidence: 0.9 },
  { regex: /(?:firstly|secondly|thirdly|finally)\b/gi, confidence: 0.8 },
  { regex: /第[一二三四五六七八九十\d]+步/g, confidence: 0.9 },
  { regex: /首先.*然后.*(?:最后|最终)?/g, confidence: 0.85 },
  { regex: /(?:1\.|2\.|3\.)\s+\w/gi, confidence: 0.7 },
  { regex: /(?:^|\n)\s*[-*]\s+/gm, confidence: 0.5 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a simple unique id (no external deps). */
function generateId(): string {
  // 使用 crypto.randomUUID 替代 Math.random，避免可预测的 ID
  const time = Date.now().toString(36);
  return `dream-${time}-${randomUUID()}`;
}

/**
 * Tokenise text into a set of lowercase word tokens for Jaccard comparison.
 * Handles both CJK characters (each as a token) and Latin words.
 */
function tokenise(text: string): Set<string> {
  const tokens = new Set<string>();
  // Latin words
  const latinWords = text.toLowerCase().match(/[a-z0-9]{2,}/g);
  if (latinWords) {
    for (const w of latinWords) tokens.add(w);
  }
  // CJK characters (each char is a token)
  const cjkChars = text.match(/[\u4e00-\u9fff]/g);
  if (cjkChars) {
    for (const c of cjkChars) tokens.add(c);
  }
  return tokens;
}

/** Compute Jaccard similarity between two sets. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Extract the sentence(s) surrounding a regex match within the source text. */
function extractSurroundingSentence(text: string, matchIndex: number, matchLength: number): string {
  // Expand to nearest sentence boundaries (. ! ? 。！？) or line boundaries
  let start = matchIndex;
  let end = matchIndex + matchLength;

  // Walk backwards to find sentence start
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === "." || ch === "!" || ch === "?" || ch === "。" || ch === "！" || ch === "？" || ch === "\n") {
      break;
    }
    start--;
  }

  // Walk forwards to find sentence end
  while (end < text.length) {
    const ch = text[end];
    if (ch === "." || ch === "!" || ch === "?" || ch === "。" || ch === "！" || ch === "？" || ch === "\n") {
      end++;
      break;
    }
    end++;
  }

  return text.slice(start, end).trim();
}

// ---------------------------------------------------------------------------
// MemoryDreaming
// ---------------------------------------------------------------------------

/**
 * Minimal interface that the memory hub must satisfy. We keep it loose
 * (`any`) in the constructor per the spec but define a structural type
 * here so we can code against it safely internally.
 */
interface MemoryHubLike {
  getLongTerm(): {
    search(query: { query: string; limit?: number }): Promise<Array<{ entry: { id: string; content: string; createdAt: Date; type: string; metadata: { importance: number; tags: string[] } } }>>;
    getAll(): Promise<Array<{ id: string; content: string; createdAt: Date; type: string; metadata: { importance: number; tags: string[] } }>>;
  };
  remember(entry: {
    type: string;
    content: string;
    embedding: null;
    metadata: { source: string; sessionId: string; userId: string; tags: string[]; importance: number; associations: string[]; entities: string[] };
    ttl: number;
  }): Promise<unknown>;
}

export class MemoryDreaming {
  private config: DreamingConfig;
  private diary: DreamDiary;
  private memoryHub: MemoryHubLike;

  /** Track when the system was last active (for idle detection). */
  private lastActivityAt: number;

  /** Track how many new memories have been stored since the last dream. */
  private newMemoriesSinceLastDream: number;

  /** pendingFacts 上限，防止在 REM 清空前无限增长导致 OOM。 */
  private static readonly MAX_PENDING_FACTS = 10_000;

  /** Pending (un-consolidated) facts accumulated across light/deep phases. */
  private pendingFacts: DreamFact[] = [];

  constructor(memoryHub: any) {
    this.memoryHub = memoryHub as MemoryHubLike;
    this.config = { ...DEFAULT_CONFIG };
    this.diary = { sessions: [], totalFactsExtracted: 0 };
    this.lastActivityAt = Date.now();
    this.newMemoriesSinceLastDream = 0;
  }

  /** 截断 pendingFacts 到上限，丢弃最旧条目，防止 OOM。 */
  private capPendingFacts(): void {
    if (this.pendingFacts.length > MemoryDreaming.MAX_PENDING_FACTS) {
      this.pendingFacts = this.pendingFacts.slice(-MemoryDreaming.MAX_PENDING_FACTS);
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute a dreaming session in the given phase.
   *
   * - **Light**: scan recent memories (last 24 h), extract obvious facts.
   * - **Deep**: scan all memories, extract patterns and preferences.
   * - **REM**: consolidate extracted facts, deduplicate, merge, write to
   *   long-term memory.
   */
  async dream(phase: DreamPhase = DreamPhase.Light): Promise<DreamSession> {
    if (!this.config.enabled) {
      return this.makeSkippedSession(phase);
    }

    const session: DreamSession = {
      id: generateId(),
      startedAt: Date.now(),
      phase,
      sourceEntries: 0,
      extractedFacts: [],
      status: "running",
    };

    try {
      switch (phase) {
        case DreamPhase.Light:
          await this.dreamLight(session);
          break;
        case DreamPhase.Deep:
          await this.dreamDeep(session);
          break;
        case DreamPhase.REM:
          await this.dreamREM(session);
          break;
      }

      session.status = "completed";
    } catch (err) {
      session.status = "failed";
      process.stderr.write(`[MemoryDreaming] Dream session ${session.id} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    session.completedAt = Date.now();
    this.diary.sessions.push(session);
    // 限制 sessions 数组大小，超出则丢弃最旧的条目
    if (this.diary.sessions.length > MAX_SESSIONS) {
      this.diary.sessions.shift();
    }
    if (session.status === "completed") {
      this.diary.totalFactsExtracted += session.extractedFacts.length;
      this.newMemoriesSinceLastDream = 0;
    }
    this.diary.lastDreamAt = Date.now();

    return session;
  }

  /** Get the dream diary. */
  getDiary(): DreamDiary {
    // 拷贝 sessions 数组避免外部修改影响内部状态
    return { ...this.diary, sessions: [...this.diary.sessions] };
  }

  /**
   * Check whether dreaming should occur now.
   * Returns true when:
   * - The system has been idle for longer than `idleThresholdMs`, OR
   * - More than 100 new memories have been stored since the last dream.
   */
  shouldDream(): boolean {
    if (!this.config.enabled) return false;

    const idleMs = Date.now() - this.lastActivityAt;
    if (idleMs > this.config.idleThresholdMs) return true;
    if (this.newMemoriesSinceLastDream > 100) return true;

    // Check phase-specific intervals
    const lastDream = this.diary.lastDreamAt;
    if (lastDream !== undefined) {
      const elapsed = Date.now() - lastDream;
      // If enough time has passed for a light-phase dream
      if (elapsed > this.config.lightPhaseIntervalMs) return true;
    } else {
      // Never dreamed before — should start
      return true;
    }

    return false;
  }

  /**
   * Determine which dream phase is due based on elapsed time since the
   * last session of each phase.
   */
  getDuePhase(): DreamPhase {
    const now = Date.now();

    const lastREM = this.lastSessionOfPhase(DreamPhase.REM);
    const lastDeep = this.lastSessionOfPhase(DreamPhase.Deep);
    const lastLight = this.lastSessionOfPhase(DreamPhase.Light);

    const remElapsed = lastREM ? now - lastREM.completedAt! : Infinity;
    const deepElapsed = lastDeep ? now - lastDeep.completedAt! : Infinity;
    const lightElapsed = lastLight ? now - lastLight.completedAt! : Infinity;

    if (remElapsed >= this.config.remPhaseIntervalMs) return DreamPhase.REM;
    if (deepElapsed >= this.config.deepPhaseIntervalMs) return DreamPhase.Deep;
    if (lightElapsed >= this.config.lightPhaseIntervalMs) return DreamPhase.Light;

    return DreamPhase.Light;
  }

  /**
   * Heuristic fact extraction from a text string. No LLM needed — uses
   * regex patterns and keyword matching.
   */
  extractFactsFromText(text: string): DreamFact[] {
    const facts: DreamFact[] = [];
    const now = Date.now();

    // --- Preferences ---
    for (const { regex, confidence } of PREFERENCE_PATTERNS) {
      // Reset lastIndex for patterns with global flag
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const sentence = extractSurroundingSentence(text, match.index, match[0].length);
        if (sentence.length > 0) {
          facts.push({
            content: sentence,
            source: "heuristic:preference",
            confidence,
            category: "preference",
            timestamp: now,
          });
        }
        // Safety: avoid infinite loops on zero-length matches
        if (match[0].length === 0) regex.lastIndex++;
      }
    }

    // --- Facts ---
    for (const { regex, confidence } of FACT_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const sentence = extractSurroundingSentence(text, match.index, match[0].length);
        if (sentence.length > 0) {
          facts.push({
            content: sentence,
            source: "heuristic:fact",
            confidence,
            category: "fact",
            timestamp: now,
          });
        }
        if (match[0].length === 0) regex.lastIndex++;
      }
    }

    // --- Patterns ---
    for (const { regex, confidence } of PATTERN_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const sentence = extractSurroundingSentence(text, match.index, match[0].length);
        if (sentence.length > 0) {
          facts.push({
            content: sentence,
            source: "heuristic:pattern",
            confidence,
            category: "pattern",
            timestamp: now,
          });
        }
        if (match[0].length === 0) regex.lastIndex++;
      }
    }

    // --- Procedures ---
    for (const { regex, confidence } of PROCEDURE_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const sentence = extractSurroundingSentence(text, match.index, match[0].length);
        if (sentence.length > 0) {
          facts.push({
            content: sentence,
            source: "heuristic:procedure",
            confidence,
            category: "procedure",
            timestamp: now,
          });
        }
        if (match[0].length === 0) regex.lastIndex++;
      }
    }

    return facts;
  }

  /**
   * Consolidate extracted facts: deduplicate and merge related facts.
   *
   * - Remove near-duplicates (Jaccard similarity > 0.8).
   * - Merge facts about the same entity (same category + overlapping tokens).
   */
  consolidateFacts(facts: DreamFact[]): DreamFact[] {
    if (facts.length === 0) return [];

    // Filter by minimum confidence
    const qualified = facts.filter((f) => f.confidence >= this.config.minConfidence);

    // Sort by confidence descending so we keep the highest-confidence version
    qualified.sort((a, b) => b.confidence - a.confidence);

    const kept: DreamFact[] = [];
    const keptTokens: Set<string>[] = [];

    for (const fact of qualified) {
      const factTokens = tokenise(fact.content);

      let isDuplicate = false;
      let mergeTarget: { index: number; fact: DreamFact } | null = null;

      for (let i = 0; i < kept.length; i++) {
        const similarity = jaccardSimilarity(factTokens, keptTokens[i]);

        if (similarity > 0.8) {
          // Near-duplicate — skip this fact
          isDuplicate = true;
          break;
        }

        // Check for same-category merge opportunity (similarity > 0.4 but ≤ 0.8)
        if (
          similarity > 0.4 &&
          fact.category === kept[i].category &&
          mergeTarget === null
        ) {
          mergeTarget = { index: i, fact: kept[i] };
        }
      }

      if (isDuplicate) continue;

      if (mergeTarget) {
        // Merge: combine content, take the higher confidence, keep the later timestamp
        const existing = mergeTarget.fact;
        const merged: DreamFact = {
          content: mergeFactualContent(existing.content, fact.content),
          source: `${existing.source}+${fact.source}`,
          confidence: Math.max(existing.confidence, fact.confidence),
          category: existing.category,
          timestamp: Math.max(existing.timestamp, fact.timestamp),
        };
        kept[mergeTarget.index] = merged;
        // Re-tokenise the merged content
        keptTokens[mergeTarget.index] = tokenise(merged.content);
      } else {
        kept.push(fact);
        keptTokens.push(factTokens);
      }
    }

    // Enforce max facts per session
    return kept.slice(0, this.config.maxFactsPerSession);
  }

  /**
   * Write consolidated facts to long-term memory via the memory hub.
   * Returns the number of facts successfully written.
   */
  async writeFactsToMemory(facts: DreamFact[]): Promise<number> {
    let written = 0;

    for (const fact of facts) {
      try {
        await this.memoryHub.remember({
          type: mapCategoryToType(fact.category),
          content: `[dream:${fact.category}] ${fact.content}`,
          embedding: null,
          metadata: {
            source: `memory-dreaming:${fact.source}`,
            sessionId: "",
            userId: "",
            tags: ["dream-extracted", fact.category],
            importance: fact.confidence,
            associations: [],
            entities: extractEntities(fact.content),
          },
          ttl: 0,
        });
        written++;
      } catch (err) {
        process.stderr.write(`[MemoryDreaming] Failed to write fact to memory: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    return written;
  }

  /** Update the activity timestamp (called by the host system). */
  notifyActivity(): void {
    this.lastActivityAt = Date.now();
    this.newMemoriesSinceLastDream++;
  }

  /** Update configuration. Merges with current config. */
  configure(update: Partial<DreamingConfig>): void {
    this.config = { ...this.config, ...update };
  }

  /** Get current configuration. */
  getConfig(): DreamingConfig {
    return { ...this.config };
  }

  /** Get the count of new memories since the last dream. */
  getNewMemoriesSinceLastDream(): number {
    return this.newMemoriesSinceLastDream;
  }

  // -----------------------------------------------------------------------
  // Phase implementations
  // -----------------------------------------------------------------------

  /** Light phase: scan recent memories (last 24 h), extract obvious facts. */
  private async dreamLight(session: DreamSession): Promise<void> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    const results = await this.memoryHub.getLongTerm().search({
      query: "",
      limit: 500,
    });

    const recent = results.filter((r) => {
      const created = r.entry.createdAt;
      const ts = created instanceof Date ? created.getTime() : new Date(created).getTime();
      return ts >= cutoff;
    });

    session.sourceEntries = recent.length;

    for (const r of recent) {
      const facts = this.extractFactsFromText(r.entry.content);
      // Tag each fact with its source memory id
      for (const f of facts) {
        f.source = r.entry.id;
      }
      session.extractedFacts.push(...facts);
    }

    // Enforce max facts per session
    session.extractedFacts = session.extractedFacts.slice(0, this.config.maxFactsPerSession);

    // Accumulate into pending for later REM consolidation
    this.pendingFacts.push(...session.extractedFacts);
    this.capPendingFacts();
  }

  /** Deep phase: scan all memories, extract patterns and preferences. */
  private async dreamDeep(session: DreamSession): Promise<void> {
    // 限制加载量，避免长期记忆膨胀时 OOM（与 dreamREM 一致使用 search）
    const results = await this.memoryHub.getLongTerm().search({ query: "", limit: 500 });
    const allEntries = results.map((r) => r.entry);

    session.sourceEntries = allEntries.length;

    for (const entry of allEntries) {
      const facts = this.extractFactsFromText(entry.content);
      for (const f of facts) {
        f.source = entry.id;
      }
      session.extractedFacts.push(...facts);
    }

    // Deep phase also detects cross-entry patterns
    this.detectCrossEntryPatterns(allEntries, session);

    // Enforce max facts per session
    session.extractedFacts = session.extractedFacts.slice(0, this.config.maxFactsPerSession);

    // Accumulate into pending for later REM consolidation
    this.pendingFacts.push(...session.extractedFacts);
    this.capPendingFacts();
  }

  /** REM phase: consolidate extracted facts, deduplicate, merge, write. */
  private async dreamREM(session: DreamSession): Promise<void> {
    // Include all pending facts from prior light/deep sessions
    const allFacts = [...this.pendingFacts];

    // Also re-extract from recent memories to catch anything new
    const results = await this.memoryHub.getLongTerm().search({
      query: "",
      limit: 1000,
    });

    session.sourceEntries = results.length;

    for (const r of results) {
      const facts = this.extractFactsFromText(r.entry.content);
      for (const f of facts) {
        f.source = r.entry.id;
      }
      allFacts.push(...facts);
    }

    // Consolidate: deduplicate and merge
    const consolidated = this.consolidateFacts(allFacts);
    session.extractedFacts = consolidated;

    // Write to long-term memory
    const written = await this.writeFactsToMemory(consolidated);

    // Clear pending facts after successful consolidation
    this.pendingFacts = [];

    process.stdout.write(
      `[MemoryDreaming] REM session ${session.id}: consolidated ${allFacts.length} facts → ${consolidated.length} → wrote ${written}\n`
    );
  }

  // -----------------------------------------------------------------------
  // Cross-entry pattern detection
  // -----------------------------------------------------------------------

  /**
   * Detect patterns that span multiple memory entries — e.g. repeated
   * actions, common sequences, or frequently co-occurring entities.
   */
  private detectCrossEntryPatterns(
    entries: Array<{ id: string; content: string; type: string; metadata: { importance: number; tags: string[] } }>,
    session: DreamSession,
  ): void {
    const now = Date.now();

    // 1. Detect frequently co-occurring tags
    const tagCoOccurrence = new Map<string, number>();
    const tagList = entries
      .map((e) => e.metadata.tags)
      .filter((tags) => tags.length >= 2);

    for (const tags of tagList) {
      for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
          const key = [tags[i], tags[j]].sort().join("|");
          tagCoOccurrence.set(key, (tagCoOccurrence.get(key) ?? 0) + 1);
        }
      }
    }

    for (const [pair, count] of tagCoOccurrence) {
      if (count >= 3) {
        const [tagA, tagB] = pair.split("|");
        session.extractedFacts.push({
          content: `Tags "${tagA}" and "${tagB}" frequently co-occur (${count} times)`,
          source: "heuristic:cross-entry:tag-cooccurrence",
          confidence: Math.min(0.5 + count * 0.05, 0.9),
          category: "pattern",
          timestamp: now,
        });
      }
    }

    // 2. Detect repeated content similarity (simplified: shared long keywords)
    const keywordCounts = new Map<string, number>();
    for (const entry of entries) {
      const words = entry.content.toLowerCase().match(/[a-z]{4,}/g) ?? [];
      const unique = new Set(words);
      for (const w of unique) {
        keywordCounts.set(w, (keywordCounts.get(w) ?? 0) + 1);
      }
    }

    const frequentKeywords = [...keywordCounts.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (frequentKeywords.length > 0) {
      const terms = frequentKeywords.map(([w, c]) => `"${w}" (${c}x)`).join(", ");
      session.extractedFacts.push({
        content: `Frequently discussed topics: ${terms}`,
        source: "heuristic:cross-entry:keyword-frequency",
        confidence: 0.6,
        category: "pattern",
        timestamp: now,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Find the most recent completed session of a given phase. */
  private lastSessionOfPhase(phase: DreamPhase): DreamSession | undefined {
    for (let i = this.diary.sessions.length - 1; i >= 0; i--) {
      const s = this.diary.sessions[i];
      if (s.phase === phase && s.status === "completed") return s;
    }
    return undefined;
  }

  /** Create a placeholder session for when dreaming is disabled. */
  private makeSkippedSession(phase: DreamPhase): DreamSession {
    return {
      id: generateId(),
      startedAt: Date.now(),
      completedAt: Date.now(),
      phase,
      sourceEntries: 0,
      extractedFacts: [],
      status: "completed",
    };
  }
}

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

/**
 * Merge two factual content strings about the same entity.
 * Keeps the longer content as the base and appends unique parts from the
 * shorter one.
 */
function mergeFactualContent(a: string, b: string): string {
  if (a === b) return a;
  // If one contains the other, keep the longer one
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  // Otherwise concatenate with a separator
  return `${a}; ${b}`;
}

/** Map DreamFact category to MemoryEntry type. */
function mapCategoryToType(
  category: DreamFact["category"]
): "conversation" | "experience" | "knowledge" | "feedback" | "system" {
  switch (category) {
    case "preference":
      return "feedback";
    case "fact":
      return "knowledge";
    case "pattern":
      return "experience";
    case "procedure":
      return "experience";
  }
}

/**
 * Extract potential named entities from text (capitalised words, quoted
 * strings, CJK proper nouns). Used as the `entities` field when writing
 * facts to long-term memory.
 */
function extractEntities(text: string): string[] {
  const entities = new Set<string>();

  // Capitalised multi-word sequences
  const capMatches = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g);
  if (capMatches) {
    for (const m of capMatches) entities.add(m);
  }

  // Quoted strings
  const quotedMatches = text.match(/["'「」『』]([^"'「」『』]{2,})["'「」『』]/g);
  if (quotedMatches) {
    for (const m of quotedMatches) {
      entities.add(m.replace(/^["'「」『』]|["'「」『』]$/g, ""));
    }
  }

  // Single all-caps words (acronyms)
  const acronymMatches = text.match(/\b[A-Z]{2,6}\b/g);
  if (acronymMatches) {
    for (const m of acronymMatches) entities.add(m);
  }

  return [...entities].slice(0, 10);
}
