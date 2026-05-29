export interface SkillIndexEntry {
  id: string;
  name: string;
  level0: string;
  level1: string;
  level2: string;
  category: string;
  keywords: string[];
  lastUsedAt: number | null;
  useCount: number;
  successRate: number;
  lastValidatedAt: number | null;
  apiVersion: string | null;
}

export interface SkillSearchResult {
  entry: SkillIndexEntry;
  relevanceScore: number;
  matchedLevel: 0 | 1 | 2;
}

export class SkillIndex {
  private entries = new Map<string, SkillIndexEntry>();
  private dirty = false;

  indexSkill(skill: {
    id: string;
    name: string;
    description: string;
    body: { instructions: string };
    category: string;
    keywords: string[];
    stats: { invocationCount: number; successCount: number; failureCount: number; lastInvocation: Date | null };
  }): void {
    const desc = skill.description || "";
    const instr = skill.body?.instructions || "";

    const level0 = `${skill.name}: ${desc.slice(0, 80)}`.trim();
    const level1 = `${desc}\n\n${instr.slice(0, 500)}`.trim();
    const level2 = instr;

    const totalInvocations = skill.stats.invocationCount;
    const successRate = totalInvocations > 0
      ? skill.stats.successCount / totalInvocations
      : 0;

    const existing = this.entries.get(skill.id);
    const entry: SkillIndexEntry = {
      id: skill.id,
      name: skill.name,
      level0,
      level1,
      level2,
      category: skill.category,
      keywords: skill.keywords || [],
      lastUsedAt: skill.stats.lastInvocation ? skill.stats.lastInvocation.getTime() : (existing?.lastUsedAt ?? null),
      useCount: totalInvocations,
      successRate,
      lastValidatedAt: existing?.lastValidatedAt ?? null,
      apiVersion: existing?.apiVersion ?? null,
    };

    this.entries.set(skill.id, entry);
    this.dirty = true;
  }

  getLevel0Index(): string {
    const lines: string[] = [];
    for (const entry of this.entries.values()) {
      lines.push(`• ${entry.name}: ${entry.level0.replace(new RegExp(`^${escapeRegExp(entry.name)}:\\s*`), "")}`);
    }
    return lines.join("\n");
  }

  getSkillLevel(skillId: string, level: 0 | 1 | 2): string | null {
    const entry = this.entries.get(skillId);
    if (!entry) return null;

    if (level === 0) return entry.level0;
    if (level === 1) return entry.level1;
    return entry.level2;
  }

  search(query: string, limit = 10): SkillSearchResult[] {
    const terms = query
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);

    if (terms.length === 0) return [];

    const results: SkillSearchResult[] = [];

    for (const entry of this.entries.values()) {
      let score = 0;
      let matchedLevel: 0 | 1 | 2 = 0;

      const nameLower = entry.name.toLowerCase();
      const kwLower = entry.keywords.map((k) => k.toLowerCase());
      const descLower = entry.level0.toLowerCase();
      const instrLower = entry.level1.toLowerCase();

      for (const term of terms) {
        if (nameLower.includes(term)) {
          score += 10;
          matchedLevel = Math.max(matchedLevel, 0) as 0 | 1 | 2;
        }

        for (const kw of kwLower) {
          if (kw === term) {
            score += 8;
            matchedLevel = Math.max(matchedLevel, 0) as 0 | 1 | 2;
          } else if (kw.includes(term)) {
            score += 4;
            matchedLevel = Math.max(matchedLevel, 0) as 0 | 1 | 2;
          }
        }

        if (descLower.includes(term)) {
          const count = countOccurrences(descLower, term);
          score += 3 * count;
          matchedLevel = Math.max(matchedLevel, 1) as 0 | 1 | 2;
        }

        if (instrLower.includes(term)) {
          const count = countOccurrences(instrLower, term);
          score += 1 * count;
          matchedLevel = Math.max(matchedLevel, 2) as 0 | 1 | 2;
        }
      }

      if (score > 0) {
        score += entry.useCount * 0.1;
        score += entry.successRate * 2;

        results.push({ entry, relevanceScore: score, matchedLevel });
      }
    }

    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return results.slice(0, limit);
  }

  updateStats(skillId: string, success: boolean): void {
    const entry = this.entries.get(skillId);
    if (!entry) return;

    entry.useCount++;
    entry.lastUsedAt = Date.now();

    const totalSuccesses = Math.round(entry.successRate * (entry.useCount - 1)) + (success ? 1 : 0);
    entry.successRate = totalSuccesses / entry.useCount;

    this.dirty = true;
  }

  markValidated(skillId: string, apiVersion?: string): void {
    const entry = this.entries.get(skillId);
    if (!entry) return;

    entry.lastValidatedAt = Date.now();
    if (apiVersion) {
      entry.apiVersion = apiVersion;
    }
    this.dirty = true;
  }

  getStaleSkills(maxAgeDays: number): SkillIndexEntry[] {
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    const result: SkillIndexEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.lastValidatedAt === null) {
        result.push(entry);
      } else if (now - entry.lastValidatedAt > maxAgeMs) {
        result.push(entry);
      }
    }
    return result;
  }

  removeSkill(skillId: string): boolean {
    const deleted = this.entries.delete(skillId);
    if (deleted) {
      this.dirty = true;
    }
    return deleted;
  }

  getAll(): SkillIndexEntry[] {
    return Array.from(this.entries.values());
  }

  getSize(): number {
    return this.entries.size;
  }
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(term, pos)) !== -1) {
    count++;
    pos += term.length;
  }
  return count;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
