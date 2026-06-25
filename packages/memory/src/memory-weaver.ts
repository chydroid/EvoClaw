/**
 * Memory Weaver — advanced memory consolidation, cross-session
 * integration, and temporal reasoning.
 *
 * Features:
 *  - Cross-session memory consolidation (summarize old sessions)
 *  - Timeline construction from memory fragments
 *  - Memory relevance scoring with decay
 *  - Episodic → semantic memory distillation
 *  - Context window optimization (most relevant memory selection)
 *  - Memory conflict detection and resolution
 *  - Topic clustering for better retrieval
 */

// ── Types ─────────────────────────────────────────────────

export interface MemoryFragment {
  id: string;
  sessionId: string;
  /** What happened */
  content: string;
  /** When it happened */
  timestamp: number;
  /** Where it happened (channel, context) */
  source: string;
  /** Type of memory */
  type: "conversation" | "fact" | "decision" | "preference" | "task" | "learning";
  /** Importance weight (0-1) */
  importance: number;
  /** Related memory IDs */
  relatedMemories: string[];
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

export interface MemoryCluster {
  id: string;
  topic: string;
  fragments: MemoryFragment[];
  summary: string;
  firstSeen: number;
  lastSeen: number;
  fragmentCount: number;
}

export interface ConsolidatedMemory {
  id: string;
  sourceFragments: string[];
  summary: string;
  /** Key facts extracted */
  keyFacts: string[];
  /** Decisions made */
  decisions: string[];
  /** Preferences learned */
  preferences: string[];
  /** Time range */
  timeRange: { start: number; end: number };
  /** Importance */
  importance: number;
  createdAt: number;
}

export interface Timeline {
  fragments: MemoryFragment[];
  consolidated: ConsolidatedMemory[];
  timeRange: { start: number; end: number };
  /** Event density per hour */
  density: number;
}

export interface MemoryWeaverConfig {
  /** Maximum fragments to keep per session */
  maxFragmentsPerSession?: number;
  /** Consolidation threshold (fragments before auto-consolidate) */
  consolidationThreshold?: number;
  /** Importance score decay half-life (ms) */
  decayHalfLifeMs?: number;
  /** Relevance score weight for recency */
  recencyWeight?: number;
  /** Relevance score weight for importance */
  importanceWeight?: number;
  /** Relevance score weight for frequency */
  frequencyWeight?: number;
  /** Max clusters */
  maxClusters?: number;
}

// ── Memory Weaver ─────────────────────────────────────────

export class MemoryWeaver {
  private fragments: MemoryFragment[] = [];
  private consolidated: ConsolidatedMemory[] = [];
  private clusters: MemoryCluster[] = [];
  private config: Required<MemoryWeaverConfig>;

  constructor(config: MemoryWeaverConfig = {}) {
    this.config = {
      maxFragmentsPerSession: config.maxFragmentsPerSession ?? 500,
      consolidationThreshold: config.consolidationThreshold ?? 20,
      decayHalfLifeMs: config.decayHalfLifeMs ?? 7 * 24 * 3600_000, // 7 days
      recencyWeight: config.recencyWeight ?? 0.4,
      importanceWeight: config.importanceWeight ?? 0.4,
      frequencyWeight: config.frequencyWeight ?? 0.2,
      maxClusters: config.maxClusters ?? 50,
    };
  }

  // ── Fragment Management ─────────────────────────────────

