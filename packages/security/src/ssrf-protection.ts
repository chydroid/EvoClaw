/**
 * SSRF Protection — prevents Server-Side Request Forgery attacks.
 *
 * Blocks requests to internal/private IPs, localhost, and metadata endpoints.
 * Supports both URL validation (pre-request) and runtime checks.
 *
 * Features:
 * - Blocks private IP ranges (10.x, 172.16-31.x, 192.168.x)
 * - Blocks loopback addresses (127.x, ::1)
 * - Blocks link-local addresses (169.254.x)
 * - Blocks cloud metadata endpoints (169.254.169.254)
 * - Configurable allowlist for specific hosts
 * - DNS rebinding protection via resolved IP check
 */

import { isIP } from "node:net";
import { URL } from "node:url";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SSRFConfig {
  /** Allowlisted hostnames (exact match, bypasses all checks) */
  allowlistHosts: string[];
  /** Allowlisted IP ranges in CIDR notation */
  allowlistCIDRs: string[];
  /** Whether to block private IP ranges */
  blockPrivateIPs: boolean;
  /** Whether to block loopback addresses */
  blockLoopback: boolean;
  /** Whether to block link-local addresses */
  blockLinkLocal: boolean;
  /** Whether to block cloud metadata endpoints */
  blockMetadataEndpoints: boolean;
  /** Whether to perform DNS resolution and re-check */
  checkDNSRebinding: boolean;
  /** Custom blocked CIDRs */
  blockedCIDRs: string[];
  /** Timeout for DNS resolution (ms) */
  dnsTimeoutMs: number;
}

export interface SSRFCheckResult {
  allowed: boolean;
  reason?: string;
  resolvedIP?: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SSRFConfig = {
  allowlistHosts: [],
  allowlistCIDRs: [],
  blockPrivateIPs: true,
  blockLoopback: true,
  blockLinkLocal: true,
  blockMetadataEndpoints: true,
  checkDNSRebinding: true,
  blockedCIDRs: [],
  dnsTimeoutMs: 5000,
};

// ─── Private / Reserved IP Ranges ─────────────────────────────────────────────

const PRIVATE_IP_RANGES = [
  { start: ipToInt("10.0.0.0"), end: ipToInt("10.255.255.255") },
  { start: ipToInt("172.16.0.0"), end: ipToInt("172.31.255.255") },
  { start: ipToInt("192.168.0.0"), end: ipToInt("192.168.255.255") },
];

const LOOPBACK_RANGES = [
  { start: ipToInt("127.0.0.0"), end: ipToInt("127.255.255.255") },
];

const LINK_LOCAL_RANGE = [
  { start: ipToInt("169.254.0.0"), end: ipToInt("169.254.255.255") },
];

const METADATA_ENDPOINTS = [
  "169.254.169.254",  // AWS / GCP / Azure metadata
  "metadata.google.internal",  // GCP
  "100.100.100.200",  // Alibaba Cloud
];

// ─── Main Class ───────────────────────────────────────────────────────────────

export class SSRFProtection {
  private config: SSRFConfig;

  constructor(config?: Partial<SSRFConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a URL is safe to request.
   * Returns { allowed: true } or { allowed: false, reason: "..." }
   */
  async checkURL(urlString: string): Promise<SSRFCheckResult> {
    let parsed: URL;

    try {
      parsed = new URL(urlString);
    } catch {
      return { allowed: false, reason: "Invalid URL format" };
    }

    // Only check HTTP/HTTPS
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { allowed: false, reason: `Unsupported protocol: ${parsed.protocol}` };
    }

    const hostname = parsed.hostname.toLowerCase();

    // 1. Check allowlist hostnames
    if (this.config.allowlistHosts.includes(hostname)) {
      return { allowed: true };
    }

    // 2. Check if hostname is an IP address
    if (isIP(hostname)) {
      return this.checkIP(hostname);
    }

    // 3. Check for metadata endpoints by hostname
    if (this.config.blockMetadataEndpoints) {
      if (METADATA_ENDPOINTS.includes(hostname)) {
        return { allowed: false, reason: `Metadata endpoint blocked: ${hostname}` };
      }
    }

    // 4. DNS rebinding check
    if (this.config.checkDNSRebinding) {
      return this.checkDNS(hostname);
    }

    return { allowed: true };
  }

