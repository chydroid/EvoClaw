import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type ShortTermMemory,
  type LongTermMemory,
  type KnowledgeGraph,
  type MemoryEntry,
  type MemorySearchQuery,
  type MemorySearchResult,
} from "@evoclaw/core";
import { ShortTermMemoryStore } from "./short-term-memory";
import { LongTermMemoryStore } from "./long-term-memory";
import { KnowledgeGraphStore } from "./knowledge-graph";
import { FTS5SearchEngine, type FTS5SearchResult } from "./fts5-search";
import { MemoryCurator, type MemorySnapshot } from "./memory-curator";

export class MemoryHub {
  private shortTerm: ShortTermMemory;
  private longTerm: LongTermMemory;
  private graph: KnowledgeGraph;
  private fts5: FTS5SearchEngine;
  private curator: MemoryCurator;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.shortTerm = new ShortTermMemoryStore();
    this.longTerm = new LongTermMemoryStore();
    this.graph = new KnowledgeGraphStore();
    this.fts5 = new FTS5SearchEngine();
    this.fts5.initialize();
    this.curator = new MemoryCurator(this.fts5);

    registry.registerService("memoryHub", this);
  }

  getShortTerm(): ShortTermMemory {
    return this.shortTerm;
  }

  getLongTerm(): LongTermMemory {
    return this.longTerm;
  }

  getKnowledgeGraph(): KnowledgeGraph {
    return this.graph;
  }

  getFTS5(): FTS5SearchEngine {
    return this.fts5;
  }

  getCurator(): MemoryCurator {
    return this.curator;
  }

  async remember(entry: Omit<MemoryEntry, "id" | "createdAt" | "accessedAt">): Promise<MemoryEntry> {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: "",
      createdAt: new Date(),
      accessedAt: new Date(),
    };
    const storedEntry = await this.longTerm.store(fullEntry);
    this.fts5.indexEntry(storedEntry.id, storedEntry.content, {
      sessionId: storedEntry.metadata.sessionId,
      type: storedEntry.type,
      createdAt: storedEntry.createdAt,
    });
    await this.eventBus.publish(SystemEvents.MEMORY_STORED, storedEntry, "memory-hub");
    return storedEntry;
  }

  async recall(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const results = await this.longTerm.search(query);
    await this.eventBus.publish(SystemEvents.MEMORY_RETRIEVED, { query, results }, "memory-hub");
    return results;
  }

  searchFullText(query: string, limit?: number): FTS5SearchResult[] {
    return this.fts5.search({ query, limit });
  }

  async curateFromTurn(
    userMessage: string,
    agentResponse: string,
    context: Record<string, unknown>
  ): Promise<MemoryEntry | null> {
    return this.curator.curateFromTurn(userMessage, agentResponse, context, {
      store: (entry: MemoryEntry) => this.remember(entry),
    });
  }

  async freezeMemorySnapshot(): Promise<MemorySnapshot> {
    const allResults = await this.longTerm.search({ query: "", limit: 10000 });
    const allMemories = allResults.map((r) => r.entry);
    return this.curator.freezeSnapshot(allMemories);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async clearShortTerm(): Promise<void> {
    if (this.shortTerm) {
      this.shortTerm.clear();
    }
  }
}
