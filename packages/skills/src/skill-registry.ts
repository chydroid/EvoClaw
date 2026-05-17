import {
  ServiceRegistry,
  EventBus,
  type Skill,
  type SkillCategory,
  type SkillTrigger,
  type SkillDependency,
} from "@evoclaw/core";

export interface SkillRegistryEntry {
  skillId: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  keywords: string[];
  category: SkillCategory;
  triggers: SkillTrigger[];
  requires: SkillDependency[];
  provides: { name: string; description: string }[];
  homepage?: string;
  repository?: string;
  rating: number;
  downloads: number;
  installCount: number;
  publishedAt: Date;
  updatedAt: Date;
  verified: boolean;
}

export interface RegistrySearchQuery {
  keyword?: string;
  category?: SkillCategory;
  triggerType?: SkillTrigger["type"];
  author?: string;
  verified?: boolean;
  sortBy?: "rating" | "downloads" | "updatedAt" | "publishedAt";
  limit?: number;
  offset?: number;
}

export interface RegistrySearchResult {
  entries: SkillRegistryEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RemoteRegistryConfig {
  url: string;
  enabled: boolean;
  priority: number;
  cacheTTL: number;
  authToken?: string;
}

export class SkillRegistry {
  private entries = new Map<string, SkillRegistryEntry>();
  private remoteRegistries: RemoteRegistryConfig[] = [];
  private cache = new Map<string, { data: RegistrySearchResult; timestamp: number }>();
  private localSkills = new Map<string, Skill>();

  private static readonly CACHE_TTL = 300000;

  readonly name = "EcoClaw Skill Registry";

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("skillRegistry", this);
    this.registerDefaultRemoteRegistries();
  }

  registerSkill(skill: Skill): SkillRegistryEntry {
    this.localSkills.set(skill.id, skill);

    const entry: SkillRegistryEntry = {
      skillId: skill.id,
      name: skill.name,
      version: skill.version,
      description: skill.description,
      author: skill.author,
      license: skill.license || "MIT",
      keywords: skill.keywords || [],
      category: skill.category,
      triggers: skill.triggers || [],
      requires: skill.requires || [],
      provides: (skill.provides || []).map((p) => ({
        name: p.name,
        description: p.description,
      })),
      rating: skill.stats.userRating,
      downloads: 0,
      installCount: 1,
      publishedAt: skill.lifecycle?.installDate || new Date(),
      updatedAt: skill.lifecycle?.lastUpdated || new Date(),
      verified: false,
    };

    this.entries.set(skill.id, entry);

    this.eventBus?.publish(
      "registry.skill_registered",
      { skillId: skill.id, name: skill.name, version: skill.version },
      "skill-registry"
    ).catch((err) => { console.debug("[SkillRegistry] Register error:", err); });

    return entry;
  }

  unregisterSkill(skillId: string): boolean {
    const existed = this.entries.delete(skillId);
    this.localSkills.delete(skillId);

    if (existed) {
      this.eventBus?.publish(
        "registry.skill_unregistered",
        { skillId },
        "skill-registry"
      ).catch((err) => { console.debug("[SkillRegistry] Unregister error:", err); });
    }

    return existed;
  }

  getSkill(skillId: string): SkillRegistryEntry | undefined {
    return this.entries.get(skillId);
  }

  getLocalSkill(skillId: string): Skill | undefined {
    return this.localSkills.get(skillId);
  }

  searchLocal(query: RegistrySearchQuery): RegistrySearchResult {
    let results = Array.from(this.entries.values());

    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      results = results.filter(
        (e) =>
          e.name.toLowerCase().includes(kw) ||
          e.description.toLowerCase().includes(kw) ||
          e.keywords.some((k) => k.toLowerCase().includes(kw))
      );
    }

    if (query.category) {
      results = results.filter((e) => e.category === query.category);
    }

    if (query.triggerType) {
      results = results.filter((e) =>
        e.triggers.some((t) => t.type === query.triggerType)
      );
    }

    if (query.author) {
      results = results.filter((e) =>
        e.author.toLowerCase().includes(query.author!.toLowerCase())
      );
    }

    if (query.verified !== undefined) {
      results = results.filter((e) => e.verified === query.verified);
    }

    const sortBy = query.sortBy || "rating";
    results.sort((a, b) => {
      switch (sortBy) {
        case "rating":
          return b.rating - a.rating;
        case "downloads":
          return b.downloads - a.downloads;
        case "updatedAt":
          return b.updatedAt.getTime() - a.updatedAt.getTime();
        case "publishedAt":
          return b.publishedAt.getTime() - a.publishedAt.getTime();
        default:
          return 0;
      }
    });

    const offset = query.offset || 0;
    const limit = query.limit || 20;
    const page = Math.floor(offset / limit) + 1;

