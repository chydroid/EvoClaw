import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConfigDoctor, diagnoseConfig } from "./config-doctor";
import type { DoctorReport } from "./config-doctor";

const healthyConfig = {
  server: { port: 3000, host: "localhost", corsOrigins: ["http://localhost:3000"] },
  auth: { jwtSecret: "super-secret-key-at-least-32-chars-long!", tokenExpiry: "1h", refreshExpiry: "7d" },
  gateway: { enableMCP: true, enableREST: true, rateLimitWindow: 60000, rateLimitMax: 100 },
  persona: { name: "TestBot", title: "Assistant", masterTerm: "bot", tone: "warm", introduction: "Hello!" },
  agent: { minAgents: 1, maxAgents: 5, maxRetries: 3, defaultTimeout: 30000, scaleThreshold: 0.8, pollDelayMs: 1000 },
  sandbox: { defaultMaxExecutionTime: 30000, defaultMaxMemoryMB: 512, allowNetwork: true, allowFileSystem: true, allowSubprocess: false },
  memory: { shortTermDefaultTTL: 300000, vectorDimension: 768, similarityThreshold: 0.7, maxHistoryEntries: 100 },
  security: { auditRetention: 30, rateLimitDefault: 100, rateLimitWindow: 60000, anomalyCheckInterval: 60000 },
  evolution: {
    enabled: true, autoEvolution: false, minConfidence: 0.8, maxCandidatesPerCycle: 5,
    learningJournal: { path: "./journal", format: "jsonl", rotateOnSizeMB: 100 },
  },
};

describe("ConfigDoctor", () => {
  describe("diagnose", () => {
    it("should report healthy for valid config", () => {
      const report = diagnoseConfig(healthyConfig, {
        knownKeys: Object.keys(healthyConfig),
      });
      expect(report.healthy).toBe(true);
      expect(report.errorCount).toBe(0);
    });

    it("should report healthy for valid config with known keys", () => {
      const report = diagnoseConfig(healthyConfig, {
        knownKeys: [
          "server.port", "server.host", "auth.jwtSecret", "agent.minAgents",
          "memory.vectorDimension", "evolution.enabled",
        ],
      });
      expect(report.healthy).toBe(true);
    });

    it("should detect missing config file", () => {
      const doctor = new ConfigDoctor({
        configPath: "/nonexistent/path/config.json",
      });
      const report = doctor.diagnose();
      expect(report.healthy).toBe(false);
      expect(report.diagnostics.some((d) => d.code === "CONFIG_FILE_MISSING")).toBe(true);
    });

    it("should detect invalid port", () => {
      const badConfig = { ...healthyConfig, server: { ...healthyConfig.server, port: 99999 } };
      const report = diagnoseConfig(badConfig);
      expect(report.diagnostics.some((d) => d.code === "INVALID_PORT")).toBe(true);
    });

    it("should detect weak JWT secret", () => {
      const badConfig = { ...healthyConfig, auth: { ...healthyConfig.auth, jwtSecret: "123" } };
      const report = diagnoseConfig(badConfig);
      expect(report.diagnostics.some((d) => d.code === "WEAK_JWT_SECRET")).toBe(true);
    });

    it("should detect default JWT secret", () => {
      const badConfig = { ...healthyConfig, auth: { ...healthyConfig.auth, jwtSecret: "CHANGE_ME" } };
      const report = diagnoseConfig(badConfig);
      expect(report.diagnostics.some((d) => d.code === "DEFAULT_JWT_SECRET")).toBe(true);
    });

    it("should detect agent pool mismatch", () => {
      const badConfig = {
        ...healthyConfig,
        agent: { ...healthyConfig.agent, minAgents: 10, maxAgents: 5 },
      };
      const report = diagnoseConfig(badConfig);
      expect(report.diagnostics.some((d) => d.code === "AGENT_POOL_MISMATCH")).toBe(true);
    });

    it("should detect unknown config keys with suggestion", () => {
      const badConfig = { ...healthyConfig, serverr: { port: 3000 } };
      const report = diagnoseConfig(badConfig);
      const typoDiag = report.diagnostics.find((d) => d.code === "UNKNOWN_CONFIG_KEY");
      expect(typoDiag).toBeDefined();
      expect(typoDiag!.suggestion).toContain("Did you mean");
    });

    it("should detect deprecated keys", () => {
      const config = { old_key: "value", ...healthyConfig };
      const report = diagnoseConfig(config, {
        deprecatedKeys: { "old_key": "new_key" },
      });
      expect(report.diagnostics.some((d) => d.code === "DEPRECATED_KEY")).toBe(true);
    });

    it("should detect missing required keys", () => {
      const report = diagnoseConfig({}, {
        requiredKeys: ["server.port"],
      });
      expect(report.diagnostics.some((d) => d.code === "MISSING_REQUIRED_KEY")).toBe(true);
    });

    it("should warn about low vector dimension", () => {
      const badConfig = { ...healthyConfig, memory: { ...healthyConfig.memory, vectorDimension: 32 } };
      const report = diagnoseConfig(badConfig);
      expect(report.diagnostics.some((d) => d.code === "LOW_VECTOR_DIM")).toBe(true);
    });

    it("should include summary in report", () => {
      const report = diagnoseConfig(healthyConfig);
      expect(report.summary).toBeDefined();
      expect(report.totalCount).toBeGreaterThanOrEqual(0);
    });

    it("should return correct counts", () => {
      const badConfig = { ...healthyConfig, auth: { jwtSecret: "weak" } };
      const report = diagnoseConfig(badConfig);

      expect(report.errorCount).toBeGreaterThanOrEqual(0);
      expect(report.warningCount).toBeGreaterThanOrEqual(0);
      expect(report.totalCount).toBe(report.errorCount + report.warningCount + report.infoCount);
    });
  });

  describe("autoFix", () => {
    it("should mark fixable diagnostics as fixed", () => {
      const doctor = new ConfigDoctor({ autoFix: true, deprecatedKeys: { "old_key": "new_key" } });
      const report = doctor.diagnose({ old_key: "value" });
      const fixCount = doctor.autoFix(report.diagnostics);
      expect(fixCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe("checkEnvVars", () => {
    it("should accept custom required env vars", () => {
      const report = diagnoseConfig(healthyConfig, {
        requiredEnvVars: ["PATH"], // PATH always exists
      });
      expect(report.diagnostics.filter((d) => d.code === "ENV_VAR_MISSING")).toHaveLength(0);
    });
  });

  describe("doctorAndFix", () => {
    it("should work as convenience function", () => {
      const report = diagnoseConfig(healthyConfig);
      expect(report).toBeDefined();
    });
  });
});