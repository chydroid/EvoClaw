/**
 * Env Loader — 环境变量文件加载与净化
 *
 * 借鉴 hermes-agent hermes_cli/env_loader.py 设计：
 * - .env 文件加载与解析
 * - 凭证环境变量非 ASCII 字符剥离（防 PDF/富文本复制粘贴导致的 Unicode 替换字符问题）
 * - 嵌入 null 字节剥离（防 os.environ 崩溃）
 * - 占位符 token 检测（防 .env.example 复制的占位符导致 confusing "auth failed"）
 * - 配置损坏备份（YAML 解析失败时自动备份）
 */

import * as fs from "fs";
import * as path from "path";

// ── Credential Suffix Detection ───────────────────────────

/** 凭证环境变量后缀识别 */
const CREDENTIAL_SUFFIXES = ["_API_KEY", "_TOKEN", "_SECRET", "_KEY", "_PASSWORD"];

/**
 * 判断环境变量名是否为凭证变量。
 */
function isCredentialVar(name: string): boolean {
  return CREDENTIAL_SUFFIXES.some((suffix) => name.toUpperCase().endsWith(suffix));
}

// ── .env File Parsing ─────────────────────────────────────

export interface EnvLoadResult {
  /** 成功加载的变量 */
  vars: Record<string, string>;
  /** 警告列表 */
  warnings: string[];
  /** 是否检测到占位符 */
  hasPlaceholders: boolean;
}

/**
 * 从 .env 文件内容解析环境变量。
 *
 * 支持：
 *   - KEY=VALUE 格式
 *   - 引号包裹的值（单引号/双引号）
 *   - 注释（# 开头）
 *   - 空行
 *   - export KEY=VALUE 格式
 *
 * 借鉴 hermes-agent env_loader.py：
 *   - 剥离凭证变量中的非 ASCII 字符
 *   - 剥离嵌入的 null 字节
 *   - 检测占位符 token
 */
export function parseEnvContent(content: string): EnvLoadResult {
  const vars: Record<string, string> = {};
  const warnings: string[] = [];
  let hasPlaceholders = false;

  // 移除 BOM
  const cleaned = content.replace(/^\uFEFF/, "");

  const lines = cleaned.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNum = i + 1;

    // 去除前后空白
    const line = rawLine.trim();

    // 跳过空行和注释
    if (!line || line.startsWith("#")) continue;

    // 去除 export 前缀
    const processed = line.startsWith("export ")
      ? line.slice(7)
      : line;

    // 解析 KEY=VALUE
    const eqIdx = processed.indexOf("=");
    if (eqIdx < 0) continue;

    const key = processed.slice(0, eqIdx).trim();
    let value = processed.slice(eqIdx + 1).trim();

    if (!key) continue;

    // 去除引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // 剥离 null 字节（防 os.environ 崩溃）
    if (value.includes("\0")) {
      value = value.replace(/\0/g, "");
      warnings.push(`Line ${lineNum}: null bytes stripped from "${key}"`);
    }

    // 凭证变量：剥离非 ASCII 字符
    if (isCredentialVar(key)) {
      const original = value;
      // 剥离非 ASCII 字符（防止从 PDF/富文本复制粘贴导致的 Unicode 替换字符问题）
      value = value.replace(/[^\x20-\x7E]/g, "");
      if (original !== value) {
        warnings.push(
          `Line ${lineNum}: non-ASCII characters stripped from credential "${key}" ` +
          `(PDF/rich-text copy-paste corruption — see hermes-agent #6843)`,
        );
      }

      // 检测占位符 token
      if (isPlaceholderToken(value)) {
        hasPlaceholders = true;
        warnings.push(
          `Line ${lineNum}: "${key}" appears to be a placeholder value ` +
          `("${value.slice(0, 6)}...") — set a real value before starting`,
        );
      }
    }

    vars[key] = value;
  }

  return { vars, warnings, hasPlaceholders };
}

// ── Placeholder Token Detection ───────────────────────────

