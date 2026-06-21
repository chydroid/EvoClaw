import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  // 在 CI 中禁用 Vite 文件系统缓存，避免多 fork 进程并发访问 /tmp 下 SSR deps
  // 临时缓存目录导致的 ENOENT 竞争错误
  cacheDir: process.env.CI ? false : "node_modules/.vitest",

  test: {
    // Environment
    environment: "node",

    // Pool: 显式使用 forks，避免 threads 与 native 模块的兼容性问题
    pool: "forks",
    forks: {
      // CI 中串行运行每个测试文件，避免并发争夺 SSR 转换缓存
      singleFork: process.env.CI ? true : false,
    },

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