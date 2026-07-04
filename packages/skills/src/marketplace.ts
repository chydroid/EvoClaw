/**
 * Skill Marketplace — skill publishing, discovery, and installation platform.
 *
 * Enables:
 *  - Publishing skills with metadata (name, version, capabilities, tags)
 *  - Searching skills by name, capability, tags, and compatibility
 *  - Installing/updating skills from the registry
 *  - Rating and review system
 *  - Dependency resolution between skills
 *  - Offline catalog caching for fast queries
 *
 * Integrates with the existing SkillRegistry for local installation
 * and provides a remote API client for clawhub-style registries.
 */

import * as path from "path";
import type { EventBus } from "@evoclaw/core";

// ── Types ─────────────────────────────────────────────────

// ── ClawHub 协议类型（与 openclaw src/infra/clawhub.ts 对齐） ──
// 这些类型对应 openclaw ClawHub registry 的公开 API 响应结构。
// EvoClaw 技能与 openclaw 技能完全兼容，可直接消费 ClawHub registry。

/** ClawHub 技能列表项 — GET /api/v1/skills 返回的 items 元素 */
export interface ClawHubSkillListItem {
  slug: string;
  displayName: string;
  summary?: string;
  tags?: Record<string, string>;
  latestVersion?: { version: string; createdAt: number; changelog?: string } | null;
  metadata?: { os?: string[] | null; systems?: string[] | null } | null;
  createdAt: number;
  updatedAt: number;
  // 兼容旧字段（部分镜像可能仍返回 name/ownerHandle）
  name?: string;
  ownerHandle?: string;
  isOfficial?: boolean;
}

/** ClawHub 搜索结果项 — GET /api/v1/search 返回的 results 元素 */
export interface ClawHubSkillSearchResult {
  score: number;
  slug: string;
  displayName: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
  /** ClawHub 镜像可能返回完整元数据，用于前端详情展示 */
  metaContent?: {
    Files?: string[];
    Keywords?: string[];
    License?: string;
    DisplayDescription?: string;
    displayName?: string;
    owner?: string;
    skillMd?: string;
    latest?: { commit?: string | null; publishedAt?: number; version?: string };
    history?: Array<{ version?: string; createdAt?: number }>;
  } | null;
}

/** ClawHub 技能详情 — GET /api/v1/skills/{slug} */
export interface ClawHubSkillDetail {
  skill: {
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
  } | null;
  latestVersion?: { version: string; createdAt: number; changelog?: string } | null;
  metadata?: { os?: string[] | null; systems?: string[] | null } | null;
  owner?: { handle?: string | null; displayName?: string | null; image?: string | null } | null;
}

/** ClawHub 安装解析响应 — GET /api/v1/skills/{slug}/install */
export type ClawHubSkillInstallResolution =
  | { ok: true; slug: string; installKind: "archive"; archive: { version: string; downloadUrl: string } }
  | { ok: true; slug: string; installKind: "github"; github: { repo: string; path: string; commit: string; contentHash: string; sourceUrl: string } }
  | { ok: false; slug: string; reason: string; message: string; status: number };

export interface SkillPackage {
  /** Unique package name (e.g., "web-search") */
  name: string;
  /** Display name */
  displayName: string;
  /** Semantic version */
  version: string;
  /** Short description (one line) */
  description: string;
  /** Full README / documentation */
  readme?: string;
  /** Author info */
  author: { name: string; email?: string; url?: string };
  /** License */
  license?: string;
  /** Capabilities this skill provides */
  capabilities: string[];
  /** Tags for discovery */
  tags: string[];
  /** EvoClaw version compatibility range */
  evoclawVersion: string;
  /** Dependencies on other skills */
  dependencies: Record<string, string>;
  /** Package size in bytes */
  size?: number;
  /** Download URL */
  downloadURL: string;
  /** Checksum (SHA-256) */
  checksum?: string;
  /** Publish date */
  publishedAt: string;
  /** Update date */
  updatedAt: string;
  /** Download count */
  downloads: number;
  /** Average rating (0-5) */
  rating: number;
  /** Review count */
  reviewCount: number;
  /** Whether this is verified/official */
  verified: boolean;
}

