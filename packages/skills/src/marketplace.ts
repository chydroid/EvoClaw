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

import type { EventBus } from "@evoclaw/core";

// ── Types ─────────────────────────────────────────────────

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

  constructor(eventBus: EventBus, config: MarketplaceConfig = {}) {
    this.config = {
      registryURL: config.registryURL ?? "https://clawhub.ai/api/v1",
      cacheDir: config.cacheDir ?? "data/marketplace",
      updateCheckIntervalMs: config.updateCheckIntervalMs ?? 3600_000, // 1 hour
      maxConcurrentDownloads: config.maxConcurrentDownloads ?? 3,
    };
    this.eventBus = eventBus;
  }

  // ── Catalog Operations ──────────────────────────────────

  /** Fetch the latest catalog from the registry */
  async refreshCatalog(): Promise<number> {
    try {
      const res = await fetch(`${this.config.registryURL}/packages`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as { packages: SkillPackage[]; total: number };
      this.catalog = data.packages ?? [];
      this.catalogTimestamp = Date.now();

      this.eventBus.publish("marketplace:catalog-refreshed", {
        count: this.catalog.length,
        timestamp: this.catalogTimestamp,
      }, "skill-marketplace");

      return this.catalog.length;
    } catch (err) {
      console.warn(`[Marketplace] Failed to refresh catalog: ${err}`);
      return this.catalog.length; // return stale count
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

  /** Get a single package by name */
  getPackage(name: string): SkillPackage | undefined {
    return this.catalog.find((p) => p.name === name);
  }

  // ── Install / Update ────────────────────────────────────

  /** Install a skill package from the marketplace */
  async install(name: string, version?: string): Promise<InstallResult> {
    const pkg = this.getPackage(name);
    if (!pkg) {
      return { success: false, packageName: name, version: version ?? "latest", error: "Package not found in catalog" };
    }

    const targetVersion = version ?? pkg.version;

    // Check if already installed
    const installed = this.installed.get(name);
    if (installed && installed.version === targetVersion) {
      return { success: true, packageName: name, version: targetVersion, installedPath: installed.name };
    }

    try {
      // Install dependencies first (with depth limit to prevent infinite recursion)
      const depResults: InstallResult[] = [];
      const maxDepth = (version?.startsWith("__depth_") ? parseInt(version.split("_").pop() || "0") : 0);

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
        const { execFileSync } = await import("child_process");
        if (process.platform === "win32") {
          execFileSync("powershell", ["-Command", "Expand-Archive", "-Path", zipPath, "-DestinationPath", extractDir, "-Force"], { stdio: "pipe" });
        } else {
          execFileSync("unzip", ["-o", zipPath, "-d", extractDir], { stdio: "pipe" });
        }
      } catch (extractErr) {
        return { success: false, packageName: name, version: targetVersion, error: `Extraction failed: ${extractErr}` };
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

  /** Submit a review for a package */
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

    // In production, POST to registry API
    try {
      const res = await fetch(`${this.config.registryURL}/packages/${packageName}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fullReview),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.warn(`[Marketplace] Review submission failed: ${err}`);
    }

    // Update local cache
    const pkg = this.getPackage(packageName);
    if (pkg) {
      pkg.reviewCount++;
      const newRating = (pkg.rating * (pkg.reviewCount - 1) + review.rating) / pkg.reviewCount;
      pkg.rating = Math.round(newRating * 10) / 10;
    }

    return fullReview;
  }

  /** Get reviews for a package */
  async getReviews(packageName: string): Promise<SkillReview[]> {
    try {
      const res = await fetch(`${this.config.registryURL}/packages/${packageName}/reviews`);
      if (res.ok) {
        const data = await res.json() as { reviews: SkillReview[] };
        return data.reviews ?? [];
      }
    } catch {
      // Return empty on error
    }
    return [];
  }

  // ── Trending & Discovery ────────────────────────────────

  /** Get trending packages */
  getTrending(limit = 10): SkillPackage[] {
    return [...this.catalog]
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, limit);
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