import { describe, it, expect, beforeEach, vi, afterEach, afterAll } from "vitest";
import { SkillMarketplace } from "./marketplace";
import type { SkillPackage } from "./marketplace";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterAll(() => {
  vi.unstubAllGlobals();
});

function createMockEventBus() {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  } as any;
}

function makePackage(overrides: Partial<SkillPackage> = {}): SkillPackage {
  return {
    name: "test-skill",
    displayName: "Test Skill",
    version: "1.0.0",
    description: "A test skill",
    author: { name: "Test Author" },
    capabilities: ["search", "fetch"],
    tags: ["testing", "utility"],
    evoclawVersion: ">=0.4.0",
    dependencies: {},
    downloadURL: "https://example.com/test-skill",
    checksum: "",
    publishedAt: "2024-01-15T00:00:00Z",
    updatedAt: "2024-06-01T00:00:00Z",
    downloads: 1000,
    rating: 4.5,
    reviewCount: 50,
    verified: true,
    ...overrides,
  };
}

/** 构造 ClawHub /api/v1/search 响应：返回 { results: [...] }，提供 text() 和 json() */
function mockClawHubSearchResponse(packages: SkillPackage[]) {
  const results = packages.map((p) => ({
    score: 1.0,
    slug: p.name,
    displayName: p.displayName,
    summary: p.description,
    version: p.version,
    updatedAt: new Date(p.updatedAt).getTime(),
    metaContent: {
      Keywords: p.tags,
      License: p.license ?? "MIT-0",
      DisplayDescription: p.description,
      displayName: p.displayName,
      owner: p.author.name,
      latest: { version: p.version, publishedAt: new Date(p.publishedAt).getTime() },
    },
  }));
  const body = JSON.stringify({ results });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** 构造最小有效 ZIP 文件（含 SKILL.md），用于 install 测试 */
function mockZipDownloadResponse() {
  const zipBytes = createMinimalZipWithSkillMd();
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    arrayBuffer: async () =>
      zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength) as ArrayBuffer,
  };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createMinimalZipWithSkillMd(): Uint8Array {
  const skillMdContent =
    "---\nname: test-skill\nversion: 1.0.0\ndescription: A test skill\n---\n# Test Skill\n\nThis is a test skill for unit testing.\n";
  const encoder = new TextEncoder();
  const fileData = encoder.encode(skillMdContent);
  const fileName = encoder.encode("SKILL.md");
  const crc = crc32(fileData);

  // Local file header
  const localHeader = new Uint8Array(30 + fileName.length);
  const lhView = new DataView(localHeader.buffer);
  lhView.setUint32(0, 0x04034b50, true);
  lhView.setUint16(4, 20, true);
  lhView.setUint16(6, 0, true);
  lhView.setUint16(8, 0, true);
  lhView.setUint16(10, 0, true);
  lhView.setUint16(12, 0x0021, true);
  lhView.setUint32(14, crc, true);
  lhView.setUint32(18, fileData.length, true);
  lhView.setUint32(22, fileData.length, true);
  lhView.setUint16(26, fileName.length, true);
  lhView.setUint16(28, 0, true);
  localHeader.set(fileName, 30);

  // Central directory header
  const cdHeader = new Uint8Array(46 + fileName.length);
  const cdView = new DataView(cdHeader.buffer);
  cdView.setUint32(0, 0x02014b50, true);
  cdView.setUint16(4, 20, true);
  cdView.setUint16(6, 20, true);
  cdView.setUint16(8, 0, true);
  cdView.setUint16(10, 0, true);
  cdView.setUint16(12, 0x0021, true);
  cdView.setUint16(14, 0, true);
  cdView.setUint32(16, crc, true);
  cdView.setUint32(20, fileData.length, true);
  cdView.setUint32(24, fileData.length, true);
  cdView.setUint16(28, fileName.length, true);
  cdView.setUint16(30, 0, true);
  cdView.setUint16(32, 0, true);
  cdView.setUint16(34, 0, true);
  cdView.setUint16(36, 0, true);
  cdView.setUint32(38, 0, true);
  cdView.setUint32(42, 0, true);
  cdHeader.set(fileName, 46);

  // EOCD
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, cdHeader.length, true);
  eocdView.setUint32(16, localHeader.length + fileData.length, true);
  eocdView.setUint16(20, 0, true);

  const total = localHeader.length + fileData.length + cdHeader.length + eocd.length;
  const result = new Uint8Array(total);
  let offset = 0;
  result.set(localHeader, offset);
  offset += localHeader.length;
  result.set(fileData, offset);
  offset += fileData.length;
  result.set(cdHeader, offset);
  offset += cdHeader.length;
  result.set(eocd, offset);
  return result;
}