/** 占位符 token 前缀/模式 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^your[_-]?api[_-]?key/i,
  /^your[_-]?token/i,
  /^your[_-]?secret/i,
  /^your[_-]?password/i,
  /^placeholder/i,
  /^example/i,
  /^changeme/i,
  /^xxx+/i,
  /^<+[^>]+>+$/,  // <your-api-key>
  /^\[.+\]$/,     // [your-api-key]
  /^sk-your/i,
  /^sk-xxx/i,
  /^test/i,
];

/** 最小有效 token 长度 */
const MIN_TOKEN_LENGTH = 4;

/**
 * 检测值是否为占位符 token。
 *
 * 借鉴 hermes-agent gateway/config.py has_usable_secret：
 *   检测从 .env.example 复制的占位符，避免 confusing "auth failed" 错误。
 */
export function isPlaceholderToken(value: string): boolean {
  if (!value || value.trim().length === 0) return true;
  if (value.trim().length < MIN_TOKEN_LENGTH) return true;

  const trimmed = value.trim();
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

/**
 * 检查 token 是否为可用密钥（非空、非占位符、长度足够）。
 *
 * 借鉴 hermes-agent gateway/config.py has_usable_secret。
 */
export function hasUsableSecret(value: string | undefined, minLength: number = 4): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length < minLength) return false;
  if (isPlaceholderToken(trimmed)) return false;
  return true;
}

// ── Config Corruption Backup ──────────────────────────────

/**
 * 备份损坏的配置文件。
 *
 * 借鉴 hermes-agent hermes_cli/config.py _backup_corrupt_config：
 *   - YAML 解析失败时自动备份到 .corrupt.<timestamp>.bak
 *   - 拒绝跟随符号链接（防恶意符号链接攻击）
 *   - 按 (path, mtime_ns, size) 去重警告
 *
 * @param configPath 配置文件路径
 * @returns 备份文件路径，或 null 表示备份失败
 */
export function backupCorruptConfig(configPath: string): string | null {
  try {
    // 拒绝符号链接（防恶意符号链接攻击）
    const stat = fs.lstatSync(configPath);
    if (stat.isSymbolicLink()) {
      console.error(
        `Refusing to backup symlink "${configPath}" — ` +
        `possible symlink attack (mirrors hermes-agent Gemini #21541 lstat guard)`,
      );
      return null;
    }

    // 生成备份文件名
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${configPath}.corrupt.${timestamp}.bak`;

    // 复制文件（不跟随符号链接）
    const content = fs.readFileSync(configPath);
    fs.writeFileSync(backupPath, content);

    return backupPath;
  } catch (err) {
    console.error(`Failed to backup corrupt config "${configPath}": ${err}`);
    return null;
  }
}

// ── .env File Loading ─────────────────────────────────────

/**
 * 加载 .env 文件并返回解析结果。
 *
 * @param envPath .env 文件路径
 * @returns 解析结果，文件不存在时返回空结果
 */
export function loadEnvFile(envPath: string): EnvLoadResult {
  const empty: EnvLoadResult = { vars: {}, warnings: [], hasPlaceholders: false };

  try {
    if (!fs.existsSync(envPath)) return empty;
    const content = fs.readFileSync(envPath, "utf-8");
    return parseEnvContent(content);
  } catch (err) {
    return {
      ...empty,
      warnings: [`Failed to load .env file "${envPath}": ${err}`],
    };
  }
}

/**
 * 加载 .env 文件并注入到 process.env。
 *
 * 不覆盖已存在的环境变量（环境变量优先级高于 .env 文件）。
 *
 * @param envPath .env 文件路径
 * @returns 加载的变量数量和警告
 */
export function loadAndApplyEnvFile(envPath: string): {
  loaded: number;
  warnings: string[];
  hasPlaceholders: boolean;
} {
  const result = loadEnvFile(envPath);
  let loaded = 0;

  for (const [key, value] of Object.entries(result.vars)) {
    // 不覆盖已存在的环境变量
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded++;
    }
  }

  return {
    loaded,
    warnings: result.warnings,
    hasPlaceholders: result.hasPlaceholders,
  };
}