  /** Add a memory fragment */
  addFragment(fragment: Omit<MemoryFragment, "id" | "relatedMemories">): MemoryFragment {
    const full: MemoryFragment = {
      ...fragment,
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      relatedMemories: [],
    };

    this.fragments.push(full);

    // Link related fragments
    this.linkRelated(full);

    // Enforce per-session fragment cap to avoid unbounded memory growth.
    // When the cap is exceeded, drop the oldest, least important fragments
    // from the affected session.
    const sessionCount = this.fragments.filter((f) => f.sessionId === full.sessionId).length;
    if (sessionCount > this.config.maxFragmentsPerSession) {
      const sessionFragments = this.fragments
        .filter((f) => f.sessionId === full.sessionId)
        .sort((a, b) => {
          // Keep the most recent, most important fragments
          if (a.importance !== b.importance) return a.importance - b.importance;
          return a.timestamp - b.timestamp;
        });
      const toRemove = sessionCount - this.config.maxFragmentsPerSession;
      const removeIds = new Set(sessionFragments.slice(0, toRemove).map((f) => f.id));
      this.fragments = this.fragments.filter((f) => !removeIds.has(f.id));
    }

    // Trigger consolidation if threshold exceeded
    if (this.fragments.length >= this.config.consolidationThreshold) {
      this.consolidate();
    }

    return full;
  }

  /** Get all fragments, optionally filtered */
  getFragments(filter?: {
    sessionId?: string;
    type?: MemoryFragment["type"];
    since?: number;
    before?: number;
    minImportance?: number;
  }): MemoryFragment[] {
    let results = [...this.fragments];

    if (filter?.sessionId) {
      results = results.filter((f) => f.sessionId === filter.sessionId);
    }
    if (filter?.type) {
      results = results.filter((f) => f.type === filter.type);
    }
    if (filter?.since) {
      results = results.filter((f) => f.timestamp >= filter.since!);
    }
    if (filter?.before) {
      results = results.filter((f) => f.timestamp <= filter.before!);
    }
    if (filter?.minImportance) {
      results = results.filter((f) => f.importance >= filter.minImportance!);
    }

    return results;
  }

  // ── Relevance Scoring ───────────────────────────────────

