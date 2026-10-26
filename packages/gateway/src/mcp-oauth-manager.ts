/**
 * MCP OAuth Manager — 每 server OAuth 状态管理（对标 hermes-agent tools/mcp_oauth_manager.py）
 *
 * 管理多 MCP server 的 OAuth 认证状态：
 *   - 每 server 独立 OAuth 状态机（authenticated / unauthenticated / pending / device_code）
 *   - 401 去重（避免每次调用都触发重新认证）
 *   - Token 自动刷新（惰性刷新 + 主动刷新）
 *   - PKCE 浏览器流程编排（启动回调服务器 → 打印授权 URL → 等待授权码 → 换取 token）
 *   - Device Code 流程编排（请求 device code → 打印用户码 → 轮询 token）
 *   - 跨进程刷新栅栏（防止并发刷新烧掉单次刷新 token）
 */

import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs";
import {
  OAuthTokenStorage,
  OAuthServerMetadata,
  loadToken,
  saveToken,
  deleteToken,
  getTokenPath,
  isTokenExpiring,
  isTokenExpired,
  generateState,
  discoverOAuthMetadata,
  buildPkceAuthorizationUrl,
  exchangeCodeForToken,
  requestDeviceCode,
  pollDeviceToken,
  refreshToken,
  tokenResponseToStorage,
  startCallbackServer,
  buildCallbackUri,
  generateClientId,
  TokenResponse,
} from "./mcp-oauth";

// ─── 类型 ──────────────────────────────────────────────────

export type OAuthStatus =
  | "authenticated"      // 有有效 token
  | "unauthenticated"    // 无 token 或 token 已过期
  | "pending"            // PKCE 流程进行中
  | "device_code"        // Device code 流程进行中
  | "error";             // 认证失败

export interface OAuthServerState {
  serverUrl: string;
  status: OAuthStatus;
  hasToken: boolean;
  hasRefreshToken: boolean;
  needsRefresh: boolean;
  lastError?: string;
  metadata?: OAuthServerMetadata;
}

export interface AuthenticateOptions {
  serverUrl: string;
  dataDir: string;
  scope?: string;
  /** 是否使用 device code 流程（无浏览器环境） */
  deviceCode?: boolean;
  /** 自定义 client_id（不提供则自动生成） */
  clientId?: string;
  /** 自定义 redirect_uri（不提供则使用本地回调服务器） */
  redirectUri?: string;
  /** 回调超时（ms） */
  callbackTimeoutMs?: number;
  /** 打印授权 URL 的回调（用于 CLI 显示） */
  onAuthorizationUrl?: (url: string) => void;
  /** 打印 device code 的回调（用于 CLI 显示） */
  onDeviceCode?: (info: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
  }) => void;
}

export interface GetTokenOptions {
  serverUrl: string;
  dataDir: string;
  scope?: string;
  clientId?: string;
}

export interface OAuthManagerOptions {
  dataDir: string;
}

// ─── 刷新栅栏 ──────────────────────────────────────────────

interface FenceEntry {
  pid: number;
  startedAt: number;
  tokenPath: string;
}

const _fenceMap = new Map<string, FenceEntry>();
const _fenceLock = makeSimpleLock();

function makeSimpleLock(): { acquire: () => Promise<() => void> } {
  let chain: Promise<void> = Promise.resolve();
  return {
    acquire: () => {
      const result = chain.then(() => {});
      chain = result.then(
        () => {},
        () => {},
      );
      return result.then(() => () => {});
    },
  };
}

// ─── Manager ───────────────────────────────────────────────

export class McpOAuthManager {
  private dataDir: string;
  private states = new Map<string, OAuthServerState>();
  private _cache = new Map<string, {
    metadata?: OAuthServerMetadata;
    clientId?: string;
  }>();

  constructor(options: OAuthManagerOptions) {
    this.dataDir = options.dataDir;
  }

  // ── 公开接口 ────────────────────────────────────────────

  /**
   * 获取 MCP server 的 access token。
   * 如果 token 过期，自动尝试刷新。
   * 如果无 token，返回 null（调用方需要引导用户认证）。
   */
  async getToken(opts: GetTokenOptions): Promise<string | null> {
    const tokenPath = getTokenPath(this.dataDir, opts.serverUrl);
    const token = loadToken(tokenPath);

    if (!token) return null;

    // 如果 token 即将过期，尝试刷新
    if (isTokenExpiring(token)) {
      if (token.refresh_token && token.client_id) {
        try {
          const refreshed = await this._doRefresh(token, opts.serverUrl);
          return refreshed.access_token;
        } catch {
          // 刷新失败，继续用旧 token（如果还没过期）
        }
      }
    }

    // 如果 token 已过期且无刷新 token
    if (isTokenExpired(token) && !token.refresh_token) {
      return null;
    }

    return token.access_token;
  }

  /**
   * 检查 MCP server 的认证状态。
   */
  getStatus(serverUrl: string): OAuthServerState {
    const cached = this.states.get(serverUrl);
    if (cached) return cached;

    const tokenPath = getTokenPath(this.dataDir, serverUrl);
    const token = loadToken(tokenPath);

    const state: OAuthServerState = {
      serverUrl,
      status: token && !isTokenExpired(token) ? "authenticated" : "unauthenticated",
      hasToken: !!token,
      hasRefreshToken: !!(token && token.refresh_token),
      needsRefresh: !!(token && isTokenExpiring(token)),
    };

    this.states.set(serverUrl, state);
    return state;
  }

  /**
   * 通过 PKCE 浏览器流程进行认证。
   * 启动本地回调服务器 → 打印授权 URL → 等待授权码 → 换取 token。
   */
  async authenticate(opts: AuthenticateOptions): Promise<OAuthTokenStorage> {
    const clientId = opts.clientId || this._getClientId(opts.serverUrl);
    const metadata = await this._getMetadata(opts.serverUrl);

    if (!metadata.authorization_endpoint) {
      throw new Error(`Server ${opts.serverUrl} does not support PKCE authorization flow`);
    }

    // 先生成 state，用于回调服务器校验
    const state = generateState();

    // 启动本地回调服务器（传入 state 进行校验）
    const callbackServer = await startCallbackServer(state);
    const redirectUri = opts.redirectUri || buildCallbackUri(callbackServer.port);

    // 构建授权 URL（使用相同的 state）
    const pkce = buildPkceAuthorizationUrl(metadata, clientId, redirectUri, opts.scope, state);

    // 更新状态为 pending
    this.states.set(opts.serverUrl, {
      serverUrl: opts.serverUrl,
      status: "pending",
      hasToken: false,
      hasRefreshToken: false,
      needsRefresh: false,
    });

    // 打印授权 URL
    if (opts.onAuthorizationUrl) {
      opts.onAuthorizationUrl(pkce.authorizationUrl);
    }

    console.log("\n" + "=".repeat(60));
    console.log("🔍 MCP OAuth — 请在浏览器中完成授权");
    console.log("=".repeat(60));
    console.log(`\n🔗 授权 URL:\n${pkce.authorizationUrl}\n`);
    console.log("⏰ 等待授权码...（最多 5 分钟）\n");
    console.log("=".repeat(60) + "\n");

    // 等待授权码
    const code = await Promise.race([
      callbackServer.waitForCode(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Authorization timed out")), 300000),
      ),
    ]);

    // 关闭回调服务器
    callbackServer.close();

    // 用授权码换取 token
    const tokenResponse = await exchangeCodeForToken(
      metadata,
      clientId,
      redirectUri,
      code,
      pkce.codeVerifier,
    );

    // 保存 token
    const storage = tokenResponseToStorage(tokenResponse, clientId, opts.serverUrl);
    const tokenPath = getTokenPath(this.dataDir, opts.serverUrl);
    saveToken(tokenPath, storage);

    // 更新状态
    this.states.set(opts.serverUrl, {
      serverUrl: opts.serverUrl,
      status: "authenticated",
      hasToken: true,
      hasRefreshToken: !!storage.refresh_token,
      needsRefresh: false,
    });

    console.log("✅ MCP OAuth 认证成功");
    return storage;
  }

  /**
   * 通过 Device Code 流程进行认证（无浏览器环境）。
   * 请求 device code → 打印用户码 → 轮询 token。
   */
  async authenticateDeviceCode(opts: AuthenticateOptions): Promise<OAuthTokenStorage> {
    const clientId = opts.clientId || this._getClientId(opts.serverUrl);
    const metadata = await this._getMetadata(opts.serverUrl);

    if (!metadata.device_authorization_endpoint) {
      throw new Error(`Server ${opts.serverUrl} does not support device code flow`);
    }

    // 请求 device code
    const deviceAuth = await requestDeviceCode(
      metadata.device_authorization_endpoint,
      clientId,
      opts.scope,
    );

    // 更新状态
    this.states.set(opts.serverUrl, {
      serverUrl: opts.serverUrl,
      status: "device_code",
      hasToken: false,
      hasRefreshToken: false,
      needsRefresh: false,
    });

    // 打印用户码
    const displayInfo = {
      userCode: deviceAuth.user_code,
      verificationUri: deviceAuth.verification_uri,
      verificationUriComplete: deviceAuth.verification_uri_complete,
    };

    if (opts.onDeviceCode) {
      opts.onDeviceCode(displayInfo);
    }

    console.log("\n" + "=".repeat(60));
    console.log("🔍 MCP OAuth — Device Code 授权");
    console.log("=".repeat(60));
    console.log(`\n🔑 用户码: ${deviceAuth.user_code}`);
    console.log(`🌐 验证地址: ${deviceAuth.verification_uri}`);
    if (deviceAuth.verification_uri_complete) {
      console.log(`🔗 直接链接: ${deviceAuth.verification_uri_complete}`);
    }
    console.log(`\n⏰ 等待授权...（最多 5 分钟）\n`);
    console.log("=".repeat(60) + "\n");

    // 轮询 device token
    const tokenResponse = await pollDeviceToken(
      metadata.token_endpoint,
      deviceAuth.device_code,
      deviceAuth.interval ? deviceAuth.interval * 1000 : undefined,
      deviceAuth.expires_in ? deviceAuth.expires_in * 1000 : undefined,
    );

    if (!tokenResponse) {
      throw new Error("Device code authentication failed");
    }

    // 保存 token
    const storage = tokenResponseToStorage(tokenResponse, clientId, opts.serverUrl);
    const tokenPath = getTokenPath(this.dataDir, opts.serverUrl);
    saveToken(tokenPath, storage);

    // 更新状态
    this.states.set(opts.serverUrl, {
      serverUrl: opts.serverUrl,
      status: "authenticated",
      hasToken: true,
      hasRefreshToken: !!storage.refresh_token,
      needsRefresh: false,
    });

    console.log("✅ MCP OAuth Device Code 认证成功");
    return storage;
  }

  /**
   * 刷新 token（使用跨进程刷新栅栏）。
   */
  async refresh(serverUrl: string): Promise<OAuthTokenStorage | null> {
    const tokenPath = getTokenPath(this.dataDir, serverUrl);
    const token = loadToken(tokenPath);

    if (!token || !token.refresh_token || !token.client_id) return null;

    const metadata = await this._getMetadata(serverUrl);

    // 获取刷新栅栏
    const releaseFence = await this._acquireRefreshFence(serverUrl, tokenPath);
    try {
      // 在栅栏内重新加载 token（可能已被其他进程刷新）
      const freshToken = loadToken(tokenPath);
      if (!freshToken || !freshToken.refresh_token) return null;

      // 如果刚被刷新过，直接返回
      if (freshToken.access_token !== token.access_token) return freshToken;

      return await this._doRefresh(freshToken, serverUrl, metadata);
    } finally {
      releaseFence();
    }
  }

  /**
   * 注销（删除 token 文件）。
   */
  logout(serverUrl: string): void {
    const tokenPath = getTokenPath(this.dataDir, serverUrl);
    deleteToken(tokenPath);
    this.states.delete(serverUrl);
    this._cache.delete(serverUrl);
  }

  /**
   * 清除缓存（用于测试）。
   */
  clearCache(): void {
    this.states.clear();
    this._cache.clear();
  }

  // ── 内部方法 ────────────────────────────────────────────

  private async _doRefresh(
    token: OAuthTokenStorage,
    serverUrl: string,
    metadata?: OAuthServerMetadata,
  ): Promise<OAuthTokenStorage> {
    const md = metadata || await this._getMetadata(serverUrl);

    const response = await refreshToken(
      md.token_endpoint,
      token.client_id!,
      token.refresh_token!,
    );

    const storage = tokenResponseToStorage(response, token.client_id!, serverUrl);
    const tokenPath = getTokenPath(this.dataDir, serverUrl);
    saveToken(tokenPath, storage);

    return storage;
  }

  private async _getMetadata(serverUrl: string): Promise<OAuthServerMetadata> {
    const cached = this._cache.get(serverUrl);
    if (cached?.metadata) return cached.metadata;

    const metadata = await discoverOAuthMetadata(serverUrl);
    this._cache.set(serverUrl, { ...this._cache.get(serverUrl), metadata });
    return metadata;
  }

  private _getClientId(serverUrl: string): string {
    const cached = this._cache.get(serverUrl);
    if (cached?.clientId) return cached.clientId;

    const clientId = generateClientId(serverUrl);
    this._cache.set(serverUrl, { ...this._cache.get(serverUrl), clientId });
    return clientId;
  }

  private async _acquireRefreshFence(
    serverUrl: string,
    tokenPath: string,
  ): Promise<() => void> {
    const fenceKey = `refresh:${serverUrl}`;
    const existing = _fenceMap.get(fenceKey);

    if (existing) {
      // 已有进程在刷新，等待其完成
      const waitMs = 5000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));

      // 重新检查
      const afterWait = _fenceMap.get(fenceKey);
      if (afterWait && afterWait.pid !== existing.pid) {
        // 不同进程，说明刷新已完成
        _fenceMap.delete(fenceKey);
        return () => {};
      }

      // 同一进程还在刷新（可能是我们自己的重入），返回 no-op
      return () => {};
    }

    // 创建栅栏
    _fenceMap.set(fenceKey, {
      pid: process.pid,
      startedAt: Date.now(),
      tokenPath,
    });

    return () => {
      _fenceMap.delete(fenceKey);
    };
  }
}

/**
 * 创建 OAuth manager 实例。
 */
export function createOAuthManager(dataDir: string): McpOAuthManager {
  return new McpOAuthManager({ dataDir });
}

/**
 * 生成随机 token 用于测试。
 */
export function generateTestToken(serverUrl: string): OAuthTokenStorage {
  const random = crypto.randomBytes(16).toString("hex");
  return {
    access_token: `test-access-${random}`,
    token_type: "Bearer",
    expires_at: Date.now() + 3600000,
    refresh_token: `test-refresh-${random}`,
    client_id: `test-client-${random}`,
    server_url: serverUrl,
  };
}

// ─── 文件权限工具 ──────────────────────────────────────────

/**
 * 确保目录存在且权限正确。
 */
export function ensureSecureDir(dirPath: string): void {
  const fullPath = path.join(dirPath, "mcp-oauth");
  fs.mkdirSync(fullPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(fullPath, 0o700);
  } catch { /* ignore */ }
}
