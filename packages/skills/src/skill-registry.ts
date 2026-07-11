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
  /** 远程注册表健康状态缓存：避免对失败的注册表短时间内反复重试 */
  private remoteHealth = new Map<string, { healthy: boolean; lastCheck: number; consecutiveFailures: number }>();

  private static readonly CACHE_TTL = 300000;
  private static readonly CACHE_MAX_SIZE = 500;
  /** 注册表失败后标记为不健康的时间窗口（5 分钟） */
  private static readonly UNHEALTHY_TTL_MS = 5 * 60 * 1000;
  /** 连续失败次数达到阈值后延长冷却（指数退避上限） */
  private static readonly MAX_BACKOFF_FAILURES = 5;

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

    // 跳过近期标记为不健康的注册表，避免对失败端点反复重试
    const enabledRemotes = this.remoteRegistries.filter(
      (r) => r.enabled && this.isRegistryHealthy(r.url)
    );
    const remoteResults = await Promise.allSettled(
      enabledRemotes.map((remote) => this.queryRemoteRegistry(remote, query))
    );

    for (let i = 0; i < remoteResults.length; i++) {
      const result = remoteResults[i];
      if (result.status === "fulfilled") {
        allEntries = allEntries.concat(result.value.entries);
        total += result.value.total;
        // 成功一次即清除失败计数
        this.markRegistryHealthy(enabledRemotes[i].url);
      } else {
        this.markRegistryUnhealthy(
          enabledRemotes[i].url,
          result.reason instanceof Error ? result.reason.message : String(result.reason)
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
    this.evictExpiredCacheEntries();
    return result;
  }

  /**
   * 判断远程注册表近期是否健康。
   * 失败后会按指数退避延长冷却窗口，避免对不可达端点反复重试。
   */
  private isRegistryHealthy(url: string): boolean {
    const health = this.remoteHealth.get(url);
    if (!health) return true;
    if (health.healthy) return true;
    // 不健康时计算冷却窗口：5 分钟 × 2^min(failures, MAX)，最长 2^5 * 5min ≈ 160min
    const backoffExp = Math.min(health.consecutiveFailures, SkillRegistry.MAX_BACKOFF_FAILURES);
    const cooldownMs = SkillRegistry.UNHEALTHY_TTL_MS * Math.pow(2, backoffExp);
    const elapsed = Date.now() - health.lastCheck;
    if (elapsed >= cooldownMs) {
      // 冷却期已过，允许重试（但仍保留失败计数，若再次失败则继续延长）
      return true;
    }
    return false;
  }

  /** 标记注册表为健康，清除失败计数 */
  private markRegistryHealthy(url: string): void {
    this.remoteHealth.set(url, { healthy: true, lastCheck: Date.now(), consecutiveFailures: 0 });
  }

  /** 标记注册表为不健康，记录连续失败次数用于指数退避 */
  private markRegistryUnhealthy(url: string, reason: string): void {
    const prev = this.remoteHealth.get(url);
    const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
    this.remoteHealth.set(url, {
      healthy: false,
      lastCheck: Date.now(),
      consecutiveFailures,
    });
    // 仅在失败次数为 1 时打印（避免日志被刷屏）
    if (consecutiveFailures === 1) {
      process.stderr.write(
        `[SkillRegistry] Remote "${url}" marked unhealthy: ${reason}\n`
      );
    }
  }

  /** 获取所有远程注册表的健康状态快照（用于诊断与展示） */
  getRemoteRegistryHealth(): Array<{ url: string; healthy: boolean; lastCheck: number; consecutiveFailures: number }> {
    return this.remoteRegistries.map((r) => {
      const h = this.remoteHealth.get(r.url);
      return {
        url: r.url,
        healthy: h ? h.healthy : true,
        lastCheck: h ? h.lastCheck : 0,
        consecutiveFailures: h ? h.consecutiveFailures : 0,
      };
    });
  }

  /** 重置所有远程注册表健康状态（用于强制重试） */
  resetRemoteHealth(): void {
    this.remoteHealth.clear();
  }

  /** 清理过期与超量的缓存条目，防止无界增长 */
  private evictExpiredCacheEntries(): void {
    if (this.cache.size < SkillRegistry.CACHE_MAX_SIZE) return;
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp >= SkillRegistry.CACHE_TTL) {
        this.cache.delete(key);
      }
    }
    if (this.cache.size >= SkillRegistry.CACHE_MAX_SIZE) {
      const sorted = Array.from(this.cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = sorted.slice(0, sorted.length - Math.floor(SkillRegistry.CACHE_MAX_SIZE / 2));
      for (const [key] of toRemove) this.cache.delete(key);
    }
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

      // 防御性检查：远程注册表可能返回非预期格式（如 HTML 错误页、空对象、字段缺失）
      if (!data || typeof data !== "object") {
        throw new Error(`Remote registry "${remote.url}" returned non-object response`);
      }
      if (!Array.isArray(data.entries)) {
        const bodyPreview = JSON.stringify(data).slice(0, 200);
        throw new Error(`Remote registry "${remote.url}" returned unexpected shape (entries is ${data.entries === undefined ? "missing" : typeof data.entries}): ${bodyPreview}`);
      }

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
   * Enhanced search that tries (1) remote registries, (2) curated fallback.
   * 远程注册表失败时立即降级到 curated 列表，不再尝试用搜索引擎抓 HTML（不稳定）。
   */
  async enhancedSearch(query: RegistrySearchQuery): Promise<RegistrySearchResult> {
    // Try registry API first
    try {
      const result = await this.searchRemote(query);
      if (result.entries.length > 0) {
        return result;
      }
    } catch {
      // API unavailable — fall through to curated fallback
    }

    // Fallback: use curated well-known skills (no network dependency)
    if (query.keyword) {
      const curated = this.getCuratedSkills(query.keyword, query.limit || 10);
      if (curated.length > 0) {
        const fallback: RegistrySearchResult = {
          entries: curated,
          total: curated.length,
          page: 1,
          pageSize: query.limit || 20,
        };
        // Cache the result
        const cacheKey = JSON.stringify({ ...query, source: "curated-fallback" });
        this.cache.set(cacheKey, { data: fallback, timestamp: Date.now() });
        this.evictExpiredCacheEntries();
        return fallback;
      }
    }

    return { entries: [], total: 0, page: 1, pageSize: query.limit || 20 };
  }

  /**
   * Curated well-known skills for common tasks.
   * Used when both remote registry and local search yield no results.
   * 包含 bundled 技能入口，便于用户在没有可访问远程注册表时也能安装。
   */
  static readonly CURATED_SKILLS: Array<{
    name: string;
    description: string;
    keywords: string[];
    category: string;
    /** 当本地已安装 bundled 技能时，用于匹配本地 skill name */
    bundledAs?: string;
  }> = [
    // ── 与 bundled/ 目录对应的官方自带技能 ──
    { name: "calculator", description: "数学计算器 — 四则运算、幂运算、三角函数、对数、统计。", keywords: ["calc", "math", "计算", "数学"], category: "utility", bundledAs: "calculator" },
    { name: "text-utils", description: "文本工具 — 统计、大小写转换、Base64、URL 编码、JSON 美化。", keywords: ["text", "string", "base64", "文本", "字符串"], category: "utility", bundledAs: "text-utils" },
    { name: "unit-converter", description: "单位转换 — 长度、重量、温度、面积、体积、速度、时间、数据存储。", keywords: ["unit", "convert", "单位", "换算"], category: "utility", bundledAs: "unit-converter" },
    { name: "color-tools", description: "颜色工具 — HEX/RGB/HSL 互转、混合、明暗调整、对比度、配色。", keywords: ["color", "hex", "rgb", "颜色", "配色"], category: "utility", bundledAs: "color-tools" },
    // ── 常见社区技能（仅作为建议返回，需远程或用户安装）──
    { name: "web-search", description: "Search the web for live information and news", keywords: ["search", "web", "news", "查询", "搜索", "新闻"], category: "utility" },
    { name: "weather", description: "Query weather forecasts and conditions", keywords: ["weather", "天气", "forecast", "预报"], category: "utility" },
    { name: "translator", description: "Translate text between languages", keywords: ["translate", "翻译", "language"], category: "utility" },
    { name: "code-runner", description: "Execute code snippets in various languages", keywords: ["code", "run", "execute", "代码", "运行"], category: "automation" },
    { name: "file-manager", description: "Manage files and directories", keywords: ["file", "文件", "directory", "folder"], category: "automation" },
    { name: "reminder", description: "Set reminders and alarms", keywords: ["remind", "alarm", "提醒", "闹钟"], category: "utility" },
    { name: "email", description: "Send and manage emails", keywords: ["email", "mail", "邮件", "邮箱"], category: "integration" },
    { name: "image-generator", description: "Generate images from text descriptions", keywords: ["image", "generate", "图片", "生成"], category: "generation" },
    { name: "pdf-tools", description: "Create, merge, and manipulate PDF files", keywords: ["pdf", "document", "文档"], category: "utility" },
    { name: "database-query", description: "Query and manage databases", keywords: ["database", "sql", "数据库", "查询"], category: "automation" },
    { name: "rss-reader", description: "Read RSS feeds and news", keywords: ["rss", "feed", "订阅", "阅读"], category: "utility" },
    { name: "markdown-editor", description: "Edit and preview Markdown documents", keywords: ["markdown", "md", "编辑", "文档"], category: "automation" },
    { name: "http-client", description: "Make HTTP requests and test APIs", keywords: ["http", "api", "rest", "request"], category: "automation" },
  ];

  /**
   * Look up a curated skill by name (case-insensitive).
   * Returns the skill definition or null if not found.
   */
  getCuratedSkillByName(name: string): { name: string; description: string; keywords: string[]; category: string; bundledAs?: string } | null {
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

      // bundledAs 标记的官方技能给加权
      if (s.bundledAs) score += 2;

      return { ...s, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored
      .filter(s => s.score > 0)
      .slice(0, limit)
      .map((s) => ({
        skillId: s.bundledAs ? `bundled:${s.name}@1.0.0` : `curated:${s.name}@0.1.0`,
        name: s.name,
        version: s.bundledAs ? "1.0.0" : "0.1.0",
        description: s.description,
        author: s.bundledAs ? "evoclaw-official" : "evoclaw-curated",
        license: "MIT",
        keywords: s.keywords,
        category: s.category as SkillRegistryEntry["category"],
        triggers: [],
        requires: [],
        provides: [],
        rating: s.bundledAs ? 5.0 : 0,
        downloads: s.bundledAs ? 1000 : 0,
        installCount: 0,
        publishedAt: new Date(),
        updatedAt: new Date(),
        verified: Boolean(s.bundledAs),
        homepage: s.bundledAs ? "https://github.com/chydroid/EvoClaw" : undefined,
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
    const parse = (v: string) => v.split(".").map((part) => {
      const n = Number(part);
      // 非数字段（如 "1.0.0-alpha" 中的 "0-alpha" / "alpha"）会产生 NaN，
      // 此处统一视为 0 以避免 NaN 污染比较结果。
      // 已知限制：此方案无法区分 1.0.0-alpha 与 1.0.0-beta 的先后顺序，
      // 仅保证语义化版本号数值部分的正确比较。
      return isNaN(n) ? 0 : n;
    });
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

    // Sort merged results by rating
    merged.sort((a, b) => b.rating - a.rating);

    const pageSize = Math.max(local.pageSize, remote.pageSize);
    return {
      entries: merged.slice(0, pageSize),
      total: merged.length,
      page: 1,
      pageSize,
    };
  }
}