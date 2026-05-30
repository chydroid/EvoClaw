import { describe, it, expect, beforeEach } from "vitest";
import { SkillIndex } from "./skill-index";

describe("SkillIndex", () => {
  let index: SkillIndex;

  beforeEach(() => {
    index = new SkillIndex();
  });

  const makeSkill = (overrides?: {
    id?: string;
    name?: string;
    description?: string;
    body?: { instructions: string };
    category?: string;
    keywords?: string[];
    stats?: {
      invocationCount: number;
      successCount: number;
      failureCount: number;
      lastInvocation: Date | null;
    };
  }) => ({
    id: overrides?.id ?? "skill-1",
    name: overrides?.name ?? "weather-reporter",
    description: overrides?.description ?? "Reports weather for a given location",
    body: overrides?.body ?? { instructions: "Fetch weather data from the API and format the response for the user. Include temperature, humidity, and wind speed." },
    category: overrides?.category ?? "integration",
    keywords: overrides?.keywords ?? ["weather", "forecast", "temperature"],
    stats: overrides?.stats ?? {
      invocationCount: 10,
      successCount: 9,
      failureCount: 1,
      lastInvocation: new Date("2025-01-15"),
    },
  });

  it("indexSkill creates entries with all three levels", () => {
    index.indexSkill(makeSkill());
    const entry = index.getAll()[0];

    expect(entry.level0).toBeDefined();
    expect(entry.level0).toContain("weather-reporter");
    expect(entry.level0.length).toBeLessThanOrEqual(200);

    expect(entry.level1).toBeDefined();
    expect(entry.level1.length).toBeGreaterThan(0);

    expect(entry.level2).toBeDefined();
    expect(entry.level2).toContain("Fetch weather data");
  });

  it("level0 contains name and truncated description", () => {
    index.indexSkill(makeSkill({
      name: "my-skill",
      description: "A very long description that should be truncated",
    }));
    const entry = index.getAll()[0];
    expect(entry.level0).toContain("my-skill");
  });

  it("level1 contains description and truncated instructions", () => {
    index.indexSkill(makeSkill({
      description: "Test description",
      body: { instructions: "A".repeat(1000) },
    }));
    const entry = index.getAll()[0];
    expect(entry.level1).toContain("Test description");
    expect(entry.level1.length).toBeLessThanOrEqual(600);
  });

  it("level2 contains full instructions", () => {
    const longInstructions = "Step 1: Do this. Step 2: Do that. ".repeat(50);
    index.indexSkill(makeSkill({
      body: { instructions: longInstructions },
    }));
    const entry = index.getAll()[0];
    expect(entry.level2).toBe(longInstructions);
  });

  it("getLevel0Index returns compact format", () => {
    index.indexSkill(makeSkill({ id: "s1", name: "weather-reporter", description: "Weather reports" }));
    index.indexSkill(makeSkill({ id: "s2", name: "code-analyzer", description: "Analyzes code" }));

    const level0 = index.getLevel0Index();
    expect(level0).toContain("weather-reporter");
    expect(level0).toContain("code-analyzer");
    expect(level0).toContain("Weather reports");
    expect(level0).toContain("Analyzes code");
  });

  it("getSkillLevel returns correct content for each level", () => {
    const longInstructions = "Step 1: Do this. Step 2: Do that. ".repeat(50);
    index.indexSkill(makeSkill({
      id: "test-skill",
      body: { instructions: longInstructions },
    }));

    expect(index.getSkillLevel("test-skill", 0)).toBeDefined();
    expect(index.getSkillLevel("test-skill", 1)).toBeDefined();
    expect(index.getSkillLevel("test-skill", 2)).toBeDefined();

    const l0 = index.getSkillLevel("test-skill", 0)!;
    const l1 = index.getSkillLevel("test-skill", 1)!;
    const l2 = index.getSkillLevel("test-skill", 2)!;

    expect(l0.length).toBeLessThanOrEqual(l1.length);
    expect(l1.length).toBeLessThanOrEqual(l2.length);
  });

  it("getSkillLevel returns null for non-existent skill", () => {
    expect(index.getSkillLevel("non-existent", 0)).toBeNull();
    expect(index.getSkillLevel("non-existent", 1)).toBeNull();
    expect(index.getSkillLevel("non-existent", 2)).toBeNull();
  });

  it("search finds skills by keyword", () => {
    index.indexSkill(makeSkill({
      id: "s1",
      name: "weather-reporter",
      keywords: ["weather", "forecast"],
    }));
    index.indexSkill(makeSkill({
      id: "s2",
      name: "code-analyzer",
      keywords: ["code", "analysis"],
    }));

    const weatherResults = index.search("weather");
    expect(weatherResults.length).toBeGreaterThan(0);
    expect(weatherResults[0].entry.name).toBe("weather-reporter");

    const codeResults = index.search("code");
    expect(codeResults.length).toBeGreaterThan(0);
    expect(codeResults[0].entry.name).toBe("code-analyzer");
  });

  it("search finds skills by name match", () => {
    index.indexSkill(makeSkill({
      id: "s1",
      name: "weather-reporter",
      keywords: [],
    }));

    const results = index.search("weather-reporter");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].relevanceScore).toBeGreaterThan(0);
    expect(results[0].matchedLevel).toBeGreaterThanOrEqual(0);
  });

  it("search returns empty for no matches", () => {
    index.indexSkill(makeSkill());
    const results = index.search("quantum physics");
    expect(results.length).toBe(0);
  });

  it("search returns empty for short queries", () => {
    index.indexSkill(makeSkill());
    const results = index.search("a");
    expect(results.length).toBe(0);
  });

  it("search respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      index.indexSkill(makeSkill({
        id: `skill-${i}`,
        name: `weather-tool-${i}`,
        keywords: ["weather"],
      }));
    }

    const results = index.search("weather", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("search boosts by use count and success rate", () => {
    index.indexSkill(makeSkill({
      id: "popular",
      name: "popular-skill",
      keywords: ["test"],
      stats: { invocationCount: 100, successCount: 95, failureCount: 5, lastInvocation: new Date() },
    }));
    index.indexSkill(makeSkill({
      id: "unpopular",
      name: "unpopular-skill",
      keywords: ["test"],
      stats: { invocationCount: 2, successCount: 1, failureCount: 1, lastInvocation: new Date() },
    }));

    const results = index.search("test");
    expect(results.length).toBe(2);
    expect(results[0].entry.id).toBe("popular");
  });

  it("updateStats tracks usage", () => {
    index.indexSkill(makeSkill({ id: "stat-skill" }));
    const useCountBefore = index.getAll()[0].useCount;

    index.updateStats("stat-skill", true);
    const after = index.getAll()[0];

    expect(after.useCount).toBe(useCountBefore + 1);
    expect(after.lastUsedAt).not.toBeNull();
  });

  it("updateStats adjusts success rate", () => {
    index.indexSkill(makeSkill({
      id: "rate-skill",
      stats: { invocationCount: 10, successCount: 8, failureCount: 2, lastInvocation: new Date() },
    }));

    index.updateStats("rate-skill", true);
    const entry = index.getAll()[0];
    expect(entry.successRate).toBeCloseTo(9 / 11, 2);

    index.updateStats("rate-skill", false);
    const updated = index.getAll()[0];
    expect(updated.successRate).toBeCloseTo(9 / 12, 2);
  });

  it("updateStats ignores non-existent skill", () => {
    expect(() => index.updateStats("non-existent", true)).not.toThrow();
  });

  it("markValidated sets lastValidatedAt", () => {
    index.indexSkill(makeSkill({ id: "val-skill" }));
    const before = index.getAll()[0];
    expect(before.lastValidatedAt).toBeNull();

    index.markValidated("val-skill", "v2.0.0");
    const after = index.getAll()[0];
    expect(after.lastValidatedAt).not.toBeNull();
    expect(after.apiVersion).toBe("v2.0.0");
  });

  it("markValidated without apiVersion preserves existing version", () => {
    index.indexSkill(makeSkill({ id: "ver-skill" }));
    index.markValidated("ver-skill", "v1.0.0");
    index.markValidated("ver-skill");

    const entry = index.getAll()[0];
    expect(entry.apiVersion).toBe("v1.0.0");
    expect(entry.lastValidatedAt).not.toBeNull();
  });

  it("getStaleSkills returns skills never validated", () => {
    index.indexSkill(makeSkill({ id: "stale-1" }));
    index.indexSkill(makeSkill({ id: "stale-2" }));

    const stale = index.getStaleSkills(30);
    expect(stale.length).toBe(2);
  });

  it("getStaleSkills returns skills validated too long ago", () => {
    index.indexSkill(makeSkill({ id: "old-skill" }));
    index.markValidated("old-skill");

    const entry = index.getAll()[0];
    entry.lastValidatedAt = Date.now() - 100 * 24 * 60 * 60 * 1000;

    const stale = index.getStaleSkills(30);
    expect(stale.length).toBe(1);
    expect(stale[0].id).toBe("old-skill");
  });

  it("getStaleSkills excludes recently validated skills", () => {
    index.indexSkill(makeSkill({ id: "fresh-skill" }));
    index.markValidated("fresh-skill");

    const stale = index.getStaleSkills(30);
    expect(stale.length).toBe(0);
  });

  it("removeSkill deletes entry from index", () => {
    index.indexSkill(makeSkill({ id: "rem-skill" }));
    expect(index.getSize()).toBe(1);

    const removed = index.removeSkill("rem-skill");
    expect(removed).toBe(true);
    expect(index.getSize()).toBe(0);
  });

  it("removeSkill returns false for non-existent skill", () => {
    expect(index.removeSkill("non-existent")).toBe(false);
  });

  it("getSize returns correct count", () => {
    expect(index.getSize()).toBe(0);
    index.indexSkill(makeSkill({ id: "s1" }));
    expect(index.getSize()).toBe(1);
    index.indexSkill(makeSkill({ id: "s2" }));
    expect(index.getSize()).toBe(2);
  });
});
