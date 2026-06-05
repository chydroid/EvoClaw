import { describe, it, expect } from "vitest";
import {
  isScraplingAvailable,
  generateAdaptiveScraperScript,
  generateSimpleFetchScript,
  getScraplingInfo,
} from "./scrapling-bridge";

describe("Scrapling Bridge", () => {
  describe("isScraplingAvailable", () => {
    it("should return a boolean", () => {
      const result = isScraplingAvailable();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("getScraplingInfo", () => {
    it("should return a version string or 'not available'", () => {
      const result = getScraplingInfo();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("generateAdaptiveScraperScript", () => {
    it("should generate a valid Python script with default params", () => {
      const script = generateAdaptiveScraperScript({
        url: "https://example.com/novel/",
        outputFile: "novel.txt",
      });
      expect(script).toContain("#!/usr/bin/env python3");
      expect(script).toContain("from scrapling.fetchers import StealthyFetcher");
      expect(script).toContain("ScraplingNovelDownloader");
      expect(script).toContain("https://example.com/novel/");
      expect(script).toContain("novel.txt");
    });

    it("should include custom selectors when provided", () => {
      const script = generateAdaptiveScraperScript({
        url: "https://example.com/novel/",
        outputFile: "novel.txt",
        titleSelector: ".chapter-title",
        contentSelector: "#chapter-content",
        nextLinkSelector: ".next-chapter",
        startChapter: 2000,
        maxChapters: 100,
        encoding: "gbk",
        delay: 2,
      });
      expect(script).toContain(".chapter-title");
      expect(script).toContain("#chapter-content");
      expect(script).toContain(".next-chapter");
      expect(script).toContain("2000");
      expect(script).toContain("100");
      expect(script).toContain("gbk");
      // Delay is stored as a Python variable (number)
      expect(script).toContain("DELAY = 2");
    });

    it("should generate a checkpoint-saving mechanism", () => {
      const script = generateAdaptiveScraperScript({
        url: "https://example.com/novel/",
        outputFile: "out.txt",
      });
      expect(script).toContain("checkpoint");
      expect(script).toContain("save_checkpoint");
      expect(script).toContain("load_checkpoint");
      expect(script).toContain(".checkpoint.json");
    });

    it("should include multi-strategy next-link finding", () => {
      const script = generateAdaptiveScraperScript({
        url: "https://example.com/novel/",
        outputFile: "out.txt",
      });
      expect(script).toContain("find_next_link");
      expect(script).toContain("下一章");
      expect(script).toContain("rel=\"next\"");
    });

    it("should use adaptive scraping with auto_save", () => {
      const script = generateAdaptiveScraperScript({
        url: "https://example.com/novel/",
        outputFile: "out.txt",
      });
      expect(script).toContain("auto_save=True");
      expect(script).toContain("adaptive=True");
    });
  });

  describe("generateSimpleFetchScript", () => {
    it("should generate a simple fetch script", () => {
      const script = generateSimpleFetchScript("https://example.com");
      expect(script).toContain("#!/usr/bin/env python3");
      expect(script).toContain("from scrapling.fetchers import StealthyFetcher");
      expect(script).toContain("https://example.com");
    });

    it("should include link extraction when requested", () => {
      const script = generateSimpleFetchScript("https://example.com", {
        extractLinks: true,
      });
      expect(script).toContain("a[href]");
      expect(script).toContain("links");
    });

    it("should include text extraction when requested", () => {
      const script = generateSimpleFetchScript("https://example.com", {
        extractText: true,
      });
      expect(script).toContain("text_content");
    });

    it("should support non-headless mode", () => {
      const script = generateSimpleFetchScript("https://example.com", {
        headless: false,
      });
      expect(script).toContain("headless=False");
    });
  });
});