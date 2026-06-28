/**
 * 网络策略（对齐 openclaw-main 的 net-policy 包）。
 *
 * 与 SSRFProtection 互补：
 * - SSRFProtection 关注"IP 是否为内网/环回/元数据端点"
 * - NetPolicy 关注"主机是否在允许/拒绝名单" + "DNS 钉制防止 DNS 重绑定"
 *
 * 三层防护：
 * 1. 协议层：仅允许 http/https（默认禁止 file://、ftp://、gopher:// 等）
 * 2. 主机层：allowlist / denylist（支持通配符 *.example.com）
 * 3. IP 层：DNS 钉制（解析后缓存 IP，发起请求前再次解析对比）
 */

import { isIP } from "node:net";
import dns from "node:dns/promises";
import { URL } from "node:url";

/** 网络策略配置。 */
export interface NetPolicyConfig {
  /** 允许的协议（默认 ["http:", "https:"]） */
  allowedProtocols?: string[];
  /** 主机允许名单（为空表示不限制，非空表示仅允许列表内主机） */
  allowlistHosts?: string[];
  /** 主机拒绝名单 */
  denylistHosts?: string[];
  /** IP 拒绝名单（CIDR 或单 IP） */
  denylistIPs?: string[];
  /** IP 允许名单（CIDR 或单 IP，优先于拒绝名单） */
  allowlistIPs?: string[];
  /** DNS 钉制 TTL（毫秒，默认 60 秒） */
  dnsPinTtlMs?: number;
  /** 是否启用 DNS 钉制（默认 true） */
  enableDnsPinning?: boolean;
  /** DNS 解析超时（毫秒，默认 5 秒） */
  dnsTimeoutMs?: number;
}

/** 策略检查结果。 */
export interface NetPolicyResult {
  allowed: boolean;
  reason?: string;
  /** 解析到的 IP（如有） */
  resolvedIp?: string;
  /** 缓存的 IP（如有，用于 DNS 钉制对比） */
  pinnedIp?: string;
}

/** DNS 钉制缓存条目。 */
interface DnsPinEntry {
  ip: string;
  expiresAt: number;
}

/**
 * 网络策略类。
 *
 * 使用方式：
 * ```ts
 * const policy = new NetPolicy({
 *   allowlistHosts: ["api.example.com", "*.trusted.org"],
 *   denylistHosts: ["malicious.com"],
 *   enableDnsPinning: true,
 * });
 * const result = policy.checkUrl("https://api.example.com/path");
 * if (!result.allowed) throw new Error(result.reason);
 * ```
 */
export class NetPolicy {
  private config: Required<NetPolicyConfig>;
  private dnsCache = new Map<string, DnsPinEntry>();

  constructor(config: NetPolicyConfig = {}) {
    this.config = {
      allowedProtocols: config.allowedProtocols ?? ["http:", "https:"],
      allowlistHosts: config.allowlistHosts ?? [],
      denylistHosts: config.denylistHosts ?? [],
      allowlistIPs: config.allowlistIPs ?? [],
      denylistIPs: config.denylistIPs ?? [],
      dnsPinTtlMs: config.dnsPinTtlMs ?? 60_000,
      enableDnsPinning: config.enableDnsPinning ?? true,
      dnsTimeoutMs: config.dnsTimeoutMs ?? 5_000,
    };
  }

