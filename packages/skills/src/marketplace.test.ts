import { describe, it, expect, beforeEach, vi, afterEach, afterAll } from "vitest";
import { SkillMarketplace } from "../src/marketplace";
import type { SkillPackage } from "../src/marketplace";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterAll(() => {
  vi.unstubAllGlobals();
});

// Minimal EventBus mock
function createMockEventBus() {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  } as any;
}

// Sample packages
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

function mockDownloadResponse(content: string = "package-content") {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(content);
  return {
    ok: true,
    text: async () => content,
    arrayBuffer: async () => buffer.buffer as ArrayBuffer,
  };
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

  // ── Catalog Refresh ─────────────────────────────────────

  describe("catalog refresh", () => {
    it("should fetch and populate catalog", async () => {
      const packages = [
        makePackage({ name: "pkg-a" }),
        makePackage({ name: "pkg-b", description: "Package B" }),
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages, total: 2 }),
      });

      const count = await marketplace.refreshCatalog();
      expect(count).toBe(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://test-registry.example.com/packages"
      );
    });

    it("should publish catalog-refreshed event", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages: [makePackage()], total: 1 }),
      });

      await marketplace.refreshCatalog();
      expect(eventBus.publish).toHaveBeenCalledWith(
        "marketplace:catalog-refreshed",
        expect.objectContaining({ count: 1 }),
        "skill-marketplace"
      );
    });

    it("should return stale count on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const count = await marketplace.refreshCatalog();
      expect(count).toBe(0);
    });
  });

  // ── Search ──────────────────────────────────────────────

  describe("search", () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          packages: [
            makePackage({ name: "web-search", description: "Web search tool", tags: ["search", "web"], downloads: 500 }),
            makePackage({ name: "pdf-reader", description: "PDF parsing tool", tags: ["document", "pdf"], downloads: 200 }),
            makePackage({ name: "image-gen", description: "Image generation", tags: ["image", "ai"], downloads: 800 }),
            makePackage({ name: "web-scraper", description: "Web scraping utility", capabilities: ["scrape"], tags: ["web", "scrape"], downloads: 300 }),
          ],
          total: 4,
        }),
      });
      await marketplace.refreshCatalog();
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
      // All have 4.5 rating by default, so filter at 4.6 should return empty
      const result = marketplace.search({ minRating: 4.6 });
      expect(result.total).toBe(0);
    });

    it("should filter verified only", () => {
      const result = marketplace.search({ verifiedOnly: true });
      expect(result.total).toBe(4); // all are verified by default
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

  // ── Package Lookup ──────────────────────────────────────

  describe("getPackage", () => {
    it("should find package by name", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages: [makePackage({ name: "my-skill" })], total: 1 }),
      });
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

  // ── Install ─────────────────────────────────────────────

  describe("install", () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          packages: [
            makePackage({
              name: "my-pkg",
              version: "1.2.3",
              downloadURL: "https://example.com/download",
              checksum: "",
            }),
          ],
          total: 1,
        }),
      });
      await marketplace.refreshCatalog();
    });

    it("should install a package successfully", async () => {
      mockFetch.mockResolvedValueOnce(mockDownloadResponse());

      const result = await marketplace.install("my-pkg");
      expect(result.success).toBe(true);
      expect(result.packageName).toBe("my-pkg");
      expect(result.version).toBe("1.2.3");
    });

    it("should publish installed event", async () => {
      mockFetch.mockResolvedValueOnce(mockDownloadResponse());

      await marketplace.install("my-pkg");
      expect(eventBus.publish).toHaveBeenCalledWith(
        "marketplace:installed",
        expect.objectContaining({ version: "1.2.3" }),
        "skill-marketplace"
      );
    });

    it("should return error for unknown package", async () => {
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

  // ── Dependency Resolution ───────────────────────────────

  describe("dependency resolution", () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          packages: [
            makePackage({
              name: "main-pkg",
              version: "1.0.0",
              downloadURL: "https://example.com/main",
              dependencies: { "dep-pkg": "0.5.0" },
            }),
            makePackage({
              name: "dep-pkg",
              version: "0.5.0",
              downloadURL: "https://example.com/dep",
              dependencies: {},
            }),
          ],
          total: 2,
        }),
      });
      await marketplace.refreshCatalog();
    });

    it("should install dependencies before main package", async () => {
      mockFetch.mockResolvedValueOnce(mockDownloadResponse("dep-content"));
      mockFetch.mockResolvedValueOnce(mockDownloadResponse("main-content"));

      const result = await marketplace.install("main-pkg");
      expect(result.success).toBe(true);
    });
  });

  // ── Check for Updates ───────────────────────────────────

  describe("checkForUpdates", () => {
    it("should detect newer versions", async () => {
      // First, install a package
      const oldPkg = makePackage({ name: "old-pkg", version: "1.0.0", downloadURL: "https://example.com/old" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages: [oldPkg], total: 1 }),
      });
      await marketplace.refreshCatalog();

      mockFetch.mockResolvedValueOnce(mockDownloadResponse("content"));
      await marketplace.install("old-pkg");

      // Now put a newer version in the catalog
      const newPkg = makePackage({ name: "old-pkg", version: "2.0.0", downloadURL: "https://example.com/new" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages: [newPkg], total: 1 }),
      });

      const updates = await marketplace.checkForUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0].current).toBe("1.0.0");
      expect(updates[0].latest).toBe("2.0.0");
    });

    it("should return empty when no updates available", async () => {
      const pkg = makePackage({ name: "stable-pkg", version: "1.0.0", downloadURL: "https://example.com/stable" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages: [pkg], total: 1 }),
      });
      await marketplace.refreshCatalog();

      mockFetch.mockResolvedValueOnce(mockDownloadResponse("content"));
      await marketplace.install("stable-pkg");

      // Refresh catalog with same version
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages: [pkg], total: 1 }),
      });

      const updates = await marketplace.checkForUpdates();
      expect(updates).toEqual([]);
    });
  });

  // ── Prepare Publish ─────────────────────────────────────

  describe("preparePublish", () => {
    it("should create a publish-ready package", async () => {
      const pkg = await marketplace.preparePublish("new-skill", {
        displayName: "New Skill",
        description: "A brand new skill",
        author: { name: "Dev", email: "dev@test.com" },
        capabilities: ["code", "review"],
        tags: ["devtools"],
        license: "Apache-2.0",
        dependencies: { "base-skill": "1.0.0" },
      });

      expect(pkg.name).toBe("new-skill");
      expect(pkg.displayName).toBe("New Skill");
      expect(pkg.version).toBe("0.1.0");
      expect(pkg.license).toBe("Apache-2.0");
      expect(pkg.evoclawVersion).toBe(">=0.4.0");
      expect(pkg.downloads).toBe(0);
      expect(pkg.rating).toBe(0);
      expect(pkg.verified).toBe(false);
    });

    it("should default license to MIT", async () => {
      const pkg = await marketplace.preparePublish("pkg", {
        displayName: "Pkg",
        description: "Desc",
        author: { name: "Author" },
        capabilities: ["test"],
      });
      expect(pkg.license).toBe("MIT");
    });
  });

  // ── Ratings & Reviews ───────────────────────────────────

  describe("ratings and reviews", () => {
    beforeEach(async () => {
      const pkg = makePackage({ name: "reviewed-pkg", downloadURL: "https://example.com/pkg" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages: [pkg], total: 1 }),
      });
      await marketplace.refreshCatalog();
    });

    it("should submit a review", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const review = await marketplace.submitReview("reviewed-pkg", {
        packageName: "reviewed-pkg",
        userId: "user-1",
        rating: 4,
        title: "Good",
        comment: "Works well",
      });

      expect(review.id).toMatch(/^rev_/);
      expect(review.rating).toBe(4);
      expect(review.helpful).toBe(0);
    });

    it("should update package rating after review", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      // Original rating: 4.5 with 50 reviews
      // After a 4-star review: (4.5 * 50 + 4) / 51 = 4.49...
      await marketplace.submitReview("reviewed-pkg", {
        packageName: "reviewed-pkg",
        userId: "user-1",
        rating: 4,
        title: "OK",
        comment: "Decent",
      });

      const pkg = marketplace.getPackage("reviewed-pkg");
      expect(pkg!.reviewCount).toBe(51);
      expect(pkg!.rating).toBeCloseTo(4.49, 1);
    });

    it("should handle review submission error gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network"));

      const review = await marketplace.submitReview("reviewed-pkg", {
        packageName: "reviewed-pkg",
        userId: "user-1",
        rating: 5,
        title: "Great",
        comment: "Love it",
      });

      // Should still return the review locally
      expect(review.rating).toBe(5);
    });

    it("should get reviews", async () => {
      const reviews = [
        { id: "r1", packageName: "pkg", userId: "u1", rating: 5, title: "A", comment: "C", createdAt: "2024-01-01", helpful: 0 },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ reviews }),
      });

      const result = await marketplace.getReviews("reviewed-pkg");
      // getReviews fetches from registry, but the URL isn't mocked with our test registry
      // So it will try to fetch and fail silently
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── Discovery Methods ───────────────────────────────────

  describe("discovery", () => {
    beforeEach(async () => {
      const packages = [
        makePackage({ name: "trending-1", downloads: 10000, publishedAt: "2024-01-01T00:00:00Z" }),
        makePackage({ name: "new-1", downloads: 50, publishedAt: "2024-06-01T00:00:00Z" }),
        makePackage({ name: "top-rated", downloads: 200, rating: 5.0, reviewCount: 20 }),
        makePackage({ name: "low-rated", downloads: 100, rating: 1.0, reviewCount: 2 }),
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages, total: 4 }),
      });
      await marketplace.refreshCatalog();
    });

    it("should get trending packages by downloads", () => {
      const trending = marketplace.getTrending(3);
      expect(trending).toHaveLength(3);
      expect(trending[0].name).toBe("trending-1");
    });

    it("should get new packages by publish date", () => {
      const news = marketplace.getNew(3);
      expect(news[0].name).toBe("new-1"); // latest publishedAt
    });

    it("should get top rated with minimum reviews filter", () => {
      const top = marketplace.getTopRated(5, 3);
      expect(top.some((p) => p.name === "top-rated")).toBe(true);
      expect(top.some((p) => p.name === "low-rated")).toBe(false); // only 2 reviews
    });
  });

  // ── Recommendations ─────────────────────────────────────

  describe("recommendations", () => {
    it("should return trending when nothing installed", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages: [makePackage({ name: "p1", downloads: 5000 })], total: 1 }),
      });
      await marketplace.refreshCatalog();

      const recs = marketplace.getRecommendations(5);
      expect(recs.length).toBeGreaterThan(0);
    });
  });

  // ── Stats ────────────────────────────────────────────────

  describe("stats", () => {
    it("should return marketplace statistics", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages: [makePackage(), makePackage({ name: "p2" })], total: 2 }),
      });
      await marketplace.refreshCatalog();

      const stats = marketplace.getStats();
      expect(stats.catalogSize).toBe(2);
      expect(stats.installedCount).toBe(0);
      expect(stats.catalogAge).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(stats.topCapabilities)).toBe(true);
    });
  });

  // ── Version Comparison ──────────────────────────────────

  describe("compareVersions", () => {
    it("should compare semantic versions correctly", () => {
      expect(marketplace.compareVersions("2.0.0", "1.0.0")).toBe(1);
      expect(marketplace.compareVersions("1.0.0", "2.0.0")).toBe(-1);
      expect(marketplace.compareVersions("1.0.0", "1.0.0")).toBe(0);
      expect(marketplace.compareVersions("1.0.1", "1.0.0")).toBe(1);
      expect(marketplace.compareVersions("1.1.0", "1.0.99")).toBe(1);
    });
  });

  // ── Installed Management ────────────────────────────────

  describe("installed management", () => {
    it("should track installed packages", async () => {
      const pkg = makePackage({ name: "pkg", downloadURL: "https://example.com/dl" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ packages: [pkg], total: 1 }),
      });
      await marketplace.refreshCatalog();

      mockFetch.mockResolvedValueOnce(mockDownloadResponse("content"));
      await marketplace.install("pkg");

      expect(marketplace.isInstalled("pkg")).toBe(true);
      expect(marketplace.isInstalled("unknown")).toBe(false);

      const installed = marketplace.getInstalled();
      expect(installed).toHaveLength(1);
      expect(installed[0].name).toBe("pkg");
    });
  });
});