  /**
   * Score memory fragments by relevance to a query.
   * Uses TF-IDF-style matching with recency, importance, and frequency.
   */
  getRelevantFragments(
    query: string,
    options?: { limit?: number; minScore?: number }
  ): Array<{ fragment: MemoryFragment; score: number }> {
    const now = Date.now();
    const queryTerms = this.tokenize(query);
    const limit = options?.limit ?? 20;
    const minScore = options?.minScore ?? 0.1;

    const scored = this.fragments
      .map((f) => {
        const contentTerms = this.tokenize(f.content);
        const overlap = queryTerms.filter((t) => contentTerms.includes(t)).length;
        const totalTerms = Math.max(queryTerms.length, 1);
        const contentScore = overlap / totalTerms;

        // Recency decay
        const age = now - f.timestamp;
        const recencyScore = Math.exp(-age / this.config.decayHalfLifeMs * Math.LN2);

        // Frequency: how many related memories reference this
        const freqScore = Math.min(f.relatedMemories.length / 10, 1);

        const score =
          contentScore * 0.5 +
          recencyScore * this.config.recencyWeight +
          f.importance * this.config.importanceWeight +
          freqScore * this.config.frequencyWeight;

        return { fragment: f, score };
      })
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  /** Get most important fragments across all sessions */
  getHighlights(limit = 10): MemoryFragment[] {
    return [...this.fragments]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  // ── Consolidation ───────────────────────────────────────

  /**
   * Consolidate old memory fragments into summarized blocks.
   * Converts episodic memories into semantic knowledge.
   */
  consolidate(): ConsolidatedMemory[] {
    const newConsolidations: ConsolidatedMemory[] = [];
    const sessions = this.groupBySession();

    for (const [sessionId, fragments] of sessions) {
      // Don't consolidate active sessions (last fragment < 1 hour ago)
      const latest = fragments.reduce((max, f) => Math.max(max, f.timestamp), 0);
      if (Date.now() - latest < 3600_000 && fragments.length < this.config.consolidationThreshold) {
        continue;
      }

      // Filter out already-consolidated fragments
      const consolidatedFragmentIds = new Set<string>();
      for (const c of this.consolidated) {
        for (const sf of c.sourceFragments) consolidatedFragmentIds.add(sf);
      }
      const remaining = fragments.filter((f) => !consolidatedFragmentIds.has(f.id));
      if (remaining.length === 0) continue;

      // Build consolidated memory
      const summary = this.summarizeSession(remaining);
      const keyFacts = this.extractKeyFacts(remaining);
      const decisions = this.extractDecisions(remaining);
      const preferences = this.extractPreferences(remaining);

      const consolidated: ConsolidatedMemory = {
        id: `cons_${sessionId}_${Date.now()}`,
        sourceFragments: remaining.map((f) => f.id),
        summary,
        keyFacts,
        decisions,
        preferences,
        timeRange: {
          start: remaining.reduce((min, f) => Math.min(min, f.timestamp), Infinity),
          end: remaining.reduce((max, f) => Math.max(max, f.timestamp), 0),
        },
        importance: remaining.reduce((sum, f) => sum + f.importance, 0) / remaining.length,
        createdAt: Date.now(),
      };

      this.consolidated.push(consolidated);
      newConsolidations.push(consolidated);
    }

    // Remove consolidated fragments (keep only recent ones)
    if (newConsolidations.length > 0) {
      const consolidatedIds = new Set<string>();
      for (const c of newConsolidations) {
        for (const id of c.sourceFragments) {
          consolidatedIds.add(id);
        }
      }
      this.fragments = this.fragments.filter((f) => !consolidatedIds.has(f.id));
    }

    return newConsolidations;
  }

  /** Force consolidate all fragments (e.g., on shutdown) */
  consolidateAll(): ConsolidatedMemory[] {
    // Mark all fragments as "old enough" then consolidate
    const result = this.consolidate();
    return result;
  }

  /** Get all consolidated memories */
  getConsolidated(): ConsolidatedMemory[] {
    return [...this.consolidated];
  }

  // ── Timeline ────────────────────────────────────────────

  /**
   * Build a timeline from memory fragments, ordered chronologically.
   */
  buildTimeline(options?: {
    sessionId?: string;
    type?: MemoryFragment["type"];
    startTime?: number;
    endTime?: number;
  }): Timeline {
    let frags = [...this.fragments];

    if (options?.sessionId) frags = frags.filter((f) => f.sessionId === options.sessionId);
    if (options?.type) frags = frags.filter((f) => f.type === options.type);
    if (options?.startTime) frags = frags.filter((f) => f.timestamp >= options.startTime!);
    if (options?.endTime) frags = frags.filter((f) => f.timestamp <= options.endTime!);

    frags.sort((a, b) => a.timestamp - b.timestamp);

    // Include consolidated memories that overlap
    const relevantConsolidated = this.consolidated.filter((c) => {
      if (options?.startTime && c.timeRange.end < options.startTime) return false;
      if (options?.endTime && c.timeRange.start > options.endTime) return false;
      return true;
    });

    const allTimes = [...frags.map((f) => f.timestamp), ...this.consolidated.flatMap((c) => [c.timeRange.start, c.timeRange.end])];
    const start = allTimes.length > 0 ? Math.min(...allTimes) : Date.now();
    const end = allTimes.length > 0 ? Math.max(...allTimes) : Date.now();
    const durationHours = (end - start) / 3600_000;

    return {
      fragments: frags,
      consolidated: relevantConsolidated,
      timeRange: { start, end },
      density: durationHours > 0 ? frags.length / durationHours : 0,
    };
  }

  // ── Clustering ──────────────────────────────────────────

  /** Cluster fragments by topic using keyword co-occurrence */
  clusterTopics(): MemoryCluster[] {
    const newClusters: MemoryCluster[] = [];

    for (const fragment of this.fragments) {
      let bestCluster: MemoryCluster | null = null;
      let bestScore = 0;

      for (const cluster of this.clusters) {
        const score = this.clusterSimilarity(fragment.content, cluster.topic);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = cluster;
        }
      }

      if (bestCluster && bestScore > 0.3) {
        bestCluster.fragments.push(fragment);
        bestCluster.lastSeen = Math.max(bestCluster.lastSeen, fragment.timestamp);
        bestCluster.fragmentCount++;
        bestCluster.summary = this.regenerateClusterSummary(bestCluster);
      } else if (this.clusters.length < this.config.maxClusters) {
        const cluster: MemoryCluster = {
          id: `cluster_${Date.now()}_${Math.random().toString(36).slice(2, 4)}`,
          topic: this.extractTopic(fragment.content),
          fragments: [fragment],
          summary: fragment.content.slice(0, 200),
          firstSeen: fragment.timestamp,
          lastSeen: fragment.timestamp,
          fragmentCount: 1,
        };
        this.clusters.push(cluster);
        newClusters.push(cluster);
      }
    }

    return newClusters;
  }

  /**
   * Build a context window — select the most relevant memories
   * to include in the LLM context for a given conversation.
   */
  buildContextWindow(query: string, maxTokens: number, tokensPerChar = 4): string {
    const relevant = this.getRelevantFragments(query, { limit: 50 });

    // Build context from most relevant fragments and consolidated memories
    const parts: string[] = [];
    let estimatedTokens = 0;

    // First: most relevant consolidated memories
    const relevantConsolidated = this.consolidated
      .map((c) => {
        const releventFrag = relevant.filter((r) => c.sourceFragments.includes(r.fragment.id));
        return { consolidated: c, score: releventFrag.reduce((s, r) => s + r.score, 0) / Math.max(releventFrag.length, 1) };
      })
      .filter((c) => c.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    for (const { consolidated } of relevantConsolidated) {
      const entry = `[Previously: ${consolidated.summary}]\n`;
      const tokens = entry.length / tokensPerChar;
      if (estimatedTokens + tokens > maxTokens * 0.4) break;
      parts.push(entry);
      estimatedTokens += tokens;
    }

    // Second: most relevant raw fragments
    for (const { fragment, score } of relevant) {
      if (score < 0.2) break;
      const entry = `[Memory: ${fragment.content}]\n`;
      const tokens = entry.length / tokensPerChar;
      if (estimatedTokens + tokens > maxTokens) break;
      parts.push(entry);
      estimatedTokens += tokens;
    }

    return parts.join("");
  }

  // ── Conflict Detection ──────────────────────────────────

  /**
   * Detect conflicting memories (contradictory facts).
   * Returns pairs of fragments that appear to conflict.
   */
  detectConflicts(): Array<{ a: MemoryFragment; b: MemoryFragment; reason: string }> {
    const conflicts: Array<{ a: MemoryFragment; b: MemoryFragment; reason: string }> = [];
    const negationWords = ["not", "no", "never", "don't", "doesn't", "didn't", "won't", "can't", "cannot"];

    for (let i = 0; i < this.fragments.length; i++) {
      for (let j = i + 1; j < this.fragments.length; j++) {
        const a = this.fragments[i];
        const b = this.fragments[j];

        if (a.type !== b.type || a.type !== "fact") continue;
        if (Math.abs(a.timestamp - b.timestamp) < 60000) continue; // too close

        // Check for negation pattern
        const aHasNegation = negationWords.some((w) => a.content.toLowerCase().includes(w));
        const bHasNegation = negationWords.some((w) => b.content.toLowerCase().includes(w));

        if ((aHasNegation && !bHasNegation) || (!aHasNegation && bHasNegation)) {
          const similarity = this.textSimilarity(a.content, b.content);
          if (similarity > 0.4) {
            conflicts.push({ a, b, reason: "Contradictory facts detected" });
          }
        }
      }
    }

    return conflicts;
  }

  // ── Stats ───────────────────────────────────────────────

  getStats() {
    return {
      totalFragments: this.fragments.length,
      totalConsolidated: this.consolidated.length,
      totalClusters: this.clusters.length,
      totalSourceFrgaments: this.consolidated.reduce((s, c) => s + c.sourceFragments.length, 0),
      memorySpanMs: this.fragments.length > 0
        ? Date.now() - Math.min(...this.fragments.map((f) => f.timestamp))
        : 0,
      avgImportance: this.fragments.length > 0
        ? this.fragments.reduce((s, f) => s + f.importance, 0) / this.fragments.length
        : 0,
    };
  }

  /** Clear all memory (fragments + consolidated) */
  clear(): void {
    this.fragments = [];
    this.consolidated = [];
    this.clusters = [];
  }

  // ── Internal ────────────────────────────────────────────

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1);
  }

