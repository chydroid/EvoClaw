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

export class MemoryHub {
  private shortTerm: ShortTermMemory;
  private longTerm: LongTermMemory;
  private graph: KnowledgeGraph;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.shortTerm = new ShortTermMemoryStore();
    this.longTerm = new LongTermMemoryStore();
    this.graph = new KnowledgeGraphStore();

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

  async remember(entry: Omit<MemoryEntry, "id" | "createdAt" | "accessedAt">): Promise<MemoryEntry> {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: "",
      createdAt: new Date(),
      accessedAt: new Date(),
    };
    const storedEntry = await this.longTerm.store(fullEntry);
    await this.eventBus.publish(SystemEvents.MEMORY_STORED, storedEntry, "memory-hub");
    return storedEntry;
  }

  async recall(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const results = await this.longTerm.search(query);
    await this.eventBus.publish(SystemEvents.MEMORY_RETRIEVED, { query, results }, "memory-hub");
    return results;
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