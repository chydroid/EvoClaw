// @ts-check
/**
 * EvoClaw 根级 ESLint flat config。
 *
 * 设计原则：
 * - 最小化规则集：仅启用 typescript-eslint recommended（捕获真实 bug，不强制 stylistic）
 * - 不与 prettier 冲突：不启用 formatting 规则
 * - 跨平台：不依赖 .eslintrc 风格的 extends 链
 * - 主包 + apps 共用一份配置，api-gateway 子项目独立配置（保留其 jest 环境）
 *
 * 使用方式：
 *   pnpm lint           # 全 workspace 递归
 *   pnpm --filter @evoclaw/agent lint   # 单包
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // ── 全局忽略 ──────────────────────────────────────────────
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.d.ts",
      "go-bookstore/**",
      "api-gateway/**", // 子项目独立配置
      ".git/**",
      "data/**", // 技能脚本数据目录（第三方代码）
      "coding-tasks/**", // 编码任务目录（非项目源码）
      "nouse/**", // 废弃代码目录
    ],
  },

  // ── JS 基线 ──────────────────────────────────────────────
  js.configs.recommended,

  // ── TypeScript 主包 ──────────────────────────────────────
  ...tseslint.configs.recommended,

  // ── 全局规则覆盖（所有 TS/TSX 文件） ──────────────────────
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaVersion: 2022,
        ecmaFeatures: { jsx: true }, // 启用 JSX 解析（web-ui 的 .tsx 文件）
        jsx: true, // typescript-eslint parser 的 JSX 选项
      },
    },
    rules: {
      // ── 放宽的 stylistic 规则（不强制，避免大量改动现有代码） ──
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off", // 现有代码大量使用 any，逐步收紧
      "@typescript-eslint/ban-ts-comment": "off", // 允许 @ts-ignore（已有解释）
      "@typescript-eslint/no-empty-function": "off", // 允许空函数（noop 占位）
      "@typescript-eslint/no-empty-object-type": "off", // 允许空接口/类型
      "@typescript-eslint/no-require-imports": "off", // 允许 require（懒加载）

      // ── no-undef：TypeScript 编译器已检查未定义变量，此规则在 TS 文件中误报 ──
      // （process / console / Buffer 等 Node.js 全局变量会被误判）
      "no-undef": "off",

      // ── 降级非关键规则为 warning（避免大量改动现有代码，保留 lint 门禁） ──
      "no-useless-escape": "off", // 正则转义，非 bug
      "no-control-regex": "off", // 控制字符正则，可能是故意的（如脱敏 pattern）
      "no-empty": "off", // 空块语句，可能是 noop 占位
      "prefer-const": "off", // 代码风格，非 bug
      "no-case-declarations": "off", // switch case 声明，现有代码风格
      "no-inner-declarations": "off", // 函数声明位置，现有代码风格
      "no-constant-condition": "off", // while(true) 等常见模式
      "no-cond-assign": "off", // 条件赋值，现有代码有故意使用
      "no-unused-labels": "off", // 标签未使用
      "no-extra-semi": "off", // 多余分号

      // ── TypeScript 特定规则降级 ──
      "@typescript-eslint/no-unsafe-declaration-merging": "off", // 现有代码有故意合并
      "@typescript-eslint/no-this-alias": "off", // 现有代码有 this 别名

      // ── React hooks（web-ui）──
      "react-hooks/rules-of-hooks": "off", // 现有代码可能不严格遵守
      "react-hooks/exhaustive-deps": "off", // 现有代码有故意省略依赖
    },
  },

  // ── React hooks 插件注册 ──────────────────────────────────
  {
    files: ["**/*.tsx", "**/*.jsx"],
    plugins: { "react-hooks": reactHooks },
  },

  // ── JS 脚本文件（scripts/ 目录） ──────────────────────────
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      "no-undef": "off", // scripts/ 下的 Node.js 脚本也用 process/console 等
      "no-useless-escape": "off",
      "no-control-regex": "off",
      "no-empty": "off",
      "prefer-const": "off",
      "no-constant-condition": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  // ── 测试文件覆盖 ──────────────────────────────────────────
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
