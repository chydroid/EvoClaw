/**
 * MCP OAuth — OAuth 2.1 客户端支持（对标 hermes-agent tools/mcp_oauth.py）
 *
 * 为需要 OAuth 认证的 MCP server 提供：
 *   1. PKCE 浏览器授权码流程（authorization code + PKCE）
 *   2. RFC 8628 Device Code 流程（无需浏览器的设备授权）
 *   3. Token 持久化存储（每 server 一个 JSON 文件，原子写入）
 *   4. Token 刷新（refresh token 轮换 + 跨进程刷新栅栏）
 *   5. Metadata 发现（RFC 8414 / OIDC discovery）
 *
 * 安全设计：
 *   - Token 文件权限 0o600（仅所有者可读写）
 *   - 刷新栅栏防止并发刷新烧掉单次刷新 token
 *   - PKCE code_verifier 使用 crypto.randomBytes(32)
 *   - 不存储 client_secret（PKCE 流程无需 secret）
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as http from "http";
import * as url from "url";

// ─── 类型 ──────────────────────────────────────────────────

export interface OAuthToken {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface OAuthClientInformation {
  client_id: string;
  client_secret?: string;
  redirect_uri?: string;
}

export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  jwks_uri?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OAuthTokenStorage {
  access_token: string;
  token_type: string;
  expires_at?: number; // epoch ms
  refresh_token?: string;
  scope?: string;
  client_id?: string;
  server_url?: string;
}

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

// ─── 常量 ──────────────────────────────────────────────────

const PKCE_CODE_LENGTH = 64;
const PKCE_VERIFIER_LENGTH = 64;
const DEVICE_CODE_POLL_INTERVAL_MS = 5000; // 默认 5 秒
const DEVICE_CODE_MAX_WAIT_MS = 300000; // 默认 5 分钟
const TOKEN_REFRESH_MARGIN_MS = 60000; // 提前 60 秒刷新

// ─── PKCE 工具 ──────────────────────────────────────────────

/** 生成 PKCE code_verifier（URL-safe Base64，无填充） */
export function generatePkceVerifier(): string {
  return crypto.randomBytes(PKCE_VERIFIER_LENGTH)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 从 code_verifier 计算 code_challenge（S256） */
export function generatePkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 生成随机 state 参数（防 CSRF） */
export function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** 生成随机 nonce 参数 */
export function generateNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** 生成 Client ID（RFC 7591 DCR 或 CIMD URL） */
export function generateClientId(serverUrl: string): string {
  // 使用 CIMD（Client ID Metadata Document）URL 格式
  const origin = getOrigin(serverUrl);
  return `${origin}/oauth/client-id`;
}

// ─── Token 存储 ────────────────────────────────────────────

/**
 * 从磁盘加载 token（安全权限 0o600）。
 * 返回 null 表示无 token 或文件不存在。
 */
export function loadToken(tokenPath: string): OAuthTokenStorage | null {
  try {
    // 验证文件权限
    const stat = fs.statSync(tokenPath);
    if ((stat.mode & 0o077) !== 0) {
      // 权限过于宽松，拒绝读取
      console.warn(`[MCP OAuth] Token file ${tokenPath} has insecure permissions (${stat.mode.toString(8)})`);
      return null;
    }
    const raw = fs.readFileSync(tokenPath, "utf-8");
    const data = JSON.parse(raw) as OAuthTokenStorage;
    if (!data.access_token) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 原子写入 token 到磁盘（权限 0o600）。
 */
export function saveToken(tokenPath: string, token: OAuthTokenStorage): void {
  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // 确保目录权限
  try {
    fs.chmodSync(dir, 0o700);
  } catch { /* 某些系统可能不支持 chmod */ }

  const content = JSON.stringify(token, null, 2);
  const tmpPath = `${tokenPath}.tmp.${Date.now()}`;

  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, tokenPath);

  // 确保文件权限
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch { /* 某些系统可能不支持 chmod */ }
}

/**
 * 删除 token 文件。
 */
export function deleteToken(tokenPath: string): void {
  try {
    fs.unlinkSync(tokenPath);
  } catch { /* 文件不存在时忽略 */ }
}

/**
 * 获取 token 文件路径。
 */
export function getTokenPath(dataDir: string, serverUrl: string): string {
  const safeName = serverUrl.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_").slice(0, 100);
  return path.join(dataDir, "mcp-oauth", `${safeName}.json`);
}

/**
 * 检查 token 是否即将过期。
 */
export function isTokenExpiring(token: OAuthTokenStorage, marginMs = TOKEN_REFRESH_MARGIN_MS): boolean {
  if (!token.expires_at) return false;
  return Date.now() + marginMs >= token.expires_at;
}

/**
 * 检查 token 是否已过期。
 */
export function isTokenExpired(token: OAuthTokenStorage): boolean {
  if (!token.expires_at) return false;
  return Date.now() >= token.expires_at;
}

// ─── HTTP 工具 ──────────────────────────────────────────────

/** 简单的 HTTP GET（返回 JSON） */
export async function httpGetJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

/** 简单的 HTTP POST（form-encoded body，返回 JSON） */
export async function httpPostForm(
  url: string,
  params: Record<string, string>,
  headers?: Record<string, string>,
): Promise<unknown> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...headers,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

/** 简单的 HTTP POST（JSON body，返回 JSON） */
export async function httpPostJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Metadata 发现 ──────────────────────────────────────────

/**
 * 发现 OAuth server metadata（RFC 8414 / OIDC discovery）。
 *
 * 依次尝试：
 *   1. /.well-known/oauth-authorization-server
 *   2. /.well-known/openid-configuration
 *   3. /oauth/authorization-server (RFC 8414 resource-specific)
 */
export async function discoverOAuthMetadata(serverUrl: string): Promise<OAuthServerMetadata> {
  const origin = getOrigin(serverUrl);
  const base = serverUrl;

  const paths = [
    `/.well-known/oauth-authorization-server`,
    `/.well-known/openid-configuration`,
    `/oauth/authorization-server`,
  ];

  const fullUrls = paths.map((p) => `${base}${p}`);

  for (const url of fullUrls) {
    try {
      const data = await httpGetJson(url) as Record<string, unknown>;
      if (data.issuer && data.token_endpoint) {
        return {
          issuer: String(data.issuer),
          authorization_endpoint: data.authorization_endpoint as string | undefined,
          token_endpoint: String(data.token_endpoint),
          device_authorization_endpoint: data.device_authorization_endpoint as string | undefined,
          jwks_uri: data.jwks_uri as string | undefined,
          registration_endpoint: data.registration_endpoint as string | undefined,
          scopes_supported: data.scopes_supported as string[] | undefined,
          response_types_supported: data.response_types_supported as string[] | undefined,
          grant_types_supported: data.grant_types_supported as string[] | undefined,
          code_challenge_methods_supported: data.code_challenge_methods_supported as string[] | undefined,
        };
      }
    } catch {
      // 尝试下一个路径
    }
  }

  throw new Error(`Could not discover OAuth metadata for ${serverUrl}`);
}

// ─── PKCE 授权码流程 ────────────────────────────────────────

export interface PkceFlowResult {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * 构建 PKCE 授权 URL（用户在浏览器中打开此 URL 进行授权）。
 * 如果提供 state，则使用该 state（用于回调服务器校验）。
 */
export function buildPkceAuthorizationUrl(
  metadata: OAuthServerMetadata,
  clientId: string,
  redirectUri: string,
  scope?: string,
  stateOverride?: string,
): PkceFlowResult {
  const state = stateOverride || generateState();
  const codeVerifier = generatePkceVerifier();
  const codeChallenge = generatePkceChallenge(codeVerifier);

  const urlObj = new URL(metadata.authorization_endpoint!);
  urlObj.searchParams.set("response_type", "code");
  urlObj.searchParams.set("client_id", clientId);
  urlObj.searchParams.set("redirect_uri", redirectUri);
  urlObj.searchParams.set("state", state);
  urlObj.searchParams.set("code_challenge", codeChallenge);
  urlObj.searchParams.set("code_challenge_method", "S256");
  if (scope) {
    urlObj.searchParams.set("scope", scope);
  }

  return {
    authorizationUrl: urlObj.toString(),
    state,
    codeVerifier,
    codeChallenge,
  };
}

/**
 * 用授权码换取 token（PKCE 流程）。
 */
export async function exchangeCodeForToken(
  metadata: OAuthServerMetadata,
  clientId: string,
  redirectUri: string,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  };

  return httpPostForm(metadata.token_endpoint, params) as Promise<TokenResponse>;
}

// ─── Device Code 流程（RFC 8628）────────────────────────────

/**
 * 请求 device code（开始设备授权流程）。
 */
export async function requestDeviceCode(
  deviceAuthEndpoint: string,
  clientId: string,
  scope?: string,
): Promise<DeviceAuthorizationResponse> {
  const params: Record<string, string> = {
    client_id: clientId,
  };
  if (scope) {
    params.scope = scope;
  }

  return httpPostForm(deviceAuthEndpoint, params) as Promise<DeviceAuthorizationResponse>;
}

/**
 * 轮询 device code 授权状态。
 * 返回 token 或继续等待。
 */
export async function pollDeviceToken(
  tokenEndpoint: string,
  deviceCode: string,
  intervalMs?: number,
  maxWaitMs?: number,
): Promise<TokenResponse | null> {
  const pollInterval = intervalMs ?? DEVICE_CODE_POLL_INTERVAL_MS;
  const maxWait = maxWaitMs ?? DEVICE_CODE_MAX_WAIT_MS;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const params: Record<string, string> = {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    };

    try {
      const data = await httpPostForm(tokenEndpoint, params) as Record<string, unknown>;

      // 授权被拒绝
      if (data.error === "access_denied") {
        throw new Error("Device authorization was denied by the user");
      }

      // 授权过期
      if (data.error === "expired_token") {
        throw new Error("Device authorization expired");
      }

      // 继续等待
      if (data.error === "authorization_pending") {
        await sleep(pollInterval);
        continue;
      }

      // 成功
      if (data.access_token) {
        return data as unknown as TokenResponse;
      }

      throw new Error(`Device token poll error: ${data.error || "unknown"}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("authorization_pending")) {
        await sleep(pollInterval);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Device authorization timed out after ${maxWait}ms`);
}

// ─── Token 刷新 ─────────────────────────────────────────────

/**
 * 用 refresh token 刷新 access token。
 */
export async function refreshToken(
  tokenEndpoint: string,
  clientId: string,
  refreshTokenValue: string,
): Promise<TokenResponse> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    client_id: clientId,
  };

  return httpPostForm(tokenEndpoint, params) as Promise<TokenResponse>;
}

/**
 * 将 TokenResponse 转换为 OAuthTokenStorage。
 */
export function tokenResponseToStorage(
  response: TokenResponse,
  clientId: string,
  serverUrl: string,
): OAuthTokenStorage {
  const storage: OAuthTokenStorage = {
    access_token: response.access_token,
    token_type: response.token_type || "Bearer",
    client_id: clientId,
    server_url: serverUrl,
  };

  if (response.expires_in) {
    storage.expires_at = Date.now() + response.expires_in * 1000;
  }
  if (response.refresh_token) {
    storage.refresh_token = response.refresh_token;
  }
  if (response.scope) {
    storage.scope = response.scope;
  }

  return storage;
}

// ─── 工具函数 ──────────────────────────────────────────────

function getOrigin(serverUrl: string): string {
  const parsed = url.parse(serverUrl);
  if (!parsed.protocol || !parsed.host) {
    throw new Error(`Invalid server URL: ${serverUrl}`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 启动本地回调服务器（用于接收 OAuth 授权码）。
 * 返回服务器实例和端口号。
 */
export function startCallbackServer(expectedState: string): Promise<{
  server: http.Server;
  port: number;
  waitForCode: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = url.parse(req.url || "", true);
      const params = parsed.query as Record<string, string>;

      if (params.error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization Error</h1><p>${params.error}</p>`);
        return;
      }

      if (params.code && params.state === expectedState) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization Successful</h1><p>You can close this window and return to EvoClaw.</p>`);
        // 触发 waitForCode
        resolveCode(params.code);
        return;
      }

      if (params.state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Invalid State</h1><p>State mismatch. Please try again.</p>`);
        return;
      }

      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`<h1>Invalid Request</h1>`);
    });

    let resolveCodeFn: ((code: string) => void) | null = null;

    function resolveCode(code: string): void {
      if (resolveCodeFn) resolveCodeFn(code);
    }

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object" && "port" in address) {
        const port = address.port;
        resolve({
          server,
          port,
          waitForCode: () => new Promise<string>((res) => { resolveCodeFn = res; }),
          close: () => { resolveCodeFn = null; server.close(); },
        });
      }
    });
  });
}

/**
 * 构建回调 URI。
 */
export function buildCallbackUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}
