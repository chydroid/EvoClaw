import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    // Environment
    environment: "node",
    
    // Pattern matching
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.spec.ts", 
      "packages/*/tests/**/*.test.ts",
      "packages/*/tests/**/*.spec.ts",
      "apps/*/tests/**/*.test.ts",
      "apps/*/tests/**/*.spec.ts",
      "coding-tasks/*/test/**/*.test.ts",
      "coding-tasks/*/test/**/*.spec.ts",
    ],
    exclude: [
      "node_modules",
      "dist",
      ".git",
    ],

    // Global settings
    globals: true,
    
    // Coverage
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: [
        "packages/*/src/**/*.ts",
        "apps/*/src/**/*.ts",
      ],
      exclude: [
        "node_modules",
        "dist",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/index.ts",
      ],
    },

    // Timeouts
    testTimeout: 30000,
    hookTimeout: 10000,
    
    // Retry flaky tests in CI
    retry: process.env.CI ? 2 : 0,
    
    // Reporters
    reporters: process.env.CI 
      ? ["default", "junit"] 
      : ["default"],
  },
  
  resolve: {
    alias: {
      "@evoclaw/core": resolve(__dirname, "packages/core/src"),
      "@evoclaw/agent": resolve(__dirname, "packages/agent/src"),
      "@evoclaw/skills": resolve(__dirname, "packages/skills/src"),
      "@evoclaw/gateway": resolve(__dirname, "packages/gateway/src"),
      "@evoclaw/memory": resolve(__dirname, "packages/memory/src"),
      "@evoclaw/security": resolve(__dirname, "packages/security/src"),
      "@evoclaw/evolution": resolve(__dirname, "packages/evolution/src"),
      "@evoclaw/infrastructure": resolve(__dirname, "packages/infrastructure/src"),
      "@evoclaw/scheduler": resolve(__dirname, "packages/scheduler/src"),
      "@evoclaw/reporting": resolve(__dirname, "packages/reporting/src"),
      "@evoclaw/intelligence": resolve(__dirname, "packages/intelligence/src"),
      "@evoclaw/plugin-sdk": resolve(__dirname, "packages/plugin-sdk/src"),
    },
  },
});