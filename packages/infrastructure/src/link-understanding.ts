/**
 * Link Understanding System — OpenClaw compatibility layer.
 *
 * Analyzes URLs shared in conversations:
 *   - Title & description extraction from HTML meta tags
 *   - Open Graph / Twitter Card metadata parsing
 *   - Content-type detection (article, video, image, etc.)
 *   - Safe link preview with configurable max fetch size
 *   - Domain allowlist/denylist for security
 *
 * This provides rich link previews so the agent can understand
 * what a link contains without the LLM having to blindly fetch it.
 */
import * as https from "https";
import * as http from "http";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image?: string;
  favicon?: string;
  siteName?: string;
  contentType: string;
  mediaType?: "article" | "video" | "image" | "audio" | "page";
  estimatedReadTime?: number;
  statusCode: number;
  fetchDurationMs: number;
  error?: string;
}

export interface LinkUnderstandingConfig {
  /** Max response size in bytes (default 1MB) */
  maxFetchBytes?: number;
  /** Request timeout in ms (default 10s) */
  timeoutMs?: number;
  /** User-Agent header */
  userAgent?: string;
  /** Allowed domains (glob patterns). If empty, all allowed. */
  allowedDomains?: string[];
  /** Blocked domains (glob patterns) */
  blockedDomains?: string[];
  /** Whether to follow redirects (default true) */
  followRedirects?: boolean;
  /** Max redirect depth */
  maxRedirects?: number;
}

const DEFAULT_CONFIG: Required<Omit<LinkUnderstandingConfig, "allowedDomains" | "blockedDomains">> = {
  maxFetchBytes: 1_048_576, // 1 MB
  timeoutMs: 10_000,
  userAgent: "EvoClaw-LinkPreview/1.0",
  followRedirects: true,
  maxRedirects: 3,
};

// ──────────────────────────────────────────────────────────────
// LinkPreviewer
// ──────────────────────────────────────────────────────────────

export class LinkPreviewer {
  private config: Required<Omit<LinkUnderstandingConfig, "allowedDomains" | "blockedDomains">>;
  private allowedDomains: string[];
  private blockedDomains: string[];

  constructor(config: LinkUnderstandingConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.allowedDomains = config.allowedDomains ?? [];
    this.blockedDomains = config.blockedDomains ?? [];
  }

