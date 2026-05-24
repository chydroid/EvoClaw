import { describe, it, expect, vi } from "vitest";
import { aggregateHealth, healthCheck } from "./health";
import type { HealthCheck } from "./health";

describe("aggregateHealth", () => {
  it("should return healthy when all checks pass", () => {
    const checks: HealthCheck[] = [
      { name: "db", status: "pass" },
      { name: "redis", status: "pass" },
    ];
    const result = aggregateHealth(checks);
    expect(result.status).toBe("healthy");
    expect(result.checks).toEqual(checks);
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it("should return degraded when any check warns", () => {
    const checks: HealthCheck[] = [
      { name: "db", status: "pass" },
      { name: "redis", status: "warn", message: "High latency" },
    ];
    const result = aggregateHealth(checks);
    expect(result.status).toBe("degraded");
    expect(result.message).toContain("1 warnings");
  });

  it("should return unhealthy when any check fails", () => {
    const checks: HealthCheck[] = [
      { name: "db", status: "pass" },
      { name: "redis", status: "fail", message: "Connection refused" },
    ];
    const result = aggregateHealth(checks);
    expect(result.status).toBe("unhealthy");
    expect(result.message).toContain("1 checks failing");
  });

  it("should count multiple failures correctly", () => {
    const checks: HealthCheck[] = [
      { name: "a", status: "fail" },
      { name: "b", status: "fail" },
      { name: "c", status: "fail" },
    ];
    const result = aggregateHealth(checks);
    expect(result.status).toBe("unhealthy");
    expect(result.message).toContain("3 checks failing");
  });

  it("should return healthy for empty checks array", () => {
    const result = aggregateHealth([]);
    expect(result.status).toBe("healthy");
    expect(result.message).toBe("All checks passing");
    expect(result.checks).toEqual([]);
  });

  it("should include checks in the result", () => {
    const checks: HealthCheck[] = [
      { name: "a", status: "pass", latencyMs: 10, data: { uptime: 3600 } },
    ];
    const result = aggregateHealth(checks);
    expect(result.checks![0].data).toEqual({ uptime: 3600 });
  });

  it("should prioritize fail over warn for status", () => {
    const checks: HealthCheck[] = [
      { name: "a", status: "warn" },
      { name: "b", status: "fail" },
    ];
    const result = aggregateHealth(checks);
    expect(result.status).toBe("unhealthy");
  });
});

describe("healthCheck", () => {
  it("should create a pass check for healthy result", async () => {
    const check = healthCheck("test-component", async () => ({
      healthy: true,
      message: "OK",
      data: { version: "1.0" },
    }));
    const result = await check();
    expect(result.name).toBe("test-component");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("OK");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.data).toEqual({ version: "1.0" });
  });

  it("should create a fail check for unhealthy result", async () => {
    const check = healthCheck("test-component", async () => ({
      healthy: false,
      message: "Something wrong",
    }));
    const result = await check();
    expect(result.status).toBe("fail");
    expect(result.message).toBe("Something wrong");
  });

  it("should create a fail check when the function throws", async () => {
    const check = healthCheck("test-component", async () => {
      throw new Error("Boom");
    });
    const result = await check();
    expect(result.status).toBe("fail");
    expect(result.message).toBe("Boom");
  });

  it("should capture latency in ms", async () => {
    const check = healthCheck("slow-component", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { healthy: true };
    });
    const result = await check();
    expect(result.latencyMs).toBeGreaterThanOrEqual(5);
  });

  it("should handle non-Error throws", async () => {
    const check = healthCheck("test-component", async () => {
      throw "string error";
    });
    const result = await check();
    expect(result.status).toBe("fail");
    expect(result.message).toBe("string error");
  });

  it("should return a function that can be called multiple times", async () => {
    let count = 0;
    const check = healthCheck("counter", async () => {
      count++;
      return { healthy: true };
    });
    await check();
    await check();
    expect(count).toBe(2);
  });
});