    return {
      entries: results.slice(offset, offset + limit),
      total: results.length,
      page,
      pageSize: limit,
    };
  }

  addRemoteRegistry(config: RemoteRegistryConfig): void {
    const existing = this.remoteRegistries.findIndex((r) => r.url === config.url);
    if (existing >= 0) {
      this.remoteRegistries[existing] = config;
    } else {
      this.remoteRegistries.push(config);
    }
  }

  removeRemoteRegistry(url: string): void {
    this.remoteRegistries = this.remoteRegistries.filter((r) => r.url !== url);
  }

  getRemoteRegistries(): RemoteRegistryConfig[] {
    return [...this.remoteRegistries];
  }

  async searchRemote(
    query: RegistrySearchQuery
  ): Promise<RegistrySearchResult> {
    const cacheKey = JSON.stringify({ ...query, source: "remote" });
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < SkillRegistry.CACHE_TTL) {
      return cached.data;
    }

    let allEntries: SkillRegistryEntry[] = [];
    let total = 0;

    for (const remote of this.remoteRegistries.filter((r) => r.enabled)) {
      try {
        const result = await this.queryRemoteRegistry(remote, query);
        allEntries = allEntries.concat(result.entries);
        total += result.total;
      } catch (err) {
        console.warn(
          `[SkillRegistry] Failed to query remote registry "${remote.url}":`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    const deduplicated = this.deduplicateByName(allEntries);

    const sortBy = query.sortBy || "rating";
    deduplicated.sort((a, b) => {
      switch (sortBy) {
        case "rating":
          return b.rating - a.rating;
        case "downloads":
          return b.downloads - a.downloads;
        default:
          return 0;
      }
    });

    const offset = query.offset || 0;
    const limit = query.limit || 20;

    const result: RegistrySearchResult = {
      entries: deduplicated.slice(offset, offset + limit),
      total: deduplicated.length,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
    };

    this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  }

  async searchBoth(query: RegistrySearchQuery): Promise<RegistrySearchResult> {
    const local = this.searchLocal(query);

    if (this.remoteRegistries.some((r) => r.enabled)) {
      try {
        const remote = await this.searchRemote(query);
        const merged = this.mergeResults(local, remote);
        return merged;
      } catch {
        return local;
      }
    }

    return local;
  }

  listAllSkills(): SkillRegistryEntry[] {
    return Array.from(this.entries.values());
  }

  getSkillCount(): number {
    return this.entries.size;
  }

  private registerDefaultRemoteRegistries(): void {
    this.remoteRegistries = [
      {
        url: "https://clawhub.ai",
        enabled: true,
        priority: 10,
        cacheTTL: 300000,
      },
      {
        url: "https://cn.clawhub-mirror.com",
        enabled: true,
        priority: 9,
        cacheTTL: 300000,
      },
    ];
  }

  private async queryRemoteRegistry(
    remote: RemoteRegistryConfig,
    query: RegistrySearchQuery
  ): Promise<RegistrySearchResult> {
    const params = new URLSearchParams();

    if (query.keyword) params.set("q", query.keyword);
    if (query.category) params.set("category", query.category);
    if (query.triggerType) params.set("triggerType", query.triggerType);
    if (query.sortBy) params.set("sortBy", query.sortBy);
    if (query.limit) params.set("limit", String(query.limit));
    if (query.offset) params.set("offset", String(query.offset));

    const url = `${remote.url}/v1/search?${params.toString()}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "EcoClaw/0.1.0",
    };

    if (remote.authToken) {
      headers["Authorization"] = `Bearer ${remote.authToken}`;
    }

    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`Remote registry returned ${response.status}`);
      }

      const data = (await response.json()) as RegistrySearchResult;

      for (const entry of data.entries) {
        if (!entry.skillId) {
          entry.skillId = `remote:${entry.name}@${entry.version}`;
        }
        entry.verified = entry.verified ?? false;
      }

      return data;
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`Registry "${remote.url}" timed out`);
      }
      throw err;
    }
  }

  private deduplicateByName(entries: SkillRegistryEntry[]): SkillRegistryEntry[] {
    const seen = new Map<string, SkillRegistryEntry>();

    for (const entry of entries) {
      const existing = seen.get(entry.name);
      if (!existing || this.compareVersion(entry.version, existing.version) > 0) {
        seen.set(entry.name, entry);
      }
    }

    return Array.from(seen.values());
  }

  private compareVersion(a: string, b: string): number {
    const parse = (v: string) => v.split(".").map(Number);
    const partsA = parse(a);
    const partsB = parse(b);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const pa = partsA[i] || 0;
      const pb = partsB[i] || 0;
      if (pa !== pb) return pa - pb;
    }

    return 0;
  }

  private mergeResults(
    local: RegistrySearchResult,
    remote: RegistrySearchResult
  ): RegistrySearchResult {
    const seen = new Set<string>();
    const merged: SkillRegistryEntry[] = [];

    for (const entry of [...local.entries, ...remote.entries]) {
      const key = `${entry.name}@${entry.version}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(entry);
      }
    }

    return {
      entries: merged.slice(0, remote.pageSize),
      total: local.total + remote.total,
      page: 1,
      pageSize: remote.pageSize,
    };
  }
}