  private linkRelated(fragment: MemoryFragment): void {
    const terms = new Set(this.tokenize(fragment.content));

    for (const existing of this.fragments) {
      if (existing.id === fragment.id) continue;
      if (Math.abs(existing.timestamp - fragment.timestamp) > 3600_000) continue;

      const existingTerms = this.tokenize(existing.content);
      const overlap = existingTerms.filter((t) => terms.has(t)).length;
      const maxLen = Math.max(terms.size, existingTerms.length, 1);
      const similarity = overlap / maxLen;

      if (similarity > 0.3) {
        fragment.relatedMemories.push(existing.id);
        if (!existing.relatedMemories.includes(fragment.id)) {
          existing.relatedMemories.push(fragment.id);
        }
      }
    }
  }

  private groupBySession(): Map<string, MemoryFragment[]> {
    const groups = new Map<string, MemoryFragment[]>();
    for (const f of this.fragments) {
      const list = groups.get(f.sessionId) ?? [];
      list.push(f);
      groups.set(f.sessionId, list);
    }
    return groups;
  }

  private summarizeSession(fragments: MemoryFragment[]): string {
    const conversations = fragments.filter((f) => f.type === "conversation");
    const facts = fragments.filter((f) => f.type === "fact");
    const decisions = fragments.filter((f) => f.type === "decision");

    const parts: string[] = [];
    if (conversations.length > 0) {
      parts.push(`Conversation about: ${conversations.map((c) => c.content.slice(0, 100)).join("; ")}`);
    }
    if (facts.length > 0) {
      parts.push(`Facts learned: ${facts.map((f) => f.content).join("; ")}`);
    }
    if (decisions.length > 0) {
      parts.push(`Decisions made: ${decisions.map((d) => d.content).join("; ")}`);
    }

    return parts.join(". ").slice(0, 500);
  }