/** 直接注入 catalog（用于不依赖 fetch 的本地搜索/排序/发现测试） */
function injectCatalog(mp: SkillMarketplace, packages: SkillPackage[]): void {
  (mp as unknown as { catalog: SkillPackage[] }).catalog = [...packages];
  (mp as unknown as { catalogTimestamp: number }).catalogTimestamp = Date.now();
}

describe("SkillMarketplace", () => {
  let marketplace: SkillMarketplace;
  let eventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    mockFetch.mockReset();
    eventBus = createMockEventBus();
    marketplace = new SkillMarketplace(eventBus, {
      registryURL: "https://test-registry.example.com",
      maxConcurrentDownloads: 2,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("catalog refresh", () => {
    it("should fetch and populate catalog via ClawHub search API", async () => {
      const packages = [
        makePackage({ name: "pkg-a" }),
        makePackage({ name: "pkg-b", description: "Package B" }),
      ];
      mockFetch.mockResolvedValueOnce(mockClawHubSearchResponse(packages));
      const count = await marketplace.refreshCatalog();
      expect(count).toBe(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://test-registry.example.com/api/v1/search?q=*&limit=100",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
    });

    it("should publish catalog-refreshed event", async () => {
      mockFetch.mockResolvedValueOnce(mockClawHubSearchResponse([makePackage()]));
      await marketplace.refreshCatalog();
      expect(eventBus.publish).toHaveBeenCalledWith(
        "marketplace:catalog-refreshed",
        expect.objectContaining({ count: 1 }),
        "skill-marketplace",
      );
    });

    it("should return -1 on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));
      const count = await marketplace.refreshCatalog();
      expect(count).toBe(-1);
    });
  });

  describe("search", () => {
    beforeEach(() => {
      injectCatalog(marketplace, [
        makePackage({ name: "web-search", description: "Web search tool", tags: ["search", "web"], downloads: 500 }),
        makePackage({ name: "pdf-reader", description: "PDF parsing tool", tags: ["document", "pdf"], downloads: 200 }),
        makePackage({ name: "image-gen", description: "Image generation", tags: ["image", "ai"], downloads: 800 }),
        makePackage({
          name: "web-scraper",
          description: "Web scraping utility",
          capabilities: ["scrape"],
          tags: ["web", "scrape"],
          downloads: 300,
        }),
      ]);
    });

    it("should search by query text", () => {
      const result = marketplace.search({ query: "web" });
      expect(result.packages.length).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it("should search by tag", () => {
      const result = marketplace.search({ tags: ["document"] });
      expect(result.total).toBe(1);
      expect(result.packages[0].name).toBe("pdf-reader");
    });

    it("should search by capability", () => {
      const result = marketplace.search({ capabilities: ["scrape"] });
      expect(result.total).toBe(1);
      expect(result.packages[0].name).toBe("web-scraper");
    });

    it("should filter by minimum rating", () => {
      const result = marketplace.search({ minRating: 4.6 });
      expect(result.total).toBe(0);
    });

    it("should filter verified only", () => {
      const result = marketplace.search({ verifiedOnly: true });
      expect(result.total).toBe(4);
    });

    it("should sort by downloads", () => {
      const result = marketplace.search({ sort: "downloads", order: "desc" });
      expect(result.packages[0].name).toBe("image-gen");
    });

    it("should sort by name", () => {
      const result = marketplace.search({ sort: "name", order: "asc" });
      expect(result.packages[0].name).toBe("image-gen");
    });

    it("should paginate results", () => {
      const result = marketplace.search({ limit: 2, offset: 0 });
      expect(result.packages).toHaveLength(2);
    });
  });

  describe("getPackage", () => {
    it("should find package by name", async () => {
      mockFetch.mockResolvedValueOnce(mockClawHubSearchResponse([makePackage({ name: "my-skill" })]));
      await marketplace.refreshCatalog();
      const pkg = marketplace.getPackage("my-skill");
      expect(pkg).toBeDefined();
      expect(pkg!.name).toBe("my-skill");
    });

    it("should return undefined for unknown package", () => {
      const pkg = marketplace.getPackage("nonexistent");
      expect(pkg).toBeUndefined();
    });
  });

  describe("install", () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(
        mockClawHubSearchResponse([
          makePackage({ name: "my-pkg", version: "1.2.3", downloadURL: "https://example.com/download", checksum: "" }),
        ]),
      );
      await marketplace.refreshCatalog();
    });

    it("should install a package successfully", async () => {
      mockFetch.mockResolvedValueOnce(mockZipDownloadResponse());
      const result = await marketplace.install("my-pkg");
      expect(result.success).toBe(true);
      expect(result.packageName).toBe("my-pkg");
      expect(result.version).toBe("1.2.3");
    });

    it("should publish installed event", async () => {
      mockFetch.mockResolvedValueOnce(mockZipDownloadResponse());
      await marketplace.install("my-pkg");
      expect(eventBus.publish).toHaveBeenCalledWith(
        "marketplace:installed",
        expect.objectContaining({ version: "1.2.3" }),
        "skill-marketplace",
      );
    });

    it("should return error for unknown package", async () => {
      // fetchPackageDetails 会调用 fetch，模拟 404 让其回退到 catalog（找不到）
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => null,
        text: async () => "",
      });
      const result = await marketplace.install("unknown-pkg");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should return error on download failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Download failed"));
      const result = await marketplace.install("my-pkg");
      expect(result.success).toBe(false);
    });
  });

  describe("dependency resolution", () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(
        mockClawHubSearchResponse([
          makePackage({
            name: "main-pkg",
            version: "1.0.0",
            downloadURL: "https://example.com/main",
            dependencies: { "dep-pkg": "0.5.0" },
          }),
          makePackage({ name: "dep-pkg", version: "0.5.0", downloadURL: "https://example.com/dep", dependencies: {} }),
        ]),
      );
      await marketplace.refreshCatalog();
    });

    it("should install dependencies before main package", async () => {
      mockFetch.mockResolvedValueOnce(mockZipDownloadResponse());
      mockFetch.mockResolvedValueOnce(mockZipDownloadResponse());
      const result = await marketplace.install("main-pkg");
      expect(result.success).toBe(true);
    });
  });

  describe("checkForUpdates", () => {
    it("should detect newer versions", async () => {
      const oldPkg = makePackage({ name: "old-pkg", version: "1.0.0", downloadURL: "https://example.com/old" });
      mockFetch.mockResolvedValueOnce(mockClawHubSearchResponse([oldPkg]));
      await marketplace.refreshCatalog();
      mockFetch.mockResolvedValueOnce(mockZipDownloadResponse());
      await marketplace.install("old-pkg");

      const newPkg = makePackage({ name: "old-pkg", version: "2.0.0", downloadURL: "https://example.com/new" });
      mockFetch.mockResolvedValueOnce(mockClawHubSearchResponse([newPkg]));
      const updates = await marketplace.checkForUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0].current).toBe("1.0.0");
      expect(updates[0].latest).toBe("2.0.0");
    });

    it("should return empty when no updates available", async () => {
      const pkg = makePackage({ name: "stable-pkg", version: "1.0.0", downloadURL: "https://example.com/stable" });
      mockFetch.mockResolvedValueOnce(mockClawHubSearchResponse([pkg]));
      await marketplace.refreshCatalog();
      mockFetch.mockResolvedValueOnce(mockZipDownloadResponse());
      await marketplace.install("stable-pkg");

      mockFetch.mockResolvedValueOnce(mockClawHubSearchResponse([pkg]));
      const updates = await marketplace.checkForUpdates();
      expect(updates).toEqual([]);
    });
  });

  describe("preparePublish", () => {
    it("should prepare a package for publishing with defaults", async () => {
      const pkg = await marketplace.preparePublish("new-skill", {
        displayName: "New Skill",
        description: "A new skill",
        author: { name: "Author" },
        capabilities: ["search"],
      });
      expect(pkg.name).toBe("new-skill");
      expect(pkg.version).toBe("0.1.0");
      expect(pkg.license).toBe("MIT");
      expect(pkg.tags).toEqual([]);
    });

    it("should accept custom license and tags", async () => {
      const pkg = await marketplace.preparePublish("new-skill", {
        displayName: "New Skill",
        description: "A new skill",
        author: { name: "Author" },
        capabilities: ["search"],
        license: "Apache-2.0",
        tags: ["ai", "tool"],
      });
      expect(pkg.license).toBe("Apache-2.0");
      expect(pkg.tags).toEqual(["ai", "tool"]);
    });
  });

  describe("reviews", () => {
    beforeEach(() => {
      injectCatalog(marketplace, [makePackage({ name: "reviewed-pkg", rating: 4.0, reviewCount: 2 })]);
    });

    it("should submit a review and update rating", async () => {
      const review = await marketplace.submitReview("reviewed-pkg", {
        packageName: "reviewed-pkg",
        userId: "user1",
        rating: 5,
        title: "Great",
        comment: "Excellent",
      });
      expect(review.id).toBeTruthy();
      expect(review.rating).toBe(5);
      const pkg = marketplace.getPackage("reviewed-pkg")!;
      expect(pkg.reviewCount).toBe(3);
    });

    it("should return empty reviews list (ClawHub public API 不支持)", async () => {
      const reviews = await marketplace.getReviews("reviewed-pkg");
      expect(reviews).toEqual([]);
    });
  });

  describe("discovery", () => {
    beforeEach(() => {
      injectCatalog(marketplace, [
        makePackage({ name: "a", tags: ["tool"], downloads: 100, publishedAt: "2024-01-01T00:00:00Z" }),
        makePackage({ name: "b", tags: ["tool"], downloads: 300, publishedAt: "2024-06-01T00:00:00Z" }),
        makePackage({ name: "c", tags: ["ai"], downloads: 200, publishedAt: "2024-03-01T00:00:00Z" }),
      ]);
    });

    it("getTrending returns top by downloads", () => {
      const trending = marketplace.getTrending(2);
      expect(trending[0].name).toBe("b");
      expect(trending).toHaveLength(2);
    });

    it("getCategories returns tag counts", () => {
      const cats = marketplace.getCategories();
      expect(cats.find((c) => c.name === "tool")?.count).toBe(2);
      expect(cats.find((c) => c.name === "ai")?.count).toBe(1);
    });

    it("getNew sorts by publishedAt desc", () => {
      const news = marketplace.getNew(3);
      expect(news[0].name).toBe("b");
    });

    it("getTopRated filters by minReviews", () => {
      const top = marketplace.getTopRated(10, 100);
      expect(top).toEqual([]);
    });

    it("getRecommendations falls back to trending when no installed", () => {
      const recs = marketplace.getRecommendations(2);
      expect(recs).toHaveLength(2);
    });
  });

  describe("stats", () => {
    it("should return catalog stats", () => {
      injectCatalog(marketplace, [
        makePackage({ name: "a", capabilities: ["search"] }),
        makePackage({ name: "b", capabilities: ["search", "fetch"] }),
      ]);
      const stats = marketplace.getStats();
      expect(stats.catalogSize).toBe(2);
      expect(stats.installedCount).toBe(0);
      expect(stats.topCapabilities.length).toBeGreaterThan(0);
    });
  });

  describe("utilities", () => {
    it("compareVersions should compare semver", () => {
      expect(marketplace.compareVersions("1.0.0", "1.0.0")).toBe(0);
      expect(marketplace.compareVersions("2.0.0", "1.0.0")).toBe(1);
      expect(marketplace.compareVersions("1.0.0", "1.2.0")).toBe(-1);
    });

    it("isInstalled should reflect install state", async () => {
      mockFetch.mockResolvedValueOnce(mockClawHubSearchResponse([makePackage({ name: "x" })]));
      await marketplace.refreshCatalog();
      expect(marketplace.isInstalled("x")).toBe(false);
      mockFetch.mockResolvedValueOnce(mockZipDownloadResponse());
      await marketplace.install("x");
      expect(marketplace.isInstalled("x")).toBe(true);
    });

    it("getInstalled returns installed packages", async () => {
      mockFetch.mockResolvedValueOnce(mockClawHubSearchResponse([makePackage({ name: "y" })]));
      await marketplace.refreshCatalog();
      mockFetch.mockResolvedValueOnce(mockZipDownloadResponse());
      await marketplace.install("y");
      const installed = marketplace.getInstalled();
      expect(installed).toHaveLength(1);
      expect(installed[0].name).toBe("y");
    });
  });
});
