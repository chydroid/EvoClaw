import { describe, it, expect, beforeEach } from "vitest";
import { ConstraintGate } from "./constraint-gate";
import type { EvolutionCandidate } from "@evoclaw/core";

describe("ConstraintGate", () => {
  let gate: ConstraintGate;

  beforeEach(() => {
    gate = new ConstraintGate();
  });

  const makeCandidate = (overrides?: Partial<EvolutionCandidate>): EvolutionCandidate => ({
    id: "cand-1",
    type: "new_skill",
    proposedChanges: {
      description: "weather data forecasts processor",
      codeChanges: [],
      configChanges: {},
      skillManifest: {
        provides: [
          {
            name: "weather_forecast",
            description: "Returns weather forecast for a given location",
            schema: { type: "object", properties: { location: { type: "string" } } },
          },
        ],
      },
    },
    codeArtifacts: [
      {
        name: "weather-processor",
        language: "typescript",
        source: "const weather = fetchData(); const data = transform(weather); const forecasts = generate(data); const processor = compile(forecasts);",
        tests: "test('weather forecasts processor', () => { expect(forecasts).toBeDefined(); });",
        dependencies: [],
      },
    ],
    risk: {
      level: "low",
      factors: [],
      mitigation: "Standard testing",
    },
    generatedAt: new Date(),
    ...overrides,
  });

  it("sizeGate passes when artifacts are small", async () => {
    const candidate = makeCandidate();
    const result = await gate.validate(candidate);
    const sizeResult = result.results.find((r) => r.gateName === "size");
    expect(sizeResult!.passed).toBe(true);
  });

  it("sizeGate fails when total exceeds maxSkillSizeBytes", async () => {
    const hugeSource = "x".repeat(20000);
    const hugeTests = "y".repeat(20000);
    const candidate = makeCandidate({
      codeArtifacts: [
        {
          name: "huge-artifact",
          language: "typescript",
          source: hugeSource,
          tests: hugeTests,
          dependencies: [],
        },
      ],
    });
    const result = await gate.validate(candidate);
    const sizeResult = result.results.find((r) => r.gateName === "size");
    expect(sizeResult!.passed).toBe(false);
    expect(sizeResult!.reason).toContain("exceeds maximum");
  });

  it("descriptionGate passes when descriptions are short", async () => {
    const candidate = makeCandidate();
    const result = await gate.validate(candidate);
    const descResult = result.results.find((r) => r.gateName === "description");
    expect(descResult!.passed).toBe(true);
  });

  it("descriptionGate fails when descriptions are too long", async () => {
    const longDescription = "A".repeat(600);
    const candidate = makeCandidate({
      proposedChanges: {
        ...makeCandidate().proposedChanges,
        skillManifest: {
          provides: [
            {
              name: "tool_with_long_desc",
              description: longDescription,
              schema: { type: "object" },
            },
          ],
        },
      },
    });
    const result = await gate.validate(candidate);
    const descResult = result.results.find((r) => r.gateName === "description");
    expect(descResult!.passed).toBe(false);
    expect(descResult!.reason).toContain("exceed maximum");
  });

  it("semanticGate passes when key terms are present", async () => {
    const candidate = makeCandidate({
      proposedChanges: {
        description: "weather data forecast processor",
        codeChanges: [],
        configChanges: {},
      },
      codeArtifacts: [
        {
          name: "weather",
          language: "typescript",
          source: "const weather = getData(); const data = process(weather); const forecast = predict(data); const processor = compile(forecast);",
          tests: "test weather data forecast processor",
          dependencies: [],
        },
      ],
    });
    const result = await gate.validate(candidate);
    const semanticResult = result.results.find((r) => r.gateName === "semantic");
    expect(semanticResult!.passed).toBe(true);
  });

  it("semanticGate fails when similarity is too low", async () => {
    const candidate = makeCandidate({
      proposedChanges: {
        description: "completely unrelated quantum physics simulation",
        codeChanges: [],
        configChanges: {},
      },
      codeArtifacts: [
        {
          name: "weather",
          language: "typescript",
          source: "function processWeatherData(data) { return forecast; }",
          tests: "test weather",
          dependencies: [],
        },
      ],
    });
    const result = await gate.validate(candidate);
    const semanticResult = result.results.find((r) => r.gateName === "semantic");
    expect(semanticResult!.passed).toBe(false);
    expect(semanticResult!.reason).toContain("below threshold");
  });

  it("semanticGate fails when no description is provided", async () => {
    const candidate = makeCandidate({
      proposedChanges: {
        description: "",
        codeChanges: [],
        configChanges: {},
      },
    });
    const result = await gate.validate(candidate);
    const semanticResult = result.results.find((r) => r.gateName === "semantic");
    expect(semanticResult!.passed).toBe(false);
    expect(semanticResult!.reason).toContain("No description");
  });

  it("compatibilityGate passes when interfaces are valid", async () => {
    const candidate = makeCandidate();
    const result = await gate.validate(candidate);
    const compatResult = result.results.find((r) => r.gateName === "compatibility");
    expect(compatResult!.passed).toBe(true);
  });

  it("compatibilityGate fails when capability name is missing", async () => {
    const candidate = makeCandidate({
      proposedChanges: {
        ...makeCandidate().proposedChanges,
        skillManifest: {
          provides: [
            {
              name: "",
              description: "A tool without a name",
              schema: { type: "object" },
            },
          ],
        },
      },
    });
    const result = await gate.validate(candidate);
    const compatResult = result.results.find((r) => r.gateName === "compatibility");
    expect(compatResult!.passed).toBe(false);
    expect(compatResult!.reason).toContain("missing name");
  });

  it("compatibilityGate fails when schema is invalid", async () => {
    const candidate = makeCandidate({
      proposedChanges: {
        ...makeCandidate().proposedChanges,
        skillManifest: {
          provides: [
            {
              name: "bad_schema_tool",
              description: "Tool with invalid schema",
              schema: "not-an-object" as unknown as Record<string, unknown>,
            },
          ],
        },
      },
    });
    const result = await gate.validate(candidate);
    const compatResult = result.results.find((r) => r.gateName === "compatibility");
    expect(compatResult!.passed).toBe(false);
    expect(compatResult!.reason).toContain("invalid schema");
  });

  it("transientFailureGate fails when transient error patterns are encoded as permanent", async () => {
    const candidate = makeCandidate({
      codeArtifacts: [
        {
          name: "retry-handler",
          language: "typescript",
          source: "if (error === 'ETIMEDOUT') { throw new Error('Permanent failure'); }",
          tests: "",
          dependencies: [],
        },
      ],
    });
    const result = await gate.validate(candidate);
    const transientResult = result.results.find((r) => r.gateName === "transient_failure");
    expect(transientResult!.passed).toBe(false);
    expect(transientResult!.reason).toContain("transient failure patterns");
  });

  it("transientFailureGate passes when no transient patterns are present", async () => {
    const candidate = makeCandidate();
    const result = await gate.validate(candidate);
    const transientResult = result.results.find((r) => r.gateName === "transient_failure");
    expect(transientResult!.passed).toBe(true);
  });

  it("validate returns passed=true when all gates pass", async () => {
    const candidate = makeCandidate();
    const result = await gate.validate(candidate);
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(5);
  });

  it("validate returns passed=false when any gate fails", async () => {
    const candidate = makeCandidate({
      proposedChanges: {
        description: "",
        codeChanges: [],
        configChanges: {},
      },
    });
    const result = await gate.validate(candidate);
    expect(result.passed).toBe(false);
  });

  it("custom config overrides defaults", async () => {
    const permissiveGate = new ConstraintGate({
      maxSkillSizeBytes: 100000,
      maxToolDescriptionChars: 1000,
      semanticSimilarityThreshold: 0.3,
    });
    const hugeSource = "x".repeat(20000);
    const candidate = makeCandidate({
      codeArtifacts: [
        {
          name: "big-artifact",
          language: "typescript",
          source: hugeSource,
          tests: "",
          dependencies: [],
        },
      ],
    });
    const result = await permissiveGate.validate(candidate);
    const sizeResult = result.results.find((r) => r.gateName === "size");
    expect(sizeResult!.passed).toBe(true);
  });
});