export interface SkillReview {
  id: string;
  packageName: string;
  userId: string;
  rating: number; // 1-5
  title: string;
  comment: string;
  createdAt: string;
  helpful: number;
}

export interface SearchQuery {
  /** Text search across name/description/tags */
  query?: string;
  /** Required capabilities */
  capabilities?: string[];
  /** Filter by tags */
  tags?: string[];
  /** Filter by author */
  author?: string;
  /** Minimum rating */
  minRating?: number;
  /** Only verified packages */
  verifiedOnly?: boolean;
  /** Sort order */
  sort?: "relevance" | "downloads" | "rating" | "updated" | "name";
  /** Sort direction */
  order?: "asc" | "desc";
  /** Pagination limit */
  limit?: number;
  /** Pagination offset */
  offset?: number;
}

export interface SearchResult {
  packages: SkillPackage[];
  total: number;
  query: SearchQuery;
}

export interface InstallResult {
  success: boolean;
  packageName: string;
  version: string;
  installedPath?: string;
  error?: string;
  dependencies?: InstallResult[];
}

export interface MarketplaceConfig {
  /** Registry URL */
  registryURL?: string;
  /** Local cache directory */
  cacheDir?: string;
  /** Update check interval (ms) */
  updateCheckIntervalMs?: number;
  /** Max concurrent downloads */
  maxConcurrentDownloads?: number;
}

// ── Marketplace Manager ───────────────────────────────────

export class SkillMarketplace {
  private config: Required<MarketplaceConfig>;
  private catalog: SkillPackage[] = [];
  private catalogTimestamp = 0;
  private installed = new Map<string, SkillPackage>();
  private eventBus: EventBus;
  private skillManager: { installSkill(skillPath: string): Promise<unknown> } | null;

  constructor(eventBus: EventBus, config: MarketplaceConfig = {}, skillManager?: { installSkill(skillPath: string): Promise<unknown> } | null) {
    this.config = {
      // 默认使用中国镜像；用户可通过 EVOCLAW_MARKETPLACE_REGISTRY_URL 或构造参数覆盖。
      // 与 openclaw 完全兼容：baseUrl 不含 /api/v1 后缀，路径前缀在每次请求时拼接，
      // 与 openclaw src/infra/clawhub.ts 的 normalizeBaseUrl 行为一致。
      registryURL: config.registryURL ?? "https://cn.clawhub-mirror.com",
      cacheDir: config.cacheDir ?? "data/marketplace",
      updateCheckIntervalMs: config.updateCheckIntervalMs ?? 3600_000, // 1 hour
      maxConcurrentDownloads: config.maxConcurrentDownloads ?? 3,
    };
    this.eventBus = eventBus;
    this.skillManager = skillManager ?? null;
  }

  // ── Catalog Operations ──────────────────────────────────

  /**
   * Fetch the latest catalog from the ClawHub registry.
   * 使用 openclaw 兼容的 GET /api/v1/search?q=* 端点拉取技能列表（作为 catalog 缓存）。
   * 注意：优先用 search 端点而非 /api/v1/skills，因为部分镜像（如 cn.clawhub-mirror.com）
   * 不实现 /api/v1/skills 但完整支持 /api/v1/search。
   * 失败时保留旧 catalog，返回 -1 表示刷新失败（供上游透传 partial 标记）。
   */
  async refreshCatalog(): Promise<number> {
    try {
      // 用 q=* 拉取全量列表作为本地 catalog 缓存
      const results = await this.searchRemote("*", 100);
      this.catalog = results.map((r) => this.normalizeSearchResult(r));
      this.catalogTimestamp = Date.now();

      this.eventBus.publish("marketplace:catalog-refreshed", {
        count: this.catalog.length,
        timestamp: this.catalogTimestamp,
      }, "skill-marketplace");

      return this.catalog.length;
    } catch (err) {
      process.stderr.write(`[Marketplace] Failed to refresh catalog: ${err}\n`);
      return -1; // -1 表示刷新失败，供上游识别 partial 状态
    }
  }