  /**
   * Fetch and parse a link preview.
   */
  async fetch(url: string): Promise<LinkPreview> {
    const start = Date.now();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        url,
        title: "",
        description: "",
        contentType: "",
        statusCode: 0,
        fetchDurationMs: Date.now() - start,
        error: "Invalid URL",
      };
    }

    // Domain filtering
    if (!this.isDomainAllowed(parsed.hostname)) {
      return {
        url,
        title: "",
        description: "",
        contentType: "",
        statusCode: 0,
        fetchDurationMs: Date.now() - start,
        error: "Domain not allowed",
      };
    }

    return this.fetchWithRedirects(url, 0, start);
  }

  /**
   * Batch-fetch multiple link previews.
   */
  async fetchMany(urls: string[]): Promise<LinkPreview[]> {
    return Promise.all(urls.map((u) => this.fetch(u)));
  }

  // ── Internals ──

  private isDomainAllowed(hostname: string): boolean {
    if (this.blockedDomains.length > 0) {
      if (this.blockedDomains.some((p) => globMatch(p, hostname))) return false;
    }
    if (this.allowedDomains.length > 0) {
      return this.allowedDomains.some((p) => globMatch(p, hostname));
    }
    return true;
  }

  private async fetchWithRedirects(
    url: string,
    depth: number,
    start: number,
  ): Promise<LinkPreview> {
    if (depth >= this.config.maxRedirects) {
      return {
        url,
        title: "",
        description: "",
        contentType: "",
        statusCode: 0,
        fetchDurationMs: Date.now() - start,
        error: "Too many redirects",
      };
    }

    return new Promise((resolve) => {
      const transport = url.startsWith("https") ? https : http;

      const req = transport.get(
        url,
        {
          headers: { "User-Agent": this.config.userAgent },
          timeout: this.config.timeoutMs,
        },
        (res) => {
          // Handle redirect
          if (
            this.config.followRedirects &&
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const redirectUrl = new URL(
              res.headers.location,
              url,
            ).toString();
            if (!this.isDomainAllowed(new URL(redirectUrl).hostname)) {
              resolve({
                url: redirectUrl,
                title: "",
                description: "",
                contentType: "",
                statusCode: res.statusCode || 0,
                fetchDurationMs: Date.now() - start,
                error: "Redirect to disallowed domain",
              });
              return;
            }
            resolve(this.fetchWithRedirects(redirectUrl, depth + 1, start));
            return;
          }

          const chunks: Buffer[] = [];
          let totalBytes = 0;

          res.on("data", (chunk: Buffer) => {
            if (totalBytes < this.config.maxFetchBytes) {
              chunks.push(chunk);
              totalBytes += chunk.length;
            } else {
              res.destroy();
            }
          });

          res.on("end", () => {
            const html = Buffer.concat(chunks).toString("utf-8");
            const parsedUrl = new URL(url);

            const preview: LinkPreview = {
              url,
              title: extractTitle(html),
              description: extractMeta(html, "description"),
              image: extractMeta(html, "og:image") || extractMeta(html, "twitter:image"),
              siteName:
                extractMeta(html, "og:site_name") || parsedUrl.hostname,
              contentType:
                res.headers["content-type"]?.split(";")[0] || "text/html",
              statusCode: res.statusCode || 0,
              fetchDurationMs: Date.now() - start,
            };

            // Detect media type
            const ogType = extractMeta(html, "og:type");
            if (ogType && ogType.includes("video")) {
              preview.mediaType = "video";
            } else if (preview.image && !preview.description) {
              preview.mediaType = "image";
            } else if (preview.description) {
              preview.mediaType = "article";
            }

            // Estimate read time (avg 238 wpm)
            if (preview.description) {
              const totalText = extractText(html);
              const totalWords = totalText.split(/\s+/).length;
              preview.estimatedReadTime = Math.ceil(totalWords / 238);
            }

            resolve(preview);
          });

          res.on("error", () => {
            resolve({
              url,
              title: "",
              description: "",
              contentType: "",
              statusCode: res.statusCode || 0,
              fetchDurationMs: Date.now() - start,
              error: "Stream error",
            });
          });
        },
      );

      req.on("timeout", () => {
        req.destroy();
        resolve({
          url,
          title: "",
          description: "",
          contentType: "",
          statusCode: 0,
          fetchDurationMs: Date.now() - start,
          error: "Timeout",
        });
      });

      req.on("error", (err) => {
        resolve({
          url,
          title: "",
          description: "",
          contentType: "",
          statusCode: 0,
          fetchDurationMs: Date.now() - start,
          error: err.message,
        });
      });
    });
  }
}

// ──────────────────────────────────────────────────────────────
// HTML Parsers (lightweight, no DOM)
// ──────────────────────────────────────────────────────────────

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].trim()) : "";
}

function extractMeta(html: string, prop: string): string {
  // Multiple meta formats:
  // <meta name="X" content="Y">
  // <meta property="X" content="Y">
  // <meta itemprop="X" content="Y">
  const patterns = [
    new RegExp(`<meta\\s[^>]*?(?:name|property|itemprop)\\s*=\\s*["']${escapeRegExp(prop)}["'][^>]*?content\\s*=\\s*["']([^"']+)["']`, "i"),
    new RegExp(`<meta\\s[^>]*?content\\s*=\\s*["']([^"']+)["'][^>]*?(?:name|property|itemprop)\\s*=\\s*["']${escapeRegExp(prop)}["']`, "i"),
    // Twitter card format: <meta name="twitter:title" content="..." />
    new RegExp(`<meta\\s[^>]*?name\\s*=\\s*["']twitter:${escapeRegExp(prop.replace("twitter:", ""))}["'][^>]*?content\\s*=\\s*["']([^"']+)["']`, "i"),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return decodeHtmlEntities(match[1].trim());
    }
  }

  return "";
}

function extractText(html: string): string {
  // Very rough text extraction — strip tags
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globMatch(pattern: string, value: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
      "$",
    "i",
  );
  return regex.test(value);
}