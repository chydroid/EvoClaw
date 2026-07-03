/**
 * CredentialGuard — cron 任务配置中的凭据泄露阻断。
 *
 * 对标 Hermes v0.18.0 的 "cron base_url 凭据泄露阻断"：
 * - 检测 cron 任务配置中 base_url 是否内嵌了凭据（如 https://user:pass@host）
 * - 检测 handlerConfig 中是否包含明文 Authorization / Bearer / token / api_key
 * - 检测 URL query 参数中是否包含 token / key / secret
 * - 提供脱敏建议（移到环境变量或 header）
 *
 * 用法：
 * ```ts
 * const guard = new CredentialGuard();
 * const result = guard.scan(task);
 * if (result.hasRisks) {
 *   console.warn(result.warnings);
 *   // 阻断任务创建或要求用户修正
 * }
 * ```
 */

// ── Types ─────────────────────────────────────────────────

/** 凭据风险等级 */
export type CredentialRiskLevel = "low" | "medium" | "high" | "critical";

/** 凭据风险项 */
export interface CredentialRisk {
  /** 风险等级 */
  level: CredentialRiskLevel;
  /** 风险类型 */
  type: "url_embedded_credentials" | "plaintext_token" | "query_param_secret" | "hardcoded_api_key" | "authorization_header";
  /** 风险描述 */
  description: string;
  /** 涉及的字段路径（如 "handlerConfig.base_url"） */
  fieldPath: string;
  /** 修复建议 */
  remediation: string;
}

/** 扫描结果 */
export interface CredentialScanResult {
  /** 是否存在风险 */
  hasRisks: boolean;
  /** 风险项列表 */
  warnings: CredentialRisk[];
  /** 风险项数量 */
  riskCount: number;
  /** 最高风险等级 */
  maxRiskLevel: CredentialRiskLevel | "none";
}

// ── CredentialGuard ───────────────────────────────────────

/**
 * CredentialGuard —— cron 任务凭据泄露检测器。
 *
 * 在任务创建/更新时扫描配置，检测明文凭据泄露。
 */
export class CredentialGuard {
  private static readonly SENSITIVE_KEY_PATTERNS = [
    /api[_-]?key/i,
    /auth[_-]?token/i,
    /access[_-]?token/i,
    /secret/i,
    /password/i,
    /passwd/i,
    /bearer/i,
    /authorization/i,
    /credential/i,
    /private[_-]?key/i,
  ];

  private static readonly SENSITIVE_URL_QUERY_KEYS = [
    "token", "key", "api_key", "apikey", "secret", "access_token",
    "auth", "password", "passwd", "credential",
  ];