  /** 将搜索结果项归一化为内部 SkillPackage 结构（用于 catalog 缓存和 trending） */
  private normalizeSearchResult(r: ClawHubSkillSearchResult): SkillPackage {
    return {
      name: r.slug,
      displayName: r.displayName,
      version: r.version ?? "0.0.0",
      description: r.summary ?? "",
      author: { name: "unknown" },
      license: "MIT-0",
      capabilities: [],
      tags: [],
      evoclawVersion: ">=0.4.0",
      dependencies: {},
      downloadURL: "",
      publishedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : new Date().toISOString(),
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : new Date().toISOString(),
      downloads: 0,
      rating: 0,
      reviewCount: 0,
      verified: false,
    };
  }

  /**
   * 远程搜索 ClawHub 技能，使用 openclaw 兼容的 GET /api/v1/search?q=... 端点。
   * 这是 ClawHub 官方搜索 API，支持全文匹配（slug/displayName/summary），比本地过滤更准确。
   * 失败时抛出错误，由调用方决定是否回退到本地 catalog。
   */
  async searchRemote(query: string, limit = 20): Promise<ClawHubSkillSearchResult[]> {
    const url = new URL(`${this.config.registryURL}/api/v1/search`);
    url.searchParams.set("q", query.trim() || "*");
    url.searchParams.set("limit", String(limit));

    // 使用 AbortController + setTimeout 而非 AbortSignal.timeout()，兼容更广的 Node 版本
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(`ClawHub search HTTP ${res.status} ${res.statusText}: ${bodyText.slice(0, 200)}`);
      }

