import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  // 使用项目内固定缓存目录，避免 CI 中 /tmp 被系统清理导致 SSR 临时文件 ENOENT
  cacheDir: ".vitest/cache",

  test: {
    // Environment
    environment: "node",

    // Pool: 显式使用 forks，避免 threads 与 native 模块的兼容性问题
    pool: "forks",
    poolOptions: {
      forks: {
        // 每个 fork 进程只运行一个测试文件，进一步降低 SSR 临时文件竞争
        singleFork: true,
      },
    },

    // 串行运行测试文件，避免并发争夺 SSR 转换缓存；但保持 isolate: true
    // 这样每个文件仍有独立进程/module graph，coverage 不会互相踩临时文件
    fileParallelism: false,
    isolate: true,

    // 禁用 SSR 依赖优化器，避免生成临时转换文件（CI 上易发生 ENOENT 竞争）
    deps: {
      optimizer: {
        ssr: { enabled: false },
      },
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
      provider: "istanbul",
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
  
  // 禁用 Vite 文件系统缓存检查，避免 CI 上因缓存状态不一致导致模块加载异常
  server: {
    fs: {
      cachedChecks: false,
    },
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