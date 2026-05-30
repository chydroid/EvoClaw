import { describe, it, expect, beforeEach } from "vitest";
import { ExternalReflector } from "./external-reflector";
import type { ExecutionTrace } from "./external-reflector";
import { ServiceRegistry, EventBus } from "@evoclaw/core";

describe("ExternalReflector", () => {
  let reflector: ExternalReflector;
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    reflector = new ExternalReflector(registry, eventBus);
  });

  const makeTrace = (overrides?: Partial<ExecutionTrace>): ExecutionTrace => ({
    taskId: "task-1",
    error: undefined,
    steps: [],
    context: {},
    ...overrides,
  });

  it("reflect with transient failure returns shouldEvolve=false", async () => {
    const trace = makeTrace({
      error: "Request failed: ETIMEDOUT after 30000ms",
    });
    const result = await reflector.reflect(trace);
    expect(result.failureCategory).toBe("transient");
    expect(result.shouldEvolve).toBe(false);
    expect(result.rootCause).toContain("Transient failure");
  });

  it("reflect with network timeout returns shouldEvolve=false", async () => {
    const trace = makeTrace({
      error: "ECONNRESET: connection was reset by the server",
    });
    const result = await reflector.reflect(trace);
    expect(result.failureCategory).toBe("transient");
    expect(result.shouldEvolve).toBe(false);
  });

  it("reflect with rate limit returns shouldEvolve=false", async () => {
    {
      const trace = makeTrace({ error: "429 Too Many Requests" });
      const result = await reflector.reflect(trace);
      expect(result.failureCategory).toBe("transient");
      expect(result.shouldEvolve).toBe(false);
    }
    {
      const trace = makeTrace({ error: "rate limit exceeded, try again later" });
      const result = await reflector.reflect(trace);
      expect(result.failureCategory).toBe("transient");
      expect(result.shouldEvolve).toBe(false);
    }
  });

  it("reflect with systematic failure returns shouldEvolve=true", async () => {
    const trace = makeTrace({
      error: "TypeError: Cannot read property 'map' of undefined",
    });
    const result = await reflector.reflect(trace);
    expect(result.failureCategory).toBe("systematic");
    expect(result.shouldEvolve).toBe(true);
    expect(result.rootCause).toContain("Systematic error");
  });

  it("reflect with syntax error returns shouldEvolve=true", async () => {
    const trace = makeTrace({
      error: "SyntaxError: Unexpected token in JSON at position 42",
    });
    const result = await reflector.reflect(trace);
    expect(result.failureCategory).toBe("systematic");
    expect(result.shouldEvolve).toBe(true);
  });

  it("reflect with environmental failure returns shouldEvolve=false", async () => {
    const trace = makeTrace({
      error: "ENOENT: no such file or directory, open '/etc/config.yaml'",
    });
    const result = await reflector.reflect(trace);
    expect(result.failureCategory).toBe("environmental");
    expect(result.shouldEvolve).toBe(false);
    expect(result.rootCause).toContain("Environmental constraint");
  });

  it("reflect with permission denied returns shouldEvolve=false", async () => {
    const trace = makeTrace({
      error: "EACCES: permission denied, access '/var/log/app.log'",
    });
    const result = await reflector.reflect(trace);
    expect(result.failureCategory).toBe("environmental");
    expect(result.shouldEvolve).toBe(false);
  });

  it("reflect with no error and no failed steps returns shouldEvolve=false", async () => {
    const trace = makeTrace({
      steps: [
        { action: "step1", result: "ok", success: true, timestamp: Date.now() },
      ],
    });
    const result = await reflector.reflect(trace);
    expect(result.failureCategory).toBe("unknown");
    expect(result.shouldEvolve).toBe(false);
    expect(result.confidenceScore).toBe(0);
  });

  it("reflect with failed steps but no error infers root cause from steps", async () => {
    const trace = makeTrace({
      steps: [
        { action: "fetch_data", result: "ok", success: true, timestamp: Date.now() },
        { action: "parse_response", result: "failed to parse", success: false, timestamp: Date.now() },
      ],
    });
    const result = await reflector.reflect(trace);
    expect(result.rootCause).toContain("Step failure");
    expect(result.rootCause).toContain("parse_response");
  });

  it("crossValidate: when reflection says transient and internal says high, trust reflection", async () => {
    const reflection = {
      rootCause: "Transient failure",
      failureCategory: "transient" as const,
      suggestedImprovements: ["Add retry logic"],
      confidenceScore: 0.8,
      shouldEvolve: false,
    };
    const result = await reflector.crossValidate(0.9, reflection);
    expect(result.trusted).toBe(false);
    expect(result.finalScore).toBeLessThan(0.9);
    expect(result.finalScore).toBe(0.9 * 0.3);
  });

  it("crossValidate: when reflection says systematic and internal is low, boost from reflection", async () => {
    const reflection = {
      rootCause: "Systematic error",
      failureCategory: "systematic" as const,
      suggestedImprovements: ["Fix logic"],
      confidenceScore: 0.9,
      shouldEvolve: true,
    };
    const result = await reflector.crossValidate(0.3, reflection);
    expect(result.trusted).toBe(true);
    expect(result.finalScore).toBeGreaterThanOrEqual(0.3);
  });

  it("crossValidate: when both agree, combine scores", async () => {
    const reflection = {
      rootCause: "Systematic error",
      failureCategory: "systematic" as const,
      suggestedImprovements: ["Fix logic"],
      confidenceScore: 0.8,
      shouldEvolve: true,
    };
    const result = await reflector.crossValidate(0.7, reflection);
    expect(result.finalScore).toBeCloseTo(0.7 * 0.6 + 0.8 * 0.4, 4);
  });

  it("crossValidate: environmental failure reduces internal score", async () => {
    const reflection = {
      rootCause: "Environmental constraint",
      failureCategory: "environmental" as const,
      suggestedImprovements: ["Check permissions"],
      confidenceScore: 0.7,
      shouldEvolve: true,
    };
    const result = await reflector.crossValidate(0.8, reflection);
    expect(result.trusted).toBe(false);
    expect(result.finalScore).toBe(0.8 * 0.5);
  });

  it("classifyFailure for transient patterns", async () => {
    const traces = [
      "ETIMEDOUT connection timed out",
      "ECONNRESET socket hang up",
      "ECONNREFUSED connection refused",
      "socket hang up and the server is gone",
      "EAI_AGAIN DNS lookup failed",
    ];
    for (const error of traces) {
      const trace = makeTrace({ error });
      const result = await reflector.reflect(trace);
      expect(result.failureCategory).toBe("transient");
    }
  });

  it("classifyFailure for environmental patterns", async () => {
    const errors = [
      "ENOENT file not found",
      "EACCES permission denied",
      "403 Forbidden access",
      "404 Not Found resource",
      "unauthorized access attempt",
    ];
    for (const error of errors) {
      const trace = makeTrace({ error });
      const result = await reflector.reflect(trace);
      expect(result.failureCategory).toBe("environmental");
    }
  });

  it("classifyFailure for systematic patterns", async () => {
    const errors = [
      "TypeError: undefined is not a function",
      "ReferenceError: x is not defined",
      "RangeError: invalid array length",
      "validation error: invalid input",
    ];
    for (const error of errors) {
      const trace = makeTrace({ error });
      const result = await reflector.reflect(trace);
      expect(result.failureCategory).toBe("systematic");
    }
  });

  it("generates appropriate suggestions for each category", async () => {
    const transientResult = await reflector.reflect(
      makeTrace({ error: "ETIMEDOUT" })
    );
    expect(transientResult.suggestedImprovements).toContain("Add retry logic with exponential backoff");

    const systematicResult = await reflector.reflect(
      makeTrace({ error: "TypeError: cannot read property of undefined" })
    );
    expect(systematicResult.suggestedImprovements).toContain("Review and fix the logic error in the skill implementation");

    const envResult = await reflector.reflect(
      makeTrace({ error: "ENOENT: file not found" })
    );
    expect(envResult.suggestedImprovements).toContain("Verify resource availability and permissions");
  });

  it("confidence score increases with more matched pattern categories", async () => {
    const singleCategory = await reflector.reflect(
      makeTrace({ error: "ETIMEDOUT" })
    );
    const multiCategory = await reflector.reflect(
      makeTrace({ error: "TypeError and ENOENT both occurred" })
    );
    expect(multiCategory.confidenceScore).toBeGreaterThan(singleCategory.confidenceScore);
  });
});
