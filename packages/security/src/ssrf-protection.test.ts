import { describe, it, expect, beforeEach } from "vitest";
import { SSRFProtection, isPrivateIP, isMetadataEndpoint } from "./ssrf-protection";

describe("SSRFProtection", () => {
  let ssrf: SSRFProtection;

  beforeEach(() => {
    ssrf = new SSRFProtection();
  });

  describe("URL Checking (Sync)", () => {
    it("should reject invalid URLs", () => {
      const result = ssrf.checkURLSync("not-a-valid-url");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid URL format");
    });

    it("should reject non-HTTP protocols", () => {
      const result = ssrf.checkURLSync("file:///etc/passwd");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Unsupported protocol");
    });

    it("should reject FTP URLs", () => {
      const result = ssrf.checkURLSync("ftp://example.com/file");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Unsupported protocol");
    });

    it("should allow normal HTTPS URLs", () => {
      const result = ssrf.checkURLSync("https://example.com/path");
      expect(result.allowed).toBe(true);
    });

    it("should allow normal HTTP URLs", () => {
      const result = ssrf.checkURLSync("http://example.com/path");
      expect(result.allowed).toBe(true);
    });
  });

  describe("IP Checking", () => {
    it("should block localhost (127.0.0.1)", () => {
      const result = ssrf.checkIP("127.0.0.1");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Loopback");
    });

    it("should block 127.0.0.2 (loopback range)", () => {
      const result = ssrf.checkIP("127.0.0.2");
      expect(result.allowed).toBe(false);
    });

    it("should block private IP 10.0.0.1", () => {
      const result = ssrf.checkIP("10.0.0.1");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Private IP");
    });

    it("should block private IP 192.168.1.1", () => {
      const result = ssrf.checkIP("192.168.1.1");
      expect(result.allowed).toBe(false);
    });

    it("should block private IP 172.16.0.1", () => {
      const result = ssrf.checkIP("172.16.0.1");
      expect(result.allowed).toBe(false);
    });

    it("should block 172.31.255.255 (upper bound of 172.16/12)", () => {
      const result = ssrf.checkIP("172.31.255.255");
      expect(result.allowed).toBe(false);
    });

    it("should allow 172.32.0.1 (outside 172.16/12 range)", () => {
      const result = ssrf.checkIP("172.32.0.1");
      expect(result.allowed).toBe(true);
    });

    it("should block link-local 169.254.1.1", () => {
      const result = ssrf.checkIP("169.254.1.1");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Link-local");
    });

    it("should block metadata endpoint 169.254.169.254", () => {
      const result = ssrf.checkIP("169.254.169.254");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Metadata endpoint");
    });

    it("should block IPv6 localhost ::1", () => {
      const result = ssrf.checkIP("::1");
      expect(result.allowed).toBe(false);
    });

    it("should allow public IP 8.8.8.8", () => {
      const result = ssrf.checkIP("8.8.8.8");
      expect(result.allowed).toBe(true);
    });

    it("should allow public IP 1.1.1.1", () => {
      const result = ssrf.checkIP("1.1.1.1");
      expect(result.allowed).toBe(true);
    });

    it("should reject invalid IP format", () => {
      const result = ssrf.checkIP("999.999.999.999");
      expect(result.allowed).toBe(false);
    });
  });

  describe("Allowlist & Blocklist", () => {
    it("should allow hosts in host allowlist", () => {
      const configuredSSRF = new SSRFProtection({
        allowlistHosts: ["internal-api.local"],
      });
      const result = configuredSSRF.checkURLSync("http://internal-api.local/data");
      expect(result.allowed).toBe(true);
    });

    it("should allow IPs in CIDR allowlist", () => {
      const configuredSSRF = new SSRFProtection({
        allowlistCIDRs: ["10.0.0.0/8"],
      });
      const result = configuredSSRF.checkIP("10.0.0.1");
      expect(result.allowed).toBe(true);
    });

    it("should block IPs in custom blocked CIDRs", () => {
      const configuredSSRF = new SSRFProtection({
        blockedCIDRs: ["8.8.8.0/24"],
      });
      const result = configuredSSRF.checkIP("8.8.8.8");
      expect(result.allowed).toBe(false);
    });

    it("should allow disabling private IP blocking", () => {
      const configuredSSRF = new SSRFProtection({
        blockPrivateIPs: false,
      });
      const result = configuredSSRF.checkIP("192.168.1.1");
      expect(result.allowed).toBe(true);
    });

    it("should allow disabling loopback blocking", () => {
      const configuredSSRF = new SSRFProtection({
        blockLoopback: false,
      });
      const result = configuredSSRF.checkIP("127.0.0.1");
      expect(result.allowed).toBe(true);
    });
  });

  describe("Metadata Endpoints", () => {
    it("should block AWS metadata URL by IP", () => {
      const result = ssrf.checkURLSync("http://169.254.169.254/latest/meta-data/");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Metadata endpoint");
    });

    it("should block GCP metadata by hostname (sync)", () => {
      const result = ssrf.checkURLSync("http://metadata.google.internal/");
      expect(result.allowed).toBe(false);
    });

    it("should block Alibaba Cloud metadata", () => {
      const result = ssrf.checkURLSync("http://100.100.100.200/");
      expect(result.allowed).toBe(false);
    });
  });

  describe("Configuration", () => {
    it("should update configuration", () => {
      ssrf.configure({ blockPrivateIPs: false });
      const config = ssrf.getConfig();
      expect(config.blockPrivateIPs).toBe(false);
    });

    it("should return readonly config", () => {
      const config = ssrf.getConfig();
      expect(config.blockPrivateIPs).toBe(true);
      expect(config.blockLoopback).toBe(true);
      expect(config.blockLinkLocal).toBe(true);
    });
  });

  describe("Utility Functions", () => {
    it("isPrivateIP should detect private IPs", () => {
      expect(isPrivateIP("10.0.0.1")).toBe(true);
      expect(isPrivateIP("192.168.1.1")).toBe(true);
      expect(isPrivateIP("172.16.0.1")).toBe(true);
      expect(isPrivateIP("8.8.8.8")).toBe(false);
      expect(isPrivateIP("127.0.0.1")).toBe(true);
    });

    it("isMetadataEndpoint should detect metadata endpoints", () => {
      expect(isMetadataEndpoint("169.254.169.254")).toBe(true);
      expect(isMetadataEndpoint("metadata.google.internal")).toBe(true);
      expect(isMetadataEndpoint("example.com")).toBe(false);
    });
  });
});