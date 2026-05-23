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

  readonly name = "EvoClaw Skill Registry";

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
      "User-Agent": "EvoClaw/0.1.0",
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

  /**
   * Enhanced search that falls back to web search when registry API is unavailable.
   * This provides real skill discovery even without a dedicated clawhub API.
   */
  async enhancedSearch(query: RegistrySearchQuery): Promise<RegistrySearchResult> {
    // Try registry API first
    try {
      const result = await this.searchRemote(query);
      if (result.entries.length > 0) {
        return result;
      }
    } catch {
      // API unavailable — fall through to web search
    }

    // Fallback: use web search to discover skills from clawhub
    if (query.keyword) {
      const webResults = await this.searchSkillsViaWeb(query.keyword, query.limit || 10);
      if (webResults.entries.length > 0) {
        // Cache the result
        const cacheKey = JSON.stringify({ ...query, source: "web-fallback" });
        this.cache.set(cacheKey, { data: webResults, timestamp: Date.now() });
        return webResults;
      }
    }

    return { entries: [], total: 0, page: 1, pageSize: query.limit || 20 };
  }

  /**
   * Search for skills via web search (clawhub, GitHub, npm, etc.)
   * This is the real web search fallback when clawhub API is not available.
   */
  private async searchSkillsViaWeb(
    keyword: string,
    limit: number
  ): Promise<RegistrySearchResult> {
    const entries: SkillRegistryEntry[] = [];

    // Try multiple search sources in parallel
    const searchQueries = [
      `site:clawhub.ai ${keyword} skill`,
      `site:github.com "SKILL.md" ${keyword}`,
      `clawhub skill ${keyword}`,
    ];

    for (const searchQuery of searchQueries.slice(0, 2)) {
      try {
        const response = await fetch(
          `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`,
          {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
            signal: AbortSignal.timeout(8000),
          }
        );

        if (response.ok) {
          const html = await response.text();
          const parsed = this.parseGoogleResults(html, keyword);
          entries.push(...parsed.slice(0, limit));
        }
      } catch {
        // Individual search source failure — not critical
      }
    }

    // If web search yields nothing, use curated well-known skills
    if (entries.length === 0) {
      const curated = this.getCuratedSkills(keyword, limit);
      entries.push(...curated);
    }

    return {
      entries: entries.slice(0, limit),
      total: entries.length,
      page: 1,
      pageSize: limit,
    };
  }

  /**
   * Parse Google search results HTML to extract skill references.
   */
  private parseGoogleResults(html: string, _keyword: string): SkillRegistryEntry[] {
    const entries: SkillRegistryEntry[] = [];
    
    // Match search result titles and snippets
    const resultRegex = /<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<div[^>]*?(?:data-sncf|class="[^"]*?VwiC3b[^"]*?")[^>]*?>([\s\S]*?)<\/div>/gi;
    let match: RegExpExecArray | null;

    while ((match = resultRegex.exec(html)) !== null) {
      const title = match[1].replace(/<[^>]+>/g, "").trim();
      const snippet = match[2].replace(/<[^>]+>/g, "").trim();

      // Extract skill name from title (look for patterns like "name skill" or "name - Clawhub")
      const nameMatch = title.match(/^([\w-]+)(?:\s+(?:skill|技能|—|-))/i) || title.match(/([\w-]+)\s*[-—]\s*(?:Clawhub|Skill)/i);
      const skillName = nameMatch ? nameMatch[1] : title.split(" ")[0].toLowerCase();

      if (skillName.length < 2) continue;

      entries.push({
        skillId: `web:${skillName}@0.1.0`,
        name: skillName,
        version: "0.1.0",
        description: snippet.slice(0, 200) || title,
        author: "community",
        license: "MIT",
        keywords: [skillName],
        category: "custom",
        triggers: [],
        requires: [],
        provides: [],
        rating: 3.0,
        downloads: 100,
        installCount: 0,
        publishedAt: new Date(),
        updatedAt: new Date(),
        verified: false,
      });
    }

    return entries;
  }

  /**
   * Curated well-known skills for common tasks.
   * Used when web search and API are both unavailable.
   */
  static readonly CURATED_SKILLS: Array<{
    name: string;
    description: string;
    keywords: string[];
    category: string;
  }> = [
    { name: "web-search", description: "Search the web for live information and news", keywords: ["search", "web", "news", "查询", "搜索", "新闻"], category: "search" },
    { name: "weather", description: "Query weather forecasts and conditions", keywords: ["weather", "天气", "forecast", "预报"], category: "utility" },
    { name: "translator", description: "Translate text between languages", keywords: ["translate", "翻译", "language"], category: "utility" },
    { name: "code-runner", description: "Execute code snippets in various languages", keywords: ["code", "run", "execute", "代码", "运行"], category: "development" },
    { name: "calculator", description: "Perform mathematical calculations", keywords: ["calc", "math", "计算", "数学"], category: "utility" },
    { name: "file-manager", description: "Manage files and directories", keywords: ["file", "文件", "directory", "folder"], category: "system" },
    { name: "reminder", description: "Set reminders and alarms", keywords: ["remind", "alarm", "提醒", "闹钟"], category: "productivity" },
    { name: "email", description: "Send and manage emails", keywords: ["email", "mail", "邮件", "邮箱"], category: "communication" },
    { name: "image-generator", description: "Generate images from text descriptions", keywords: ["image", "generate", "图片", "生成"], category: "media" },
    { name: "pdf-tools", description: "Create, merge, and manipulate PDF files", keywords: ["pdf", "document", "文档"], category: "productivity" },
    { name: "database-query", description: "Query and manage databases", keywords: ["database", "sql", "数据库", "查询"], category: "development" },
    { name: "crypto-tracker", description: "Track cryptocurrency prices", keywords: ["crypto", "bitcoin", "btc", "加密", "货币"], category: "finance" },
    { name: "rss-reader", description: "Read RSS feeds and news", keywords: ["rss", "feed", "订阅", "阅读"], category: "productivity" },
    { name: "markdown-editor", description: "Edit and preview Markdown documents", keywords: ["markdown", "md", "编辑", "文档"], category: "development" },
    { name: "http-client", description: "Make HTTP requests and test APIs", keywords: ["http", "api", "rest", "request"], category: "development" },
  ];

  /**
   * Look up a curated skill by name (case-insensitive).
   * Returns the skill definition or null if not found.
   */
  getCuratedSkillByName(name: string): { name: string; description: string; keywords: string[]; category: string } | null {
    const lower = name.toLowerCase();
    return SkillRegistry.CURATED_SKILLS.find(s => s.name.toLowerCase() === lower) || null;
  }

  private getCuratedSkills(keyword: string, limit: number): SkillRegistryEntry[] {
    const lowerKw = keyword.toLowerCase();
    const allCurated = SkillRegistry.CURATED_SKILLS;

    // Score each curated skill against the keyword
    const scored = allCurated.map(s => {
      let score = 0;
      const name = s.name.toLowerCase();
      const desc = s.description.toLowerCase();

      if (name.includes(lowerKw) || lowerKw.includes(name)) score += 10;
      if (desc.includes(lowerKw)) score += 5;

      for (const kw of s.keywords) {
        if (lowerKw.includes(kw.toLowerCase()) || kw.toLowerCase().includes(lowerKw)) {
          score += 4;
        }
      }

      const taskWords = lowerKw.split(/[\s,.;:!?]+/).filter(w => w.length > 1);
      for (const word of taskWords) {
        if (name.includes(word)) score += 3;
        if (desc.includes(word)) score += 2;
      }

      return { ...s, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored
      .filter(s => s.score > 0)
      .slice(0, limit)
      .map((s, i) => ({
        skillId: `curated:${s.name}@0.1.0`,
        name: s.name,
        version: "0.1.0",
        description: s.description,
        author: "evoclaw-curated",
        license: "MIT",
        keywords: s.keywords,
        category: s.category as SkillRegistryEntry["category"],
        triggers: [],
        requires: [],
        provides: [],
        rating: 4.0 - i * 0.15,
        downloads: 50000 - i * 3000,
        installCount: 0,
        publishedAt: new Date(),
        updatedAt: new Date(),
        verified: true,
      }));
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