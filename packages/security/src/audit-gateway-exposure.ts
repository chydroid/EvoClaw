// 网关暴露审计：检测外部暴露风险。
// 对齐 openclaw-main src/security/audit-gateway-config.ts + audit-gateway-exposure.test 的核心检查项。
// 纯函数实现，输入为网关配置快照，避免耦合 gateway/server 内部类型。

export interface GatewayExposureChannel {
  type: string;
  webhookUrl?: string;
  publicExposed?: boolean;
}

export interface GatewayExposureAuditInput {
  gateway: {
    /** 监听地址 */
    host: string;
    port: number;
    /** 对外 URL */
    publicUrl?: string;
    cors: {
      origin: string | string[];
      credentials: boolean;
    };
    auth?: {
      enabled: boolean;
      type?: string;
    };
    tls?: {
      enabled: boolean;
      certPath?: string;
    };
    rateLimit?: {
      enabled: boolean;
      maxRequests?: number;
      windowMs?: number;
    };
    channels?: GatewayExposureChannel[];
  };
}

export type GatewayExposureAuditSeverity = "info" | "warning" | "error";

export interface GatewayExposureAuditFinding {
  severity: GatewayExposureAuditSeverity;
  rule: string;
  message: string;
  suggestion?: string;
}

// 不安全监听地址（绑定到所有网卡）
const UNSAFE_HOSTS = new Set(["0.0.0.0", "::", "*", "[::]"]);

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return value.trim().toLowerCase().startsWith("http://");
}

function isPublicHost(host: string): boolean {
  const trimmed = (host ?? "").trim();
  return UNSAFE_HOSTS.has(trimmed);
}

function originIncludesWildcard(origin: string | string[]): boolean {
  if (Array.isArray(origin)) {
    return origin.some((o) => typeof o === "string" && o.trim() === "*");
  }
  return typeof origin === "string" && origin.trim() === "*";
}

/**
 * 审计网关暴露面，返回所有风险发现。
 * 检查项：
 * 1. host 为 0.0.0.0 而非 127.0.0.1
 * 2. auth disabled
 * 3. cors origin "*" + credentials=true（CORS 凭证通配）
 * 4. TLS disabled
 * 5. rate limit disabled
 * 6. webhook URL 是 HTTP
 * 7. channels publicExposed=true 但 auth disabled
 */
export function auditGatewayExposure(
  input: GatewayExposureAuditInput,
): GatewayExposureAuditFinding[] {
  const findings: GatewayExposureAuditFinding[] = [];
  const gw = input.gateway ?? ({} as GatewayExposureAuditInput["gateway"]);
  const host = gw.host ?? "";
  const auth = gw.auth ?? { enabled: true };
  const tls = gw.tls ?? { enabled: false };
  const rateLimit = gw.rateLimit ?? { enabled: false };
  const cors = gw.cors ?? { origin: [], credentials: false };
  const channels = gw.channels ?? [];

  // 1. host 绑定到所有网卡
  if (isPublicHost(host)) {
    findings.push({
      severity: "warning",
      rule: "gateway-public-bind",
      message: `网关 host="${host}" 绑定到所有网卡，外部网络可直接访问端口 ${gw.port}`,
      suggestion: '改为 "127.0.0.1" 或具体内网地址，通过反向代理对外暴露',
    });
  }

  // 2. auth disabled
  if (auth.enabled === false) {
    findings.push({
      severity: "error",
      rule: "gateway-auth-disabled",
      message: "网关鉴权已关闭，任意请求可访问控制面与工具调用",
      suggestion: "开启 auth.enabled 并配置 token/密码或可信代理模式",
    });
  }

  // 3. CORS 凭证通配
  if (originIncludesWildcard(cors.origin) && cors.credentials === true) {
    findings.push({
      severity: "error",
      rule: "gateway-cors-credentials-wildcard",
      message: 'cors.origin="*" 同时启用 credentials，浏览器规范禁止且会导致凭证泄露',
      suggestion: '将 origin 限定为可信来源列表，或关闭 credentials',
    });
  } else if (originIncludesWildcard(cors.origin)) {
    findings.push({
      severity: "warning",
      rule: "gateway-cors-wildcard",
      message: 'cors.origin="*" 允许任意来源跨域访问',
      suggestion: "限定为可信来源列表，避免通配符",
    });
  }

  // 4. TLS disabled
  if (tls.enabled === false) {
    findings.push({
      severity: "warning",
      rule: "gateway-tls-disabled",
      message: "TLS 未启用，HTTP 流量明文传输（含 token/会话）",
      suggestion: "启用 tls.enabled 并配置 certPath，或置于 HTTPS 反向代理后",
    });
  }

  // 5. rate limit disabled
  if (rateLimit.enabled === false) {
    findings.push({
      severity: "info",
      rule: "gateway-rate-limit-disabled",
      message: "速率限制未启用，易受暴力/爆破与爬取",
      suggestion: "配置 rateLimit.enabled=true 并设置 maxRequests/windowMs",
    });
  }

  // 6. webhook URL HTTP
  for (const ch of channels) {
    if (isHttpUrl(ch.webhookUrl)) {
      findings.push({
        severity: "warning",
        rule: "gateway-channel-insecure-webhook",
        message: `${ch.type} 渠道 webhookUrl 使用 HTTP：${ch.webhookUrl}`,
        suggestion: "改用 HTTPS webhook，并验证对端证书",
      });
    }
    // 7. publicExposed=true 但 auth disabled
    if (ch.publicExposed === true && auth.enabled === false) {
      findings.push({
        severity: "error",
        rule: "gateway-channel-public-no-auth",
        message: `${ch.type} 渠道 publicExposed=true 但网关鉴权已关闭，公网可未授权访问`,
        suggestion: "开启 auth.enabled 或将渠道 publicExposed 置为 false",
      });
    }
  }

  // 对外 URL 是 HTTP
  if (isHttpUrl(gw.publicUrl)) {
    findings.push({
      severity: "warning",
      rule: "gateway-public-url-insecure",
      message: `publicUrl 使用 HTTP：${gw.publicUrl}`,
      suggestion: "改用 HTTPS publicUrl，避免暴露明文入口",
    });
  }

  return findings;
}