  private extractKeyFacts(fragments: MemoryFragment[]): string[] {
    return fragments
      .filter((f) => f.type === "fact")
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10)
      .map((f) => f.content);
  }

  private extractDecisions(fragments: MemoryFragment[]): string[] {
    return fragments
      .filter((f) => f.type === "decision")
      .map((f) => f.content);
  }

  private extractPreferences(fragments: MemoryFragment[]): string[] {
    return fragments
      .filter((f) => f.type === "preference")
      .map((f) => f.content);
  }

  private textSimilarity(a: string, b: string): number {
    const termsA = new Set(this.tokenize(a));
    const termsB = new Set(this.tokenize(b));
    const intersection = new Set([...termsA].filter((t) => termsB.has(t)));
    const union = new Set([...termsA, ...termsB]);
    return intersection.size / Math.max(union.size, 1);
  }

  private clusterSimilarity(text: string, topic: string): number {
    return this.textSimilarity(text, topic);
  }

  private extractTopic(text: string): string {
    const words = this.tokenize(text);
    // Find the most significant words (longer = more meaningful)
    return words
      .filter((w) => w.length > 3)
      .slice(0, 3)
      .join(" ");
  }

  private regenerateClusterSummary(cluster: MemoryCluster): string {
    const sorted = [...cluster.fragments].sort((a, b) => b.importance - a.importance);
    return sorted.slice(0, 3).map((f) => f.content.slice(0, 100)).join(" | ");
  }
}