  /**
   * Check if an IP address is allowed.
   */
  checkIP(ip: string): SSRFCheckResult {
    const ipInt = ipToInt(ip);
    if (ipInt === null) {
      return { allowed: false, reason: `Invalid IP: ${ip}` };
    }

    // Check allowlist CIDRs
    for (const cidr of this.config.allowlistCIDRs) {
      const { network, prefix } = parseCIDR(cidr);
      const networkInt = ipToInt(network);
      if (networkInt === null) continue;
      const mask = ~((1 << (32 - prefix)) - 1);
      if ((ipInt & mask) === (networkInt & mask)) {
        return { allowed: true };
      }
    }

    // Check blocked CIDRs
    for (const cidr of this.config.blockedCIDRs) {
      const { network, prefix } = parseCIDR(cidr);
      const networkInt = ipToInt(network);
      if (networkInt === null) continue;
      const mask = ~((1 << (32 - prefix)) - 1);
      if ((ipInt & mask) === (networkInt & mask)) {
        return { allowed: false, reason: `IP blocked by custom rule: ${ip} matches ${cidr}` };
      }
    }

    // IPv6 special handling
    if (isIPv6(ip)) {
      if (ip === "::1") {
        return { allowed: false, reason: "IPv6 loopback blocked: ::1" };
      }
      // Allow IPv6 generally (private ranges are more complex for IPv6)
      return { allowed: true };
    }

    // Check private ranges
    if (this.config.blockPrivateIPs) {
      for (const range of PRIVATE_IP_RANGES) {
        if (ipInt >= range.start! && ipInt <= range.end!) {
          return { allowed: false, reason: `Private IP blocked: ${ip}` };
        }
      }
    }

    // Check loopback
    if (this.config.blockLoopback) {
      for (const range of LOOPBACK_RANGES) {
        if (ipInt >= range.start! && ipInt <= range.end!) {
          return { allowed: false, reason: `Loopback IP blocked: ${ip}` };
        }
      }
    }

    // Check metadata endpoint IPs (before link-local to give more specific reason)
    if (this.config.blockMetadataEndpoints) {
      for (const endpoint of METADATA_ENDPOINTS) {
        if (isIP(endpoint)) {
          const endpointInt = ipToInt(endpoint);
          if (endpointInt === ipInt) {
            return { allowed: false, reason: `Metadata endpoint blocked: ${ip}` };
          }
        }
      }
    }

    // Check link-local
    if (this.config.blockLinkLocal) {
      for (const range of LINK_LOCAL_RANGE) {
        if (ipInt >= range.start! && ipInt <= range.end!) {
          return { allowed: false, reason: `Link-local IP blocked: ${ip}` };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Resolve hostname via DNS and check the resolved IP.
   */
  private async checkDNS(hostname: string): Promise<SSRFCheckResult> {
    const { promises: dns } = await import("node:dns");

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.dnsTimeoutMs);

      const addresses = await dns.resolve4(hostname);
      clearTimeout(timeout);

      if (addresses.length === 0) {
        return { allowed: false, reason: `DNS resolution returned no addresses for: ${hostname}` };
      }

      // Check each resolved IP
      for (const addr of addresses) {
        const result = this.checkIP(addr);
        if (!result.allowed) {
          return {
            allowed: false,
            reason: `DNS rebinding detected: ${hostname} → ${addr} (${result.reason})`,
            resolvedIP: addr,
          };
        }
      }

      return { allowed: true, resolvedIP: addresses[0] };
    } catch (err) {
      // DNS resolution failure — block by default
      const msg = err instanceof Error ? err.message : String(err);
      return { allowed: false, reason: `DNS resolution failed for ${hostname}: ${msg}` };
    }
  }

  /**
   * Update configuration.
   */
  configure(updates: Partial<SSRFConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Get current configuration.
   */
  getConfig(): Readonly<SSRFConfig> {
    return { ...this.config };
  }

  /**
   * Sync version — validates URL without DNS resolution.
   * Useful for quick pre-screening.
   */
  checkURLSync(urlString: string): SSRFCheckResult {
    let parsed: URL;

    try {
      parsed = new URL(urlString);
    } catch {
      return { allowed: false, reason: "Invalid URL format" };
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { allowed: false, reason: `Unsupported protocol: ${parsed.protocol}` };
    }

    const hostname = parsed.hostname.toLowerCase();

    if (this.config.allowlistHosts.includes(hostname)) {
      return { allowed: true };
    }

    if (isIP(hostname)) {
      return this.checkIP(hostname);
    }

    if (this.config.blockMetadataEndpoints) {
      if (METADATA_ENDPOINTS.includes(hostname)) {
        return { allowed: false, reason: `Metadata endpoint blocked: ${hostname}` };
      }
    }

    // Without DNS resolution, assume safe (will be checked at runtime)
    return { allowed: true };
  }
}

// ─── IP Math Helpers ──────────────────────────────────────────────────────────

function ipToInt(ip: string): number | null {
  if (isIPv6(ip)) return null; // IPv6 not supported in int conversion

  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    result = (result << 8) | num;
  }
  return result >>> 0; // Convert to unsigned
}

function isIPv6(ip: string): boolean {
  return ip.includes(":");
}

function parseCIDR(cidr: string): { network: string; prefix: number } {
  const [network, prefixStr] = cidr.split("/");
  return {
    network: network.trim(),
    prefix: parseInt(prefixStr, 10) || 32,
  };
}

// ─── Dedicated IP Check Helpers ─────────────────────────────────────────────────

/**
 * Quick check: is this IP address private/internal?
 */
export function isPrivateIP(ip: string): boolean {
  if (isIPv6(ip)) {
    // Check for unique local address (fc00::/7) and link-local (fe80::/10)
    if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) {
      return true;
    }
    return ip === "::1";
  }

  const ipInt = ipToInt(ip);
  if (ipInt === null) return false;

  // Check private ranges
  for (const range of PRIVATE_IP_RANGES) {
    if (ipInt >= range.start! && ipInt <= range.end!) return true;
  }

  // Check loopback
  for (const range of LOOPBACK_RANGES) {
    if (ipInt >= range.start! && ipInt <= range.end!) return true;
  }

  // Check link-local
  for (const range of LINK_LOCAL_RANGE) {
    if (ipInt >= range.start! && ipInt <= range.end!) return true;
  }

  return false;
}

/**
 * Quick check: is this a known cloud metadata IP?
 */
export function isMetadataEndpoint(host: string): boolean {
  return METADATA_ENDPOINTS.includes(host);
}