  private static readonly URL_CREDENTIAL_PATTERN = /https?:\/\/[^:/@\s]+:[^:/@\s]+@/i;
  private static readonly BEARER_PATTERN = /bearer\s+[a-zA-Z0-9\-_\.=]+/i;
  private static readonly AUTH_HEADER_PATTERN = /authorization\s*[:=]\s*["']?(bearer|basic|token)\s+/i;
  private static readonly API_KEY_PATTERN = /(sk-|pk-|ak-|AKIA|ghp_|gho_|ghu_|ghs_|ghr_|xox[bpoas]-)[a-zA-Z0-9\-_]{10,}/i;

  /**
   * 扫描 ScheduledTask 的配置，检测凭据泄露风险。
   */
  scan(task: {
    id?: string;
    name?: string;
    handlerConfig?: Record<string, unknown>;
  }): CredentialScanResult {
    const warnings: CredentialRisk[] = [];

    // 扫描 handlerConfig 中所有字符串值
    if (task.handlerConfig) {
      this.scanObject(task.handlerConfig, "handlerConfig", warnings);
    }

    const maxRiskLevel = this.getMaxRiskLevel(warnings);
    return {
      hasRisks: warnings.length > 0,
      warnings,
      riskCount: warnings.length,
      maxRiskLevel,
    };
  }

  /**
   * 扫描单个字符串值，检测凭据泄露。
   */
  scanString(value: string, fieldPath: string): CredentialRisk[] {
    const risks: CredentialRisk[] = [];

    // 1. URL 内嵌凭据 (https://user:pass@host)
    if (CredentialGuard.URL_CREDENTIAL_PATTERN.test(value)) {
      risks.push({
        level: "critical",
        type: "url_embedded_credentials",
        description: `URL contains embedded credentials (user:pass@host)`,
        fieldPath,
        remediation: "Remove credentials from URL. Use environment variables or Authorization header instead.",
      });
    }

    // 2. Bearer token 明文
    if (CredentialGuard.BEARER_PATTERN.test(value)) {
      risks.push({
        level: "high",
        type: "plaintext_token",
        description: `Plaintext Bearer token detected`,
        fieldPath,
        remediation: "Move token to environment variable. Reference as ${env.TOKEN_NAME} in config.",
      });
    }

    // 3. Authorization header 明文
    if (CredentialGuard.AUTH_HEADER_PATTERN.test(value)) {
      risks.push({
        level: "high",
        type: "authorization_header",
        description: `Plaintext Authorization header detected`,
        fieldPath,
        remediation: "Use environment variable reference instead of hardcoded auth header.",
      });
    }

    // 4. 已知 API key 前缀 (sk-, ghp_, xox- 等)
    if (CredentialGuard.API_KEY_PATTERN.test(value)) {
      risks.push({
        level: "high",
        type: "hardcoded_api_key",
        description: `Hardcoded API key detected (matches known prefix pattern)`,
        fieldPath,
        remediation: "Move API key to environment variable. Never hardcode keys in task config.",
      });
    }

    // 5. URL query 参数中的 secret
    if (/https?:\/\/[^\s]*\?/i.test(value)) {
      try {
        const urlMatch = value.match(/https?:\/\/[^\s\"'<>]+/i);
        if (urlMatch) {
          const url = new URL(urlMatch[0]);
          for (const key of url.searchParams.keys()) {
            if (CredentialGuard.SENSITIVE_URL_QUERY_KEYS.includes(key.toLowerCase())) {
              risks.push({
                level: "medium",
                type: "query_param_secret",
                description: `Sensitive parameter "${key}" in URL query string`,
                fieldPath,
                remediation: "Move sensitive parameters to headers or POST body.",
              });
            }
          }
        }
      } catch {
        // URL 解析失败，跳过
      }
    }

    return risks;
  }

  /**
   * 递归扫描对象中的所有字符串值。
   */
  private scanObject(obj: unknown, path: string, warnings: CredentialRisk[]): void {
    if (typeof obj === "string") {
      // 检查 key 名称是否敏感（通过路径推断）
      const lastKey = path.split(".").pop() ?? "";
      const isSensitiveKey = CredentialGuard.SENSITIVE_KEY_PATTERNS.some((p) => p.test(lastKey));

      const stringRisks = this.scanString(obj, path);
      warnings.push(...stringRisks);

      // 如果 key 名是敏感的但值不是空且不是环境变量引用
      if (isSensitiveKey && obj.length > 0 && !obj.startsWith("${env.") && !obj.startsWith("env.")) {
        warnings.push({
          level: "medium",
          type: "plaintext_token",
          description: `Sensitive field "${lastKey}" contains hardcoded value`,
          fieldPath: path,
          remediation: `Use environment variable reference: \${env.${lastKey.toUpperCase()}}`,
        });
      }
    } else if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        this.scanObject(obj[i], `${path}[${i}]`, warnings);
      }
    } else if (obj !== null && typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        this.scanObject((obj as Record<string, unknown>)[key], `${path}.${key}`, warnings);
      }
    }
  }

  /** 获取最高风险等级 */
  private getMaxRiskLevel(warnings: CredentialRisk[]): CredentialRiskLevel | "none" {
    if (warnings.length === 0) return "none";
    const levels: CredentialRiskLevel[] = ["low", "medium", "high", "critical"];
    let maxIdx = 0;
    for (const w of warnings) {
      const idx = levels.indexOf(w.level);
      if (idx > maxIdx) maxIdx = idx;
    }
    return levels[maxIdx];
  }

  /**
   * 脱敏字符串 —— 将检测到的凭据替换为 ***。
   */
  redactString(value: string): string {
    let redacted = value;
    redacted = redacted.replace(CredentialGuard.URL_CREDENTIAL_PATTERN, "https://***:***@");
    redacted = redacted.replace(CredentialGuard.BEARER_PATTERN, "Bearer ***");
    redacted = redacted.replace(CredentialGuard.AUTH_HEADER_PATTERN, "authorization=***");
    redacted = redacted.replace(CredentialGuard.API_KEY_PATTERN, "***");
    return redacted;
  }
}
