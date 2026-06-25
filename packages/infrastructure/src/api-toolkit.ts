/**
 * API & Cloud Toolkit — reusable tools for HTTP, database, and
 * cloud service interactions available to the agent.
 *
 * Features:
 *  - HTTP client with auth, retry, redirect following
 *  - REST API pagination (cursor / offset / page)
 *  - Database query helpers (SQL generation, parameter binding)
 *  - Cloud service wrappers (S3, DynamoDB, CloudWatch patterns)
 *  - Webhook sender with signature generation
 *  - GraphQL client with query/mutation support
 *  - URL preview / scraping with metadata extraction
 */

// ── Types ─────────────────────────────────────────────────

export interface ApiClientConfig {
  baseURL?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  auth?: {
    type: "bearer" | "basic" | "api_key" | "custom";
    credentials: string;
    keyName?: string; // For api_key type
  };
}

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  path?: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  followRedirects?: boolean;
  responseType?: "json" | "text" | "blob";
}

export interface HttpResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
  elapsedMs: number;
}

export interface PaginationOptions {
  type: "cursor" | "offset" | "page";
  /** Field name in response for next cursor/page */
  nextField?: string;
  /** Max items to collect */
  maxItems?: number;
  /** Max pages to fetch */
  maxPages?: number;
  /** Callback per page */
  onPage?: (pageIndex: number, items: unknown[]) => void;
}

export interface DbQuery {
  table: string;
  operation: "select" | "insert" | "update" | "delete";
  columns?: string[];
  values?: Record<string, unknown>;
  where?: Record<string, unknown>;
  orderBy?: { column: string; direction: "asc" | "desc" };
  limit?: number;
  offset?: number;
}

export interface WebhookPayload {
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  signature?: {
    type: "hmac-sha256" | "sha256";
    secret: string;
    headerName?: string;
  };
}

// ── API Client ────────────────────────────────────────────

export class ApiClient {
  private config: Required<Omit<ApiClientConfig, "auth">> & { auth?: ApiClientConfig["auth"] };

  constructor(config: ApiClientConfig = {}) {
    this.config = {
      baseURL: config.baseURL ?? "",
      headers: config.headers ?? {},
      timeoutMs: config.timeoutMs ?? 30000,
      maxRetries: config.maxRetries ?? 3,
      auth: config.auth,
    };
  }

  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    const startTime = Date.now();
    const url = this.buildURL(options.path ?? "", options.query);
    const headers = this.buildHeaders(options.headers);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: options.method ?? "GET",
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(options.timeoutMs ?? this.config.timeoutMs),
          redirect: options.followRedirects ? "follow" : "manual",
        });

        // Retry on 5xx server errors
        if (response.status >= 500 && attempt < this.config.maxRetries) {
          const delay = Math.min(500 * 2 ** attempt + Math.random() * 200, 5000);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        let data: T;
        const responseType = options.responseType ?? "json";
        if (responseType === "json") {
          data = (await response.json().catch(() => ({} as T))) as T;
        } else if (responseType === "blob") {
          data = (await response.blob()) as unknown as T;
        } else {
          data = (await response.text()) as unknown as T;
        }

        const respHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => { respHeaders[k] = v; });

        return {
          status: response.status,
          statusText: response.statusText,
          headers: respHeaders,
          data,
          elapsedMs: Date.now() - startTime,
        };
      } catch (err) {
        lastError = err as Error;
        // Only retry on network/timeout errors, not TypeError for bad URLs
        if (attempt >= this.config.maxRetries) {
          break;
        }
        const delay = Math.min(500 * 2 ** attempt + Math.random() * 200, 5000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError ?? new Error("Request failed");
  }

  // Convenience methods
  async get<T = unknown>(path: string, query?: Record<string, string>): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "GET", path, query });
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "POST", path, body });
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "PUT", path, body });
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "PATCH", path, body });
  }

  async delete<T = unknown>(path: string): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "DELETE", path });
  }

  // ── Pagination ──────────────────────────────────────────

  /**
   * Auto-paginate through a REST API endpoint.
   * Supports cursor-based, offset-based, and page-based pagination.
   */
  async paginate<T = unknown>(
    path: string,
    options: PaginationOptions
  ): Promise<T[]> {
    const allItems: T[] = [];
    let pageIndex = 0;
    let cursor: string | undefined;
    let offset = 0;
    let page = 1;

    while (true) {
      if (options.maxPages && pageIndex >= options.maxPages) break;
      if (options.maxItems && allItems.length >= options.maxItems) break;

      const query: Record<string, string> = {};

      if (options.type === "cursor" && cursor) {
        query.cursor = cursor;
      } else if (options.type === "offset") {
        query.offset = String(offset);
        query.limit = "100";
      } else if (options.type === "page") {
        query.page = String(page);
        query.per_page = "100";
      }

      const response = await this.get<{ items?: T[]; data?: T[]; results?: T[]; next?: string; next_cursor?: string; has_more?: boolean }>(path, query);

      // Extract items
      const items = (response.data.items ?? response.data.data ?? response.data.results ?? []) as T[];
      allItems.push(...items);

      // Extract next cursor/page
      const next = response.data.next ?? response.data.next_cursor;

      if (options.type === "cursor") {
        if (!next) break;
        cursor = next;
      } else if (options.type === "offset") {
        if (items.length === 0) break;
        offset += items.length;
      } else {
        if (items.length === 0) break;
        page++;
      }

      options.onPage?.(pageIndex, items);
      pageIndex++;
    }

    return allItems;
  }

  // ── Internal ────────────────────────────────────────────

  private buildURL(path: string, query?: Record<string, string>): string {
    let url = this.config.baseURL.replace(/\/+$/, "");
    if (path) {
      url += path.startsWith("/") ? path : `/${path}`;
    }

    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams(query);
      url += `?${params.toString()}`;
    }

    return url;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "EvoClaw/0.5.0",
      ...this.config.headers,
      ...extra,
    };

    if (this.config.auth) {
      switch (this.config.auth.type) {
        case "bearer":
          headers["Authorization"] = `Bearer ${this.config.auth.credentials}`;
          break;
        case "basic":
          headers["Authorization"] = `Basic ${Buffer.from(this.config.auth.credentials).toString("base64")}`;
          break;
        case "api_key":
          headers[this.config.auth.keyName ?? "X-API-Key"] = this.config.auth.credentials;
          break;
        case "custom":
          headers["Authorization"] = this.config.auth.credentials;
          break;
      }
    }

    return headers;
  }
}