  /**
   * 检查 URL 是否符合策略。
   * 若启用 DNS 钉制，会解析主机名并缓存 IP。
   */
  async checkUrl(url: string): Promise<NetPolicyResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: `Invalid URL: ${url}` };
    }

    // 1. 协议检查
    if (!this.config.allowedProtocols.includes(parsed.protocol)) {
      return {
        allowed: false,
        reason: `Protocol "${parsed.protocol}" not allowed (allowed: ${this.config.allowedProtocols.join(", ")})`,
      };
    }

    const host = parsed.hostname.toLowerCase();

    // 2. 主机拒绝名单检查
    if (this.matchHostList(host, this.config.denylistHosts)) {
      return { allowed: false, reason: `Host "${host}" is in denylist` };
    }

    // 3. 主机允许名单检查（若配置了允许名单）
    if (this.config.allowlistHosts.length > 0) {
      if (!this.matchHostList(host, this.config.allowlistHosts)) {
        return { allowed: false, reason: `Host "${host}" not in allowlist` };
      }
    }

    // 4. IP 解析 + 钉制
    if (this.config.enableDnsPinning) {
      const ipResult = await this.resolveAndPinIp(host);
      if (!ipResult.allowed) return ipResult;

      // 5. IP 黑白名单检查
      const ip = ipResult.resolvedIp!;
      if (!this.checkIpPolicy(ip)) {
        return {
          allowed: false,
          resolvedIp: ip,
          pinnedIp: ipResult.pinnedIp,
          reason: `Resolved IP ${ip} is blocked by IP policy`,
        };
      }

      return {
        allowed: true,
        resolvedIp: ip,
        pinnedIp: ipResult.pinnedIp,
      };
    }

    return { allowed: true };
  }

  /** 同步检查 URL（不解析 DNS，仅协议与主机名单）。 */
  checkUrlSync(url: string): NetPolicyResult {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: `Invalid URL: ${url}` };
    }
    if (!this.config.allowedProtocols.includes(parsed.protocol)) {
      return {
        allowed: false,
        reason: `Protocol "${parsed.protocol}" not allowed`,
      };
    }
    const host = parsed.hostname.toLowerCase();
    if (this.matchHostList(host, this.config.denylistHosts)) {
      return { allowed: false, reason: `Host "${host}" is in denylist` };
    }
    if (this.config.allowlistHosts.length > 0 && !this.matchHostList(host, this.config.allowlistHosts)) {
      return { allowed: false, reason: `Host "${host}" not in allowlist` };
    }
    return { allowed: true };
  }

  /**
   * 匹配主机名到列表（支持通配符）。
   * - "*.example.com" 匹配 "api.example.com" 但不匹配 "example.com"
   * - "example.com" 精确匹配
   */
  private matchHostList(host: string, list: string[]): boolean {
    for (const pattern of list) {
      const p = pattern.toLowerCase();
      if (p === host) return true;
      if (p.startsWith("*.")) {
        const suffix = p.slice(2); // 去掉 "*."
        if (host.endsWith("." + suffix) || host === suffix) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 解析主机名并钉制 IP。
   * - 首次解析：缓存 IP + TTL
   * - 后续请求：若 IP 变化（DNS 重绑定攻击），拒绝
   */
  private async resolveAndPinIp(host: string): Promise<NetPolicyResult> {
    // 若主机本身就是 IP，直接返回
    const ipType = isIP(host);
    if (ipType !== 0) {
      return { allowed: true, resolvedIp: host, pinnedIp: host };
    }

    const cached = this.dnsCache.get(host);
    const now = Date.now();

    let resolvedIp: string | null = null;
    try {
      // 带超时的 DNS 解析
      const resolver = new dns.Resolver();
      const timeoutPromise = new Promise<string[]>((_, reject) => {
        setTimeout(() => reject(new Error("DNS timeout")), this.config.dnsTimeoutMs);
      });
      const addresses = await Promise.race([
        resolver.resolve4(host),
        timeoutPromise,
      ]);
      if (addresses.length === 0) {
        return { allowed: false, reason: `DNS resolved no addresses for ${host}` };
      }
      resolvedIp = addresses[0];
    } catch (err) {
      // IPv6 fallback
      try {
        const addresses = await dns.resolve6(host);
        if (addresses.length > 0) {
          resolvedIp = addresses[0];
        }
      } catch {
        return {
          allowed: false,
          reason: `DNS resolution failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (!resolvedIp) {
      return { allowed: false, reason: `No IP resolved for ${host}` };
    }

    // DNS 钉制检查
    if (cached && now < cached.expiresAt) {
      if (cached.ip !== resolvedIp) {
        // DNS 重绑定攻击检测
        return {
          allowed: false,
          reason: `DNS rebinding detected: ${host} was ${cached.ip}, now ${resolvedIp}`,
          resolvedIp,
          pinnedIp: cached.ip,
        };
      }
      // 缓存命中且 IP 未变
      return { allowed: true, resolvedIp, pinnedIp: cached.ip };
    }

    // 新缓存或缓存过期：更新
    this.dnsCache.set(host, {
      ip: resolvedIp,
      expiresAt: now + this.config.dnsPinTtlMs,
    });
    return { allowed: true, resolvedIp, pinnedIp: resolvedIp };
  }

  /**
   * 检查 IP 是否符合策略。
   * 顺序：allowlistIPs 优先 > denylistIPs
   */
  private checkIpPolicy(ip: string): boolean {
    // 允许名单优先
    if (this.config.allowlistIPs.length > 0) {
      if (this.matchIpList(ip, this.config.allowlistIPs)) {
        return true;
      }
    }
    // 拒绝名单
    if (this.matchIpList(ip, this.config.denylistIPs)) {
      return false;
    }
    // 若配置了允许名单但 IP 不在其中
    if (this.config.allowlistIPs.length > 0) {
      return false;
    }
    return true;
  }

  /** 匹配 IP 到列表（支持 CIDR）。 */
  private matchIpList(ip: string, list: string[]): boolean {
    for (const entry of list) {
      if (entry.includes("/")) {
        // CIDR 匹配
        if (this.matchCidr(ip, entry)) return true;
      } else if (entry === ip) {
        return true;
      }
    }
    return false;
  }

  /** CIDR 匹配（仅支持 IPv4）。 */
  private matchCidr(ip: string, cidr: string): boolean {
    const [baseIp, prefixStr] = cidr.split("/");
    const prefix = parseInt(prefixStr ?? "32", 10);
    if (prefix < 0 || prefix > 32) return false;
    const ipInt = ipToInt(ip);
    const baseInt = ipToInt(baseIp);
    if (ipInt === null || baseInt === null) return false;
    const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  }

  /** 清理过期的 DNS 缓存条目（防止无界增长）。 */
  pruneDnsCache(): number {
    const now = Date.now();
    let removed = 0;
    for (const [host, entry] of this.dnsCache) {
      if (now >= entry.expiresAt) {
        this.dnsCache.delete(host);
        removed++;
      }
    }
    return removed;
  }

  /** 获取 DNS 缓存大小（用于诊断）。 */
  getDnsCacheSize(): number {
    return this.dnsCache.size;
  }

  /** 清空 DNS 缓存（强制重新解析）。 */
  clearDnsCache(): void {
    this.dnsCache.clear();
  }

  /** 获取当前配置（用于审计）。 */
  getConfig(): Required<NetPolicyConfig> {
    return { ...this.config };
  }
}

/** IP 字符串转 32 位无符号整数（仅 IPv4）。 */
function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}