      // 先拿文本再解析，便于诊断非 JSON 响应（如 HTML 错误页）
      const text = await res.text();
      let data: { results?: ClawHubSkillSearchResult[] };
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        throw new Error(`ClawHub search returned non-JSON response (first 300 chars): ${text.slice(0, 300)}`);
      }

      const results = data.results ?? [];
      process.stdout.write(`[Marketplace] searchRemote("${query}", limit=${limit}) → ${results.length} results from ${url.host}\n`);
      return results;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Search the catalog */
  search(query: SearchQuery): SearchResult {
    let results = [...this.catalog];

    // Text search
    if (query.query) {
      const q = query.query.toLowerCase();
      results = results.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.displayName.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)) ||
          p.capabilities.some((c) => c.toLowerCase().includes(q))
      );
    }

    // Capability filter
    if (query.capabilities?.length) {
      results = results.filter((p) =>
        query.capabilities!.every((cap) => p.capabilities.includes(cap))
      );
    }

    // Tag filter
    if (query.tags?.length) {
      results = results.filter((p) =>
        query.tags!.some((tag) => p.tags.includes(tag))
      );
    }

    // Author filter
    if (query.author) {
      results = results.filter((p) =>
        p.author.name.toLowerCase().includes(query.author!.toLowerCase())
      );
    }

    // Rating filter
    if (query.minRating !== undefined) {
      results = results.filter((p) => p.rating >= query.minRating!);
    }

    // Verified only
    if (query.verifiedOnly) {
      results = results.filter((p) => p.verified);
    }

    // Sort
    const order = query.order ?? "desc";
    const multiplier = order === "desc" ? -1 : 1;
    switch (query.sort ?? "relevance") {
      case "downloads":
        results.sort((a, b) => multiplier * (a.downloads - b.downloads));
        break;
      case "rating":
        results.sort((a, b) => multiplier * (a.rating - b.rating));
        break;
      case "updated":
        results.sort((a, b) => multiplier * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()));
        break;
      case "name":
        results.sort((a, b) => multiplier * a.name.localeCompare(b.name));
        break;
      default: // relevance: keep original order
        break;
    }

    const total = results.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 20;

    return {
      packages: results.slice(offset, offset + limit),
      total,
      query,
    };
  }

  /** Get a single package by name from local catalog */
  getPackage(name: string): SkillPackage | undefined {
    return this.catalog.find((p) => p.name === name);
  }

  /**
   * Fetch a single skill's details from the ClawHub registry API.
   * 使用 openclaw 兼容的 GET /api/v1/skills/{slug} 端点。
   */
  async fetchPackageDetails(name: string): Promise<SkillPackage | null> {
    try {
      const url = new URL(`${this.config.registryURL}/api/v1/skills/${encodeURIComponent(name)}`);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json() as ClawHubSkillDetail;
      if (!data.skill) return null;
      const pkg: SkillPackage = {
        name: data.skill.slug,
        displayName: data.skill.displayName,
        version: data.latestVersion?.version ?? "0.0.0",
        description: data.skill.summary ?? "",
        author: { name: data.owner?.handle ?? "unknown" },
        license: "MIT-0",
        capabilities: [],
        tags: Object.keys(data.skill.tags ?? {}),
        evoclawVersion: ">=0.4.0",
        dependencies: {},
        downloadURL: "",
        publishedAt: new Date(data.skill.createdAt).toISOString(),
        updatedAt: new Date(data.skill.updatedAt).toISOString(),
        downloads: 0,
        rating: 0,
        reviewCount: 0,
        verified: false,
      };
      // Update local catalog entry if present
      const idx = this.catalog.findIndex((p) => p.name === name);
      if (idx >= 0) {
        this.catalog[idx] = pkg;
      } else {
        this.catalog.push(pkg);
      }
      return pkg;
    } catch (err) {
      process.stderr.write(`[Marketplace] Failed to fetch package details for "${name}": ${err}\n`);
      // Fall back to local catalog
      return this.getPackage(name) ?? null;
    }
  }

  /**
   * 解析技能安装来源 — 使用 openclaw 兼容的 GET /api/v1/skills/{slug}/install 端点。
   * 返回 archive（ZIP 直链）或 github（仓库+commit）两种安装方式。
   */
  async resolveInstall(slug: string, forceInstall = false): Promise<ClawHubSkillInstallResolution> {
    const url = new URL(`${this.config.registryURL}/api/v1/skills/${encodeURIComponent(slug)}/install`);
    if (forceInstall) url.searchParams.set("forceInstall", "1");
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });
    const data = await res.json() as ClawHubSkillInstallResolution;
    if (!res.ok && !data.ok) {
      throw new Error(`ClawHub install resolution failed: HTTP ${res.status} — ${data.message ?? data.reason ?? ""}`);
    }
    return data;
  }

  // ── Install / Update ────────────────────────────────────

  /** Install a skill package from the marketplace */
  async install(name: string, version?: string): Promise<InstallResult> {
    const pkg = this.getPackage(name);
    if (!pkg) {
      return { success: false, packageName: name, version: version ?? "latest", error: "Package not found in catalog" };
    }

    const targetVersion = version && !version.startsWith("__depth_") ? version : pkg.version;

    // Check if already installed
    const installed = this.installed.get(name);
    if (installed && installed.version === targetVersion) {
      return { success: true, packageName: name, version: targetVersion, installedPath: path.join(this.config.cacheDir, "installed", name) };
    }

    try {
      // Install dependencies first (with depth limit to prevent infinite recursion)
      const depResults: InstallResult[] = [];
      const depthRaw = version?.startsWith("__depth_") ? parseInt(version.split("_").pop() || "0", 10) : 0;
      const maxDepth = Number.isNaN(depthRaw) ? 0 : depthRaw;

      for (const [depName, depVersion] of Object.entries(pkg.dependencies)) {
        if (!this.installed.has(depName)) {
          if (maxDepth >= 3) {
            return {
              success: false,
              packageName: name,
              version: targetVersion,
              error: `Dependency depth limit exceeded: ${depName}`,
              dependencies: depResults,
            };
          }
          const depthVersion = `__depth_${maxDepth + 1}`;
          const depResult = await this.install(depName, depthVersion);
          depResults.push(depResult);
          if (!depResult.success) {
            return {
              success: false,
              packageName: name,
              version: targetVersion,
              error: `Dependency install failed: ${depName}`,
              dependencies: depResults,
            };
          }
        }
      }

      // Download package
      const response = await fetch(pkg.downloadURL);
      if (!response.ok) {
        return { success: false, packageName: name, version: targetVersion, error: `Download failed: HTTP ${response.status}` };
      }

      const data = await response.arrayBuffer();

      // Verify checksum if provided
      if (pkg.checksum) {
        const crypto = await import("crypto");
        const hash = crypto.createHash("sha256").update(Buffer.from(data)).digest("hex");
        if (hash !== pkg.checksum) {
          return { success: false, packageName: name, version: targetVersion, error: `Checksum verification failed: expected ${pkg.checksum}, got ${hash}` };
        }
      }

      // Write to disk
      const fs = await import("fs");
      const path = await import("path");
      const skillDir = path.join(this.config.cacheDir, "skills", name);
      if (!fs.existsSync(skillDir)) {
        fs.mkdirSync(skillDir, { recursive: true });
      }

      const zipPath = path.join(skillDir, `${name}-${targetVersion}.zip`);
      fs.writeFileSync(zipPath, Buffer.from(data));

      // Extract ZIP
      const extractDir = path.join(this.config.cacheDir, "installed", name);
      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
      }
      fs.mkdirSync(extractDir, { recursive: true });

      try {
        const AdmZip = await import("adm-zip");
        const zip = new AdmZip.default(zipPath);
        zip.extractAllTo(extractDir, true);
      } catch (extractErr) {
        process.stderr.write(`[SkillMarketplace] ZIP extraction failed for ${name}: ${extractErr instanceof Error ? extractErr.message : String(extractErr)}\n`);
      }

      // Find SKILL.md in extracted directory
      let skillMdPath: string | null = null;
      const findSkillMd = (dir: string): string | null => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isFile() && entry.name === "SKILL.md") return fullPath;
          if (entry.isDirectory()) {
            const found = findSkillMd(fullPath);
            if (found) return found;
          }
        }
        return null;
      };

      skillMdPath = findSkillMd(extractDir);

      // Register with SkillManager if available
      if (this.skillManager && skillMdPath) {
        try {
          await this.skillManager.installSkill(skillMdPath);
        } catch (regErr) {
          process.stderr.write(`[SkillMarketplace] SkillManager registration failed for ${name}: ${regErr instanceof Error ? regErr.message : String(regErr)}\n`);
        }
      }

      // Store in installed registry
      this.installed.set(name, pkg);

      this.eventBus.publish("marketplace:installed", {
        package: pkg,
        version: targetVersion,
        dependencies: depResults,
        installedPath: skillMdPath || extractDir,
      }, "skill-marketplace");

      return {
        success: true,
        packageName: name,
        version: targetVersion,
        installedPath: skillMdPath || extractDir,
        dependencies: depResults.length > 0 ? depResults : undefined,
      };
    } catch (err) {
      return {
        success: false,
        packageName: name,
        version: targetVersion,
        error: (err as Error).message,
      };
    }
  }

  /** Check for available updates to installed packages */
  async checkForUpdates(): Promise<Array<{ name: string; current: string; latest: string }>> {
    await this.refreshCatalog();

    const updates: Array<{ name: string; current: string; latest: string }> = [];
    for (const [name, installed] of this.installed) {
      const catalogPkg = this.getPackage(name);
      if (catalogPkg && this.compareVersions(catalogPkg.version, installed.version) > 0) {
        updates.push({ name, current: installed.version, latest: catalogPkg.version });
      }
    }

    return updates;
  }

  // ── Publish ─────────────────────────────────────────────

  /** Prepare a skill package for publishing */
  async preparePublish(
    name: string,
    info: {
      displayName: string;
      description: string;
      author: SkillPackage["author"];
      capabilities: string[];
      tags?: string[];
      license?: string;
      dependencies?: Record<string, string>;
    }
  ): Promise<SkillPackage> {
    const pkg: SkillPackage = {
      name,
      displayName: info.displayName,
      version: "0.1.0",
      description: info.description,
      author: info.author,
      license: info.license ?? "MIT",
      capabilities: info.capabilities,
      tags: info.tags ?? [],
      evoclawVersion: ">=0.4.0",
      dependencies: info.dependencies ?? {},
      downloadURL: "",
      publishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloads: 0,
      rating: 0,
      reviewCount: 0,
      verified: false,
    };

    return pkg;
  }

  // ── Ratings & Reviews ───────────────────────────────────

  /**
   * Submit a review for a package.
   * 注意：ClawHub 当前公开 API 不支持 review 提交，此方法仅做本地缓存。
   * 待 ClawHub 开放 review 端点后对接。
   */
  async submitReview(
    packageName: string,
    review: Omit<SkillReview, "id" | "createdAt" | "helpful">
  ): Promise<SkillReview> {
    const fullReview: SkillReview = {
      id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ...review,
      createdAt: new Date().toISOString(),
      helpful: 0,
    };

    // Update local cache only（ClawHub 公开 API 暂不支持 review 提交）
    const pkg = this.getPackage(packageName);
    if (pkg) {
      pkg.reviewCount++;
      const newRating = (pkg.rating * (pkg.reviewCount - 1) + review.rating) / pkg.reviewCount;
      pkg.rating = Math.round(newRating * 10) / 10;
    }

    return fullReview;
  }

  /**
   * Get reviews for a package.
   * ClawHub 公开 API 暂不返回 reviews，直接返回空列表。
   */
  async getReviews(_packageName: string): Promise<SkillReview[]> {
    return [];
  }

  // ── Trending & Discovery ────────────────────────────────

  /** Get trending packages */
  getTrending(limit = 10): SkillPackage[] {
    return [...this.catalog]
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, limit);
  }

  /** Get available categories from the catalog */
  getCategories(): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>();
    for (const pkg of this.catalog) {
      for (const tag of pkg.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** Get newly added packages */
  getNew(limit = 10): SkillPackage[] {
    return [...this.catalog]
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, limit);
  }

  /** Get top rated packages */
  getTopRated(limit = 10, minReviews = 3): SkillPackage[] {
    return [...this.catalog]
      .filter((p) => p.reviewCount >= minReviews)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit);
  }

  /** Get recommended packages based on installed capabilities */
  getRecommendations(limit = 5): SkillPackage[] {
    const installedCaps = new Set<string>();
    for (const pkg of this.installed.values()) {
      for (const cap of pkg.capabilities) {
        installedCaps.add(cap);
      }
    }

    if (installedCaps.size === 0) return this.getTrending(limit);

    // Score packages by capability overlap with installed ones
    const scored = this.catalog
      .filter((p) => !this.installed.has(p.name))
      .map((p) => {
        const overlap = p.capabilities.filter((c) => installedCaps.has(c)).length;
        const score = overlap * 2 + p.rating * 0.5 + Math.log(p.downloads + 1) * 0.3;
        return { pkg: p, score };
      });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.pkg);
  }

  // ── Stats ───────────────────────────────────────────────

  getStats() {
    return {
      catalogSize: this.catalog.length,
      installedCount: this.installed.size,
      catalogAge: Date.now() - this.catalogTimestamp,
      topCapabilities: this.getTopCapabilities(10),
    };
  }

  /** Get most common capabilities in the catalog */
  private getTopCapabilities(limit: number): Array<{ capability: string; count: number }> {
    const counts = new Map<string, number>();
    for (const pkg of this.catalog) {
      for (const cap of pkg.capabilities) {
        counts.set(cap, (counts.get(cap) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([capability, count]) => ({ capability, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  // ── Utilities ───────────────────────────────────────────

  /** Semantic version comparison: returns >0 if v1 > v2 */
  compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split(".").map(Number);
    const parts2 = v2.split(".").map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const a = parts1[i] ?? 0;
      const b = parts2[i] ?? 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }

    return 0;
  }

  /** Get installed packages */
  getInstalled(): SkillPackage[] {
    return Array.from(this.installed.values());
  }

  /** Check if a package is installed */
  isInstalled(name: string): boolean {
    return this.installed.has(name);
  }
}