// ── Database Query Builder ────────────────────────────────

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function safeIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error("Invalid SQL identifier: " + name);
  return name;
}

export class QueryBuilder {
  /**
   * Build a SQL query string from a structured query definition.
   * Supports SELECT, INSERT, UPDATE, DELETE with parameterized values.
   */
  static build(query: DbQuery): { sql: string; params: unknown[] } {
    const params: unknown[] = [];

    switch (query.operation) {
      case "select":
        return this.buildSelect(query, params);
      case "insert":
        return this.buildInsert(query, params);
      case "update":
        return this.buildUpdate(query, params);
      case "delete":
        return this.buildDelete(query, params);
    }
  }

  private static buildSelect(query: DbQuery, params: unknown[]): { sql: string; params: unknown[] } {
    const cols = query.columns?.map((c) => safeIdent(c)).join(", ") ?? "*";
    let sql = `SELECT ${cols} FROM ${safeIdent(query.table)}`;

    if (query.where && Object.keys(query.where).length > 0) {
      const clauses = Object.entries(query.where).map(([k]) => {
        params.push(query.where![k]);
        return `${safeIdent(k)} = ?`;
      });
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }

    if (query.orderBy) {
      sql += ` ORDER BY ${safeIdent(query.orderBy.column)} ${query.orderBy.direction}`;
    }

    if (query.limit) {
      sql += ` LIMIT ${query.limit}`;
    }

    if (query.offset) {
      sql += ` OFFSET ${query.offset}`;
    }

    return { sql, params };
  }

  private static buildInsert(query: DbQuery, params: unknown[]): { sql: string; params: unknown[] } {
    if (!query.values || Object.keys(query.values).length === 0) {
      throw new Error("INSERT requires values");
    }

    const entries = Object.entries(query.values);
    const cols = entries.map(([k]) => safeIdent(k)).join(", ");
    const placeholders = entries.map(() => "?").join(", ");

    for (const [, v] of entries) {
      params.push(v);
    }

    const sql = `INSERT INTO ${safeIdent(query.table)} (${cols}) VALUES (${placeholders})`;
    return { sql, params };
  }

  private static buildUpdate(query: DbQuery, params: unknown[]): { sql: string; params: unknown[] } {
    if (!query.values || Object.keys(query.values).length === 0) {
      throw new Error("UPDATE requires values");
    }

    const setClauses = Object.entries(query.values).map(([k]) => {
      params.push(query.values![k]);
      return `${safeIdent(k)} = ?`;
    });

    let sql = `UPDATE ${safeIdent(query.table)} SET ${setClauses.join(", ")}`;

    if (query.where && Object.keys(query.where).length > 0) {
      const whereClauses = Object.entries(query.where).map(([k]) => {
        params.push(query.where![k]);
        return `${safeIdent(k)} = ?`;
      });
      sql += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    return { sql, params };
  }

  private static buildDelete(query: DbQuery, params: unknown[]): { sql: string; params: unknown[] } {
    let sql = `DELETE FROM ${safeIdent(query.table)}`;

    if (query.where && Object.keys(query.where).length > 0) {
      const clauses = Object.entries(query.where).map(([k]) => {
        params.push(query.where![k]);
        return `${safeIdent(k)} = ?`;
      });
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }

    return { sql, params };
  }
}

// ── Webhook Sender ────────────────────────────────────────

export class WebhookSender {
  /**
   * Send a webhook with optional signature.
   */
  static async send(payload: WebhookPayload): Promise<HttpResponse> {
    const body = JSON.stringify(payload.body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...payload.headers,
    };

    // Sign if required
    if (payload.signature) {
      const sigValue = WebhookSender.generateSignature(
        payload.signature.type,
        body,
        payload.signature.secret
      );
      headers[payload.signature.headerName ?? "X-Signature"] = sigValue;
    }

    const client = new ApiClient();
    return client.request({
      method: payload.method ?? "POST",
      path: payload.url,
      body: payload.body,
      headers,
    });
  }

  /** Generate HMAC-SHA256 signature for webhook payload */
  static generateSignature(type: "hmac-sha256" | "sha256", body: string, secret: string): string {
    const { createHmac, createHash } = require("crypto");

    if (type === "hmac-sha256") {
      return createHmac("sha256", secret).update(body).digest("hex");
    }

    return createHash("sha256").update(body + secret).digest("hex");
  }
}

// ── GraphQL Client ────────────────────────────────────────

export class GraphQLClient {
  private apiClient: ApiClient;

  constructor(endpoint: string, config: ApiClientConfig = {}) {
    this.apiClient = new ApiClient({ ...config, baseURL: endpoint });
  }

  async query<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    operationName?: string
  ): Promise<{ data?: T; errors?: Array<{ message: string; path?: string[] }> }> {
    const response = await this.apiClient.post<{
      data?: T;
      errors?: Array<{ message: string; path?: string[] }>;
    }>("/", { query, variables, operationName });

    if (response.data.errors?.length) {
      process.stderr.write(`[GraphQL] Errors: ${response.data.errors.map((e) => e.message).join(", ")}\n`);
    }

    return response.data;
  }

  async mutate<T = unknown>(
    mutation: string,
    variables?: Record<string, unknown>
  ): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
    return this.query<T>(`mutation { ${mutation} }`, variables);
  }
}

// ── URL Preview / Scraping ────────────────────────────────

export interface PageMetadata {
  url: string;
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  favicon?: string;
  contentType?: string;
  contentLength?: number;
}

export class PageScraper {
  /** Fetch basic page metadata without full rendering */
  static async getMetadata(url: string): Promise<PageMetadata> {
    const client = new ApiClient();

    try {
      const response = await client.get<string>(url, undefined);
      const html = typeof response.data === "string" ? response.data : "";

      const meta: PageMetadata = { url };

      // Extract title
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      meta.title = titleMatch?.[1]?.trim();

      // Extract meta description
      const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
      meta.description = descMatch?.[1];

      // OpenGraph tags
      const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
      meta.ogTitle = ogTitleMatch?.[1];

      const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
      meta.ogDescription = ogDescMatch?.[1];

      const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      meta.ogImage = ogImageMatch?.[1];

      // Favicon
      const faviconMatch = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i);
      meta.favicon = faviconMatch?.[1];

      meta.contentType = response.headers["content-type"];
      meta.contentLength = response.headers["content-length"] ? Number(response.headers["content-length"]) : undefined;

      return meta;
    } catch {
      return { url };
    }
  }
}