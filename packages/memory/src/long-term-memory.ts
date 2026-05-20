import { type LongTermMemory, type MemoryEntry, type MemorySearchQuery, type MemorySearchResult, DEFAULT_EMBEDDING_DIMENSION, COSINE_SIMILARITY_THRESHOLD } from "@evoclaw/core";
import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";

const MEMORY_FILE = path.join(process.cwd(), "data", "memory", "long-term.json");
const SAVE_DEBOUNCE_MS = 2000;

export class LongTermMemoryStore implements LongTermMemory {
  private entries = new Map<string, MemoryEntry>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor() {
    this.loadFromDisk();
  }

  /** Load persisted memory from disk */
  private loadFromDisk(): void {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const item of data) {
            const entry: MemoryEntry = {
              ...item,
              createdAt: new Date(item.createdAt),
              accessedAt: new Date(item.accessedAt),
            };
            this.entries.set(entry.id, entry);
          }
          console.log(`[LongTermMemory] Loaded ${this.entries.size} entries from disk`);
        }
      }
    } catch (err) {
      console.warn(`[LongTermMemory] Failed to load from disk: ${err}`);
    }
  }

  /** Save to disk with debounce */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveToDisk(), SAVE_DEBOUNCE_MS);
  }

  private saveToDisk(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const dir = path.dirname(MEMORY_FILE);
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          // PowerShell fallback
          const { execSync } = require("child_process");
          execSync(`powershell -Command "New-Item -Path '${dir}' -ItemType Directory -Force"`, { stdio: "pipe" });
        }
      }
      const data = Array.from(this.entries.values()).map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
        accessedAt: e.accessedAt.toISOString(),
      }));
      try {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), "utf-8");
      } catch {
        // PowerShell fallback for restricted filesystem
        const tmp = JSON.stringify(data);
        const b64 = Buffer.from(tmp, "utf-8").toString("base64");
        const { execSync } = require("child_process");
        execSync(
          `powershell -Command "[IO.File]::WriteAllBytes('${MEMORY_FILE}', [Convert]::FromBase64String('${b64}'))"`,
          { stdio: "pipe" }
        );
      }
    } catch (err) {
      console.warn(`[LongTermMemory] Failed to save: ${err}`);
    }
  }

  async store(entry: MemoryEntry): Promise<MemoryEntry> {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: entry.id || uuid(),
      createdAt: entry.createdAt || new Date(),
      accessedAt: entry.accessedAt || new Date(),
    };
    this.entries.set(fullEntry.id, fullEntry);
    this.scheduleSave();
    return fullEntry;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];

    for (const entry of this.entries.values()) {
      let score = 0;
      const matchedFields: string[] = [];

      if (query.type && entry.type !== query.type) continue;

      if (query.tags?.length) {
        const tagMatch = query.tags.some((t) => entry.metadata.tags.includes(t));
        if (!tagMatch) continue;
        matchedFields.push("tags");
        score += 0.3;
      }

      if (query.minImportance && entry.metadata.importance < query.minImportance) continue;

      if (query.query && entry.content.toLowerCase().includes(query.query.toLowerCase())) {
        score += 0.5;
        matchedFields.push("content");
      }

      if (query.embedding && entry.embedding) {
        const similarity = this.cosineSimilarity(query.embedding, entry.embedding);
        if (similarity >= (query.threshold || COSINE_SIMILARITY_THRESHOLD)) {
          score += similarity * 0.5;
          matchedFields.push("embedding");
        } else if (!matchedFields.length) {
          continue;
        }
      }

      if (score > 0) {
        results.push({ entry, score, matchedFields });
      }
    }

    results.sort((a, b) => b.score - a.score);

    return query.limit ? results.slice(0, query.limit) : results;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const entry = this.entries.get(id);
    if (entry) {
      entry.accessedAt = new Date();
      this.scheduleSave();
    }
    return entry || null;
  }

  async update(id: string, updates: Partial<MemoryEntry>): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      this.entries.set(id, { ...entry, ...updates, accessedAt: new Date() });
      this.scheduleSave();
    }
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
    this.scheduleSave();
  }

  async expire(): Promise<number> {
    let expired = 0;
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.createdAt.getTime() + entry.ttl < now) {
        this.entries.delete(id);
        expired++;
      }
    }
    if (expired > 0) this.scheduleSave();
    return expired;
  }

  /** Get all entries (for backup/export) */
  async getAll(): Promise<MemoryEntry[]> {
    return Array.from(this.entries.values());
  }

  /** Force immediate save */
  async flush(): Promise<void> {
    this.saveToDisk();
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }
}