/** Shared HTTP client for CLI-to-Gateway API calls. */
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

function loadVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../../../../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.version) return pkg.version;
    }
  } catch {}
  return "0.0.0-unknown";
}
export const VERSION = loadVersion();
/** OpenClaw-compatible version for WeChat plugin compatibility */
export const OPENCLAW_COMPAT_VERSION = "2026.3.22";

/** .env 查找顺序：当前工作目录 → 仓库根（与 CLI dist 布局对齐）。延迟计算以支持 cwd 变化。 */
function envPaths(): string[] {
  return [
    path.join(process.cwd(), ".env"),
    path.join(__dirname, "..", "..", "..", "..", ".env"),
  ];
}

/** 从 .env 读取单个键（不修改 process.env，避免影响调用方） */
function readEnvValue(key: string): string | undefined {
  for (const p of envPaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, "utf-8");
      // 值可能被引号包裹；只取第一个非空定义
      const match = content.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, "m"));
      if (!match) continue;
      const value = match[1].trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    } catch { /* ignore */ }
  }
  return undefined;
}

/** Auto-detect port: try .env file, then probe common ports */
export function detectPort(): number {
  // 1. From environment variable
  const envPort = process.env.EvoClaw_PORT;
  if (envPort) {
    const p = parseInt(envPort, 10);
    if (Number.isFinite(p) && p > 0 && p < 65536) return p;
  }

  // 2. From .env file in CWD or project root
  const fromFile = readEnvValue("EvoClaw_PORT");
  if (fromFile) {
    const p = parseInt(fromFile, 10);
    if (Number.isFinite(p) && p > 0 && p < 65536) return p;
  }

  // 3. Default
  return 27788;
}

/**
 * CLI 调用需要鉴权的 /api 端点时使用的 WebUI 令牌。
 *
 * Gateway 的 AuthProvider 接受 `web_ui_token` cookie（见 auth-provider.ts），
 * 而 CLI 的 apiRequest 此前完全不带认证，导致所有非公开 /api 调用 401。
 * 来源：显式环境变量 WEB_UI_TOKEN / EVOCLAW_WEB_UI_TOKEN → .env。
 * 只在本机回环发送，且绝不把令牌写入日志或输出。
 */
export function getWebUiToken(): string | undefined {
  const explicit = process.env.EVOCLAW_WEB_UI_TOKEN?.trim() || process.env.WEB_UI_TOKEN?.trim();
  return explicit || readEnvValue("WEB_UI_TOKEN");
}

/** 401/403 时给用户的可读提示（不泄露令牌值） */
export function authFailureHint(status: number): string | null {
  if (status !== 401 && status !== 403) return null;
  return "未授权：请设置 WEB_UI_TOKEN 环境变量或在 .env 中配置（CLI 自动读取），" +
    "或用 --token 传入有效令牌；Gateway 需使用同一令牌启动。";
}

export const DEFAULT_PORT = detectPort();
export const DEV_PORT = 19001;

let port = DEFAULT_PORT;

export function setPort(p: number): void { port = p; }
export function getPort(): number { return port; }

export interface ApiResponse<T = unknown> {
  status: number;
  data: T;
}

export function apiRequest<T = unknown>(
  method: string,
  endpoint: string,
  body?: unknown,
  options?: { token?: string },
): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `http://localhost:${port}`);
    const payload = body ? JSON.stringify(body) : undefined;
    // 显式 --token > 环境/.env 自动读取；无令牌时保持旧行为（公开端点仍可用）
    const token = (options?.token?.trim() || getWebUiToken() || "").trim();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) headers.Cookie = `web_ui_token=${encodeURIComponent(token)}`;
    const req = http.request(
      url.toString(),
      {
        method,
        headers,
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(data) as T });
          } catch {
            resolve({ status: res.statusCode || 0, data: { raw: data } as unknown as T });
          }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.on("error", (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 向指定端口发送 /health 探测，不修改全局 port */
function probeHealth(targetPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      `http://localhost:${targetPort}/health`,
      { method: "GET", timeout: 5000 },
      (res) => { resolve(res.statusCode === 200); }
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Check if the EvoClaw Gateway server is reachable. */
export async function checkServer(): Promise<boolean> {
  try {
    const r = await apiRequest("GET", "/health");
    return r.status === 200;
  } catch {
    // 当前端口不可达，探测其他常用端口（使用独立请求，不修改全局 port）
  }

  const portsToTry = [27788, 3000, 8080].filter((p) => p !== port);
  for (const p of portsToTry) {
    if (await probeHealth(p)) {
      // 已知限制：找到可用端口后仍会更新全局 port，因为后续 apiRequest 调用依赖正确的端口。
      // 理想方案应通过返回值告知调用方由其决定，但现有调用方均依赖此副作用。
      setPort(p);
      return true;
    }
  }
  return false;
}

/** Print server offline message. */
export function serverRequired(): void {
  const { c } = require("./colors");
  process.stdout.write(
    c("red", "❌ Server not running. Start with:\n") +
    c("gray", "  node apps/server/dist/index.js\n") +
    c("gray", "  EvoClaw gateway start\n